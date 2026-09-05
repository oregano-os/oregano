import { neon } from "@neondatabase/serverless";
import type { CompanyOSArtifact } from "../companyos-builder/types.ts";
import type { WorkflowAssignment, WorkflowExecutionStore, WorkflowRun, WorkflowRunIdentity } from "../state-store/workflow-engine.ts";
import { sha256 } from "../runtime/canonical.ts";
import { assertWorkflowArtifact } from "../runtime/workflow-engine/guard.ts";
import { validateWorkflowAssignment, validateWorkflowCreation, validateWorkflowLease, validateWorkflowState, workflowAssignmentKey, workflowInstant } from "../runtime/workflow-engine/state-validation.ts";
import { postgresTimestampToIso } from "./postgres-values.ts";
import { ensureWorkflowExecutionSchema } from "./workflow-migrate.ts";

const connection = () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for workflow persistence");
  return neon(url);
};
const json = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;
const runRow = (row: Record<string, any>): WorkflowRun => ({
  ...json<WorkflowRunIdentity>(row.identity_json), revision: Number(row.revision), state: json(row.state_json), updatedAt: postgresTimestampToIso(row.updated_at),
  ...(row.lease_token ? { lease: { token: String(row.lease_token), owner: String(row.lease_owner), expiresAt: postgresTimestampToIso(row.lease_expires_at) } } : {}),
});

/** Every state transition, associated event and delivered assignment is one SQL transaction boundary. */
export function createPostgresWorkflowExecutionStore(): WorkflowExecutionStore {
  const store: WorkflowExecutionStore = {
    async putArtifact(artifact) {
      assertWorkflowArtifact(artifact);
      await ensureWorkflowExecutionSchema();
      await connection()`insert into companyos.workflow_artifacts(artifact_hash, instance_id, artifact_json)
        values (${artifact.artifactHash}, ${artifact.instance.id}, ${JSON.stringify(artifact)}::jsonb)
        on conflict (artifact_hash) do nothing`;
    },
    async getArtifact(hash) {
      await ensureWorkflowExecutionSchema();
      const rows = await connection()`select artifact_json from companyos.workflow_artifacts where artifact_hash = ${hash}`;
      if (!rows[0]) return undefined;
      const artifact = json<CompanyOSArtifact>(rows[0].artifact_json);
      assertWorkflowArtifact(artifact);
      if (artifact.artifactHash !== hash) throw new Error("Historical workflow Artifact hash differs from its storage identity");
      return artifact;
    },
    async create(args) {
      const artifact = await store.getArtifact(args.identity.artifactHash);
      if (!artifact) throw new Error("Workflow historical Artifact is unavailable");
      validateWorkflowCreation(args.identity, args.state, args.meta, artifact);
      const { identity: id, meta } = args;
      const rows = await connection()`with metadata as (
          insert into companyos.workflow_runs(run_id, workflow, workflow_version, company_commit,
            company_snapshot_hash, agent_definition_hash, agent_adapter, adapter_version, status, started_at)
          values (${id.runId}, ${meta.workflow}, ${meta.workflowVersion}, ${meta.companyCommit},
            ${meta.companySnapshotHash}, ${meta.agentDefinitionHash}, ${meta.agentAdapter}, ${meta.adapterVersion ?? null},
            ${args.state.status}, ${id.createdAt})
          on conflict (run_id) do nothing returning run_id
        ), eligible as (
          select run_id from metadata union all
          select run_id from companyos.workflow_runs where run_id = ${id.runId}
            and workflow = ${meta.workflow} and workflow_version = ${meta.workflowVersion}
            and company_commit = ${meta.companyCommit} and company_snapshot_hash = ${meta.companySnapshotHash}
            and agent_definition_hash = ${meta.agentDefinitionHash}
        ), created as (
          insert into companyos.workflow_executions(run_id, instance_id, workflow_id, artifact_hash, manifest_hash,
            origin_key, origin_digest, identity_json, state_json, updated_at)
          select ${id.runId}, ${id.instanceId}, ${id.workflowId}, ${id.artifactHash}, ${id.manifestHash},
            ${id.originKey}, ${id.originDigest}, ${JSON.stringify(id)}::jsonb, ${JSON.stringify(args.state)}::jsonb, ${id.createdAt}
          from eligible limit 1 on conflict do nothing returning *
        ), evidence as (
          insert into companyos.events(run_id, step_id, actor, subject_principal, event, status, payload)
          select run_id, ${args.state.cursor}, 'agent', ${id.subjectPrincipal}, 'workflow.opened', 'succeeded',
            ${JSON.stringify({ artifact_hash: id.artifactHash, manifest_hash: id.manifestHash, origin_digest: id.originDigest })}::jsonb from created
        ) select * from created`;
      if (rows[0]) return runRow(rows[0]);
      const existing = await store.findOrigin(id.instanceId, id.workflowId, id.originKey);
      if (!existing || existing.originDigest !== id.originDigest || existing.runId !== id.runId) throw new Error("Workflow opening identity conflicts with changed input or control metadata");
      return existing;
    },
    async read(instanceId, runId) {
      await ensureWorkflowExecutionSchema();
      const rows = await connection()`select * from companyos.workflow_executions where instance_id = ${instanceId} and run_id = ${runId}`;
      return rows[0] && runRow(rows[0]);
    },
    async findOrigin(instanceId, workflowId, originKey) {
      await ensureWorkflowExecutionSchema();
      const rows = await connection()`select * from companyos.workflow_executions
        where instance_id = ${instanceId} and workflow_id = ${workflowId} and origin_key = ${originKey}`;
      return rows[0] && runRow(rows[0]);
    },
    async list(args) {
      if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200) throw new Error("Workflow listing limit must be from 1 to 200");
      await ensureWorkflowExecutionSchema();
      const rows = await connection()`select * from companyos.workflow_executions
        where instance_id = ${args.instanceId} and (${args.status ?? null}::text is null or state_json->>'status' = ${args.status ?? null})
        order by updated_at, run_id limit ${args.limit}`;
      return rows.map(runRow);
    },
    async claim(args) {
      validateWorkflowLease(args);
      await ensureWorkflowExecutionSchema();
      const rows = await connection()`update companyos.workflow_executions
        set lease_owner = ${args.owner}, lease_token = ${args.token}, lease_expires_at = ${args.expiresAt}
        where instance_id = ${args.instanceId} and run_id = ${args.runId}
          and state_json->>'status' in ('running', 'waiting')
          and (lease_token is null or lease_expires_at <= ${args.now}) returning *`;
      return rows[0] && runRow(rows[0]);
    },
    async commit(args) {
      workflowInstant(args.now);
      const previous = await store.read(args.instanceId, args.runId);
      if (!previous || previous.revision !== args.expectedRevision || previous.lease?.token !== args.leaseToken || previous.lease.expiresAt <= args.now || !["running", "waiting"].includes(previous.state.status)) return undefined;
      const artifact = await store.getArtifact(previous.artifactHash);
      if (!artifact) throw new Error("Workflow historical Artifact is unavailable");
      validateWorkflowState(args.state, previous.workflowId, artifact, previous.state);
      for (const assignment of args.assignments ?? []) validateWorkflowAssignment(assignment, previous, artifact, args.now);
      const rows = await connection()`with advanced as (
          update companyos.workflow_executions set state_json = ${JSON.stringify(args.state)}::jsonb,
            revision = revision + 1, lease_owner = null, lease_token = null, lease_expires_at = null, updated_at = ${args.now}
          where instance_id = ${args.instanceId} and run_id = ${args.runId} and revision = ${args.expectedRevision}
            and lease_token = ${args.leaseToken} and lease_expires_at > greatest(${args.now}::timestamptz, clock_timestamp())
            and state_json->>'status' in ('running','waiting') returning *
        ), metadata as (
          update companyos.workflow_runs set status = ${args.state.status}
          where run_id in (select run_id from advanced)
        ), assignments as (
          insert into companyos.workflow_thread_assignments(instance_id, assignment_key, run_id, assignment_json, expires_at)
          select advanced.instance_id, entry->>'assignmentKey', advanced.run_id, entry, (entry->>'expiresAt')::timestamptz
          from advanced cross join jsonb_array_elements(${JSON.stringify(args.assignments ?? [])}::jsonb) entry
          -- A conflicting binding deliberately violates NOT NULL, rolling back
          -- the entire state/event/assignment transition instead of losing a bind.
          on conflict (instance_id, assignment_key) do update
            set run_id = case when companyos.workflow_thread_assignments.assignment_json = excluded.assignment_json
              then companyos.workflow_thread_assignments.run_id else null end
          returning assignment_key
        ), evidence as (
          insert into companyos.events(run_id, step_id, actor, subject_principal, event, status, evidence, payload)
          select run_id, ${args.event.stepId}, 'agent', ${args.event.principal ?? null}, ${args.event.name}, 'succeeded',
            ${JSON.stringify(args.event.evidence ?? null)}::jsonb,
            jsonb_build_object('revision', revision, 'state_digest', ${sha256(args.state)}::text,
              'artifact_hash', artifact_hash, 'manifest_hash', manifest_hash) from advanced
        ) select * from advanced`;
      return rows[0] && runRow(rows[0]);
    },
    async cancel(args) {
      workflowInstant(args.now);
      await ensureWorkflowExecutionSchema();
      const rows = await connection()`with cancelled as (
          update companyos.workflow_executions
          set state_json = jsonb_set(state_json - 'wait', '{status}', '"cancelled"'::jsonb), revision = revision + 1,
            lease_owner = null, lease_token = null, lease_expires_at = null, updated_at = ${args.now}
          where instance_id = ${args.instanceId} and run_id = ${args.runId}
            and state_json->>'status' in ('running','waiting') returning *
        ), metadata as (
          update companyos.workflow_runs set status = 'cancelled' where run_id in (select run_id from cancelled)
        ), evidence as (
          insert into companyos.events(run_id, step_id, actor, subject_principal, event, status, payload)
          select run_id, coalesce(state_json->>'cursor', 'end'), 'human:operator', ${args.principal}, 'workflow.cancelled',
            'succeeded', jsonb_build_object('revision', revision) from cancelled
        ) select run_id from cancelled`;
      return rows.length === 1;
    },
    async assignment(args) {
      workflowInstant(args.now);
      await ensureWorkflowExecutionSchema();
      const rows = await connection()`select assignment_json from companyos.workflow_thread_assignments assigned
        join companyos.workflow_executions runs on assigned.run_id = runs.run_id and assigned.instance_id = runs.instance_id
        where assigned.instance_id = ${args.instanceId} and assignment_key = ${workflowAssignmentKey(args.instanceId, args.conversation)}
          and assigned.expires_at > ${args.now} and runs.state_json->>'status' in ('running','waiting')
          and (not (assignment_json ? 'subjectPrincipal') or assignment_json->>'subjectPrincipal' = ${args.conversation.subjectPrincipal ?? null})`;
      return rows[0] && json<WorkflowAssignment>(rows[0].assignment_json);
    },
  };
  return store;
}
