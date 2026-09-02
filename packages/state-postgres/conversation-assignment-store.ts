import { neon } from "@neondatabase/serverless";
import type {
  ConversationAssignment,
  ConversationAssignmentKey,
  ConversationAssignmentStore,
  ConversationAssignmentTransition,
  ConversationAssignmentTransitionResult,
} from "../state-store/conversation-assignments.ts";
import { ensureCompanyOSSchema } from "./migrate.ts";
import { postgresTimestampToIso } from "./postgres-values.ts";

function sql() {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is not set — Conversation Assignments use the Company Instance StateStore.");
  return neon(value);
}

function assignment(row: Record<string, any> | undefined): ConversationAssignment | undefined {
  if (!row) return undefined;
  return {
    instanceId: String(row.instance_id),
    surface: String(row.surface),
    accountId: String(row.account_id),
    channelId: String(row.channel_id),
    subjectPrincipal: String(row.subject_principal),
    assignmentId: String(row.assignment_id),
    fromAgentId: String(row.from_agent_id),
    agentId: String(row.agent_id),
    ruleId: String(row.rule_id),
    purpose: String(row.purpose),
    artifactHash: String(row.artifact_hash),
    assignedAt: postgresTimestampToIso(row.assigned_at),
    expiresAt: postgresTimestampToIso(row.expires_at),
  };
}

function jsonAssignment(value: unknown): ConversationAssignment | undefined {
  if (!value) return undefined;
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return parsed as ConversationAssignment;
}

export function createPostgresConversationAssignmentStore(): ConversationAssignmentStore {
  return {
    async getActive(key: ConversationAssignmentKey, now: string): Promise<ConversationAssignment | undefined> {
      await ensureCompanyOSSchema();
      const rows = await sql()`select * from companyos.conversation_assignments
        where instance_id = ${key.instanceId}
          and surface = ${key.surface}
          and account_id = ${key.accountId}
          and channel_id = ${key.channelId}
          and subject_principal = ${key.subjectPrincipal}
          and expires_at > ${now}`;
      return assignment(rows[0]);
    },

    async applyTransition(transition: ConversationAssignmentTransition): Promise<ConversationAssignmentTransitionResult> {
      await ensureCompanyOSSchema();
      return transition.nextAssignment
        ? await applyAssignment(transition)
        : await clearAssignment(transition);
    },
  };
}

async function applyAssignment(transition: ConversationAssignmentTransition): Promise<ConversationAssignmentTransitionResult> {
  const next = transition.nextAssignment!;
  const rows = await sql()`with prior as (
      select result_assignment from companyos.conversation_assignment_transitions
      where instance_id = ${transition.key.instanceId} and transition_key = ${transition.transitionKey}
    ), eligible as (
      select 1 where not exists (select 1 from prior) and (
        (${transition.expectedAssignmentId ?? null}::text is null and not exists (
          select 1 from companyos.conversation_assignments where
            instance_id = ${transition.key.instanceId} and surface = ${transition.key.surface}
            and account_id = ${transition.key.accountId} and channel_id = ${transition.key.channelId}
            and subject_principal = ${transition.key.subjectPrincipal}
            and expires_at > ${transition.occurredAt}
        )) or exists (
          select 1 from companyos.conversation_assignments where
            instance_id = ${transition.key.instanceId} and surface = ${transition.key.surface}
            and account_id = ${transition.key.accountId} and channel_id = ${transition.key.channelId}
            and subject_principal = ${transition.key.subjectPrincipal}
            and assignment_id = ${transition.expectedAssignmentId ?? null}
        )
      )
    ), applied as (
      insert into companyos.conversation_assignments
        (instance_id, surface, account_id, channel_id, subject_principal,
         assignment_id, from_agent_id, agent_id, rule_id, purpose, artifact_hash,
         assigned_at, expires_at, updated_at)
      select ${next.instanceId}, ${next.surface}, ${next.accountId}, ${next.channelId},
        ${next.subjectPrincipal}, ${next.assignmentId}, ${next.fromAgentId}, ${next.agentId},
        ${next.ruleId}, ${next.purpose}, ${next.artifactHash}, ${next.assignedAt}, ${next.expiresAt},
        ${transition.occurredAt}
      from eligible
      on conflict (instance_id, surface, account_id, channel_id, subject_principal)
      do update set assignment_id = excluded.assignment_id, from_agent_id = excluded.from_agent_id,
        agent_id = excluded.agent_id, rule_id = excluded.rule_id, purpose = excluded.purpose,
        artifact_hash = excluded.artifact_hash, assigned_at = excluded.assigned_at,
        expires_at = excluded.expires_at, updated_at = excluded.updated_at
      where companyos.conversation_assignments.assignment_id = ${transition.expectedAssignmentId ?? null}
        or (${transition.expectedAssignmentId ?? null}::text is null
          and companyos.conversation_assignments.expires_at <= ${transition.occurredAt})
      returning 1
    ), receipt as (
      insert into companyos.conversation_assignment_transitions
        (instance_id, transition_key, action, surface, account_id, channel_id,
         subject_principal, previous_assignment_id, next_assignment_id,
         initiated_by_principal, occurred_at, evidence, result_assignment)
      select ${transition.key.instanceId}, ${transition.transitionKey}, ${transition.action},
        ${transition.key.surface}, ${transition.key.accountId}, ${transition.key.channelId},
        ${transition.key.subjectPrincipal}, ${transition.expectedAssignmentId ?? null},
        ${next.assignmentId}, ${transition.initiatedByPrincipal}, ${transition.occurredAt},
        ${JSON.stringify(transition.evidence)}, ${JSON.stringify(next)}
      from applied returning result_assignment
    )
    select 'duplicate' as outcome, result_assignment from prior
    union all select 'applied' as outcome, result_assignment from receipt
    union all select 'conflict' as outcome, null::jsonb as result_assignment
      where not exists (select 1 from prior) and not exists (select 1 from receipt)
    limit 1`;
  return transitionResult(rows[0]);
}

async function clearAssignment(transition: ConversationAssignmentTransition): Promise<ConversationAssignmentTransitionResult> {
  const rows = await sql()`with prior as (
      select result_assignment from companyos.conversation_assignment_transitions
      where instance_id = ${transition.key.instanceId} and transition_key = ${transition.transitionKey}
    ), removed as (
      delete from companyos.conversation_assignments
      where instance_id = ${transition.key.instanceId} and surface = ${transition.key.surface}
        and account_id = ${transition.key.accountId} and channel_id = ${transition.key.channelId}
        and subject_principal = ${transition.key.subjectPrincipal}
        and assignment_id = ${transition.expectedAssignmentId ?? null}
        and not exists (select 1 from prior)
      returning assignment_id
    ), receipt as (
      insert into companyos.conversation_assignment_transitions
        (instance_id, transition_key, action, surface, account_id, channel_id,
         subject_principal, previous_assignment_id, next_assignment_id,
         initiated_by_principal, occurred_at, evidence, result_assignment)
      select ${transition.key.instanceId}, ${transition.transitionKey}, ${transition.action},
        ${transition.key.surface}, ${transition.key.accountId}, ${transition.key.channelId},
        ${transition.key.subjectPrincipal}, ${transition.expectedAssignmentId ?? null}, null,
        ${transition.initiatedByPrincipal}, ${transition.occurredAt},
        ${JSON.stringify(transition.evidence)}, null
      from removed returning result_assignment
    )
    select 'duplicate' as outcome, result_assignment from prior
    union all select 'applied' as outcome, result_assignment from receipt
    union all select 'conflict' as outcome, null::jsonb as result_assignment
      where not exists (select 1 from prior) and not exists (select 1 from receipt)
    limit 1`;
  return transitionResult(rows[0]);
}

function transitionResult(row: Record<string, any> | undefined): ConversationAssignmentTransitionResult {
  if (!row) return { outcome: "conflict" };
  const outcome = String(row.outcome);
  if (outcome !== "applied" && outcome !== "duplicate" && outcome !== "conflict") {
    throw new Error(`Unexpected Conversation Assignment transition outcome '${outcome}'.`);
  }
  return { outcome, assignment: jsonAssignment(row.result_assignment) };
}
