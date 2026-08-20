// state-postgres — Neon/Postgres implementation of state-store/interface.ts
// against schema.sql (v2). claimEffect = INSERT on UNIQUE key; consumeApproval
// = UPDATE … WHERE consumed_at IS NULL. The ONE-transaction rule
// (consumeApproval + claimEffect) is implemented as a single data-modifying
// CTE statement — atomic on the Neon HTTP driver without an interactive
// transaction.

import { neon } from "@neondatabase/serverless";
import type {
  ApprovalRequestInput,
  ApprovalRequestRow,
  DecisionInput,
  EventInput,
  RunMeta,
  StateStore,
} from "../state-store/interface.js";
import { ensureCompanyOSSchema } from "./migrate.ts";

function sql() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — provision Neon and pull env.");
  return neon(url);
}

export function createPostgresStateStore(): StateStore {
  return {
    async ensureRun(meta: RunMeta): Promise<void> {
      await ensureCompanyOSSchema();
      await sql()`
        insert into companyos.workflow_runs (run_id, workflow, workflow_version,
          company_commit, company_snapshot_hash, agent_definition_hash,
          agent_adapter, adapter_version, agent_deployment)
        values (${meta.runId}, ${meta.workflow}, ${meta.workflowVersion},
          ${meta.companyCommit ?? null}, ${meta.companySnapshotHash},
          ${meta.agentDefinitionHash}, ${meta.agentAdapter},
          ${meta.adapterVersion ?? null}, ${meta.agentDeployment ?? null})
        on conflict (run_id) do nothing`;
    },

    async getRun(runId) {
      await ensureCompanyOSSchema();
      const rows = await sql()`select * from companyos.workflow_runs where run_id = ${runId}`;
      return rows[0];
    },

    async appendEvent(e: EventInput): Promise<string> {
      const rows = await sql()`
        insert into companyos.events (run_id, step_id, actor, subject_principal, event,
          status, caused_by_event_id, tool_version, idempotency_key, evidence, payload)
        values (${e.runId}, ${e.stepId}, ${e.actor}, ${e.subjectPrincipal ?? null},
          ${e.event}, ${e.status ?? null}, ${e.causedByEventId ?? null},
          ${e.toolVersion ?? null}, ${e.idempotencyKey ?? null},
          ${JSON.stringify(e.evidence ?? null)}, ${JSON.stringify(e.payload ?? null)})
        returning event_id`;
      return rows[0].event_id as string;
    },

    async listEvents(runId) {
      return await sql()`select * from companyos.events where run_id = ${runId} order by ts`;
    },

    async createApprovalRequest(r: ApprovalRequestInput): Promise<string> {
      const rows = await sql()`
        insert into companyos.approval_requests (run_id, step_id, action, input_hash, max_spend, expires_at)
        values (${r.runId}, ${r.stepId}, ${r.action}, ${r.inputHash}, ${r.maxSpend ?? null}, ${r.expiresAt ?? null})
        returning request_id`;
      return rows[0].request_id as string;
    },

    async approvalRequestExists(runId, stepId, action, inputHash): Promise<boolean> {
      const rows = await sql()`
        select 1 from companyos.approval_requests
        where run_id = ${runId} and step_id = ${stepId} and action = ${action}
          and input_hash = ${inputHash}
        limit 1`;
      return rows.length === 1;
    },

    async getLatestApprovalRequest(runId, stepId, action): Promise<ApprovalRequestRow | undefined> {
      const rows = await sql()`
        select request_id, run_id, step_id, action, input_hash, created_at
        from companyos.approval_requests
        where run_id = ${runId} and step_id = ${stepId} and action = ${action}
          and (expires_at is null or expires_at > now())
        order by created_at desc limit 1`;
      const r = rows[0];
      if (!r) return undefined;
      return {
        requestId: r.request_id as string,
        runId: r.run_id as string,
        stepId: r.step_id as string,
        action: r.action as string,
        inputHash: r.input_hash as string,
        createdAt: new Date(r.created_at as string),
      };
    },

    async recordDecision(d: DecisionInput): Promise<string> {
      const rows = await sql()`
        insert into companyos.approvals (request_id, subject_principal, role, decision)
        values (${d.requestId}, ${d.subjectPrincipal}, ${d.role}, ${d.decision})
        returning approval_id`;
      return rows[0].approval_id as string;
    },

    async consumeApprovalAndClaimEffect({ approvalId, idempotencyKey, runId, stepId, inputHash }) {
      // ONE atomic statement (closes the crash window the schema warns
      // about): claim the effect via INSERT ON CONFLICT DO NOTHING, and
      // consume the approval gated on that claim having happened — both CTEs
      // commit together or not at all. A duplicate key short-circuits both.
      // Two independent uniqueness guards can reject the claim:
      //   idempotency_key → the same action+content twice (double click)
      //   approval_id     → the same signature for OTHER content (reuse)
      // Both mean "already spent" and must return false, never throw — the
      // caller's contract is a boolean, and a raw DB error would surface as a
      // crash instead of a suppressed duplicate.
      try {
        const rows = await sql()`
          with claimed as (
            insert into companyos.effects (idempotency_key, run_id, step_id, approval_id, input_hash)
            values (${idempotencyKey}, ${runId}, ${stepId}, ${approvalId}, ${inputHash})
            on conflict (idempotency_key) do nothing
            returning idempotency_key
          ),
          consumed as (
            update companyos.approvals set consumed_at = now()
            where approval_id = ${approvalId} and consumed_at is null
              and exists (select 1 from claimed)
            returning approval_id
          )
          select (select count(*) from claimed) as claimed,
                 (select count(*) from consumed) as consumed`;
        const r = rows[0];
        return Number(r.claimed) === 1 && Number(r.consumed) === 1;
      } catch (error) {
        // 23505 = unique violation. Only the approval_id guard can land here
        // (the idempotency_key path is handled by ON CONFLICT), and it means
        // this approval already paid for a different effect: refuse, don't crash.
        if ((error as { code?: string }).code === "23505") return false;
        throw error;
      }
    },

    async claimEffect({ idempotencyKey, runId, stepId, inputHash }) {
      const rows = await sql()`
        insert into companyos.effects (idempotency_key, run_id, step_id, input_hash)
        values (${idempotencyKey}, ${runId}, ${stepId}, ${inputHash})
        on conflict (idempotency_key) do nothing
        returning idempotency_key`;
      return rows.length === 1;
    },

    async markEffectDispatched(idempotencyKey) {
      const rows = await sql()`
        update companyos.effects set status = 'dispatched', updated_at = now()
        where idempotency_key = ${idempotencyKey} and status = 'claimed'
        returning idempotency_key`;
      return rows.length === 1;
    },

    async completeEffect(idempotencyKey, evidence) {
      await sql()`
        update companyos.effects set status = 'succeeded', updated_at = now(),
          evidence = ${JSON.stringify(evidence ?? null)}
        where idempotency_key = ${idempotencyKey} and status in ('claimed','dispatched')`;
    },

    async markEffectFailed(idempotencyKey, evidence) {
      await sql()`
        update companyos.effects set status = 'failed', updated_at = now(),
          evidence = ${JSON.stringify(evidence ?? null)}
        where idempotency_key = ${idempotencyKey} and status in ('claimed','dispatched')`;
    },

    async markEffectUnknown(idempotencyKey, evidence) {
      await sql()`
        update companyos.effects set status = 'unknown', updated_at = now(),
          evidence = ${JSON.stringify(evidence ?? null)}
        where idempotency_key = ${idempotencyKey} and status in ('claimed','dispatched')`;
    },

    async getEffect(idempotencyKey) {
      const rows = await sql()`select * from companyos.effects where idempotency_key = ${idempotencyKey}`;
      return rows[0];
    },
  };
}
