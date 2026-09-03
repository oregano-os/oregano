import { neon } from "@neondatabase/serverless";
import type { SprintDecision, SprintEvent, SprintIntent, SprintState } from "../domains/sprint/contracts.ts";
import type {
  ClaimedSprintIntent,
  SprintCommitResult,
  SprintOrchestrationKey,
  SprintOrchestrationStore,
  StoredSprintEvent,
  StoredSprintState,
} from "../state-store/sprint-orchestration.ts";
import { ensureCompanyRecordsSchema } from "./records-migrate.ts";
import { postgresTimestampToIso } from "./postgres-values.ts";

const connection = () => {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is not set — Sprint orchestration uses the existing Company Instance database.");
  return neon(value);
};

const json = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

const storedEvent = (row: Record<string, any>): StoredSprintEvent => ({
  instanceId: String(row.instance_id),
  definitionId: String(row.definition_id),
  event: json<SprintEvent>(row.event_json),
  stateVersion: Number(row.state_version),
  decision: json<SprintDecision>(row.decision_json),
  committedAt: postgresTimestampToIso(row.committed_at),
});

const claimedIntent = (row: Record<string, any>): ClaimedSprintIntent => ({
  instanceId: String(row.instance_id),
  definitionId: String(row.definition_id),
  intent: json<SprintIntent>(row.intent_json),
  leaseOwner: String(row.lease_owner),
  leaseToken: String(row.lease_token),
  leaseExpiresAt: postgresTimestampToIso(row.lease_expires_at),
  attempts: Number(row.attempts),
});

export function createPostgresSprintOrchestrationStore(): SprintOrchestrationStore {
  return {
    async getState(key: SprintOrchestrationKey): Promise<StoredSprintState | undefined> {
      await ensureCompanyRecordsSchema();
      const rows = await connection()`select * from companyos_records.sprint_states
        where instance_id = ${key.instanceId} and definition_id = ${key.definitionId} limit 1`;
      const row = rows[0];
      return row ? {
        instanceId: String(row.instance_id),
        definitionId: String(row.definition_id),
        stateVersion: Number(row.state_version),
        state: json<SprintState>(row.state_json),
        updatedAt: postgresTimestampToIso(row.updated_at),
      } : undefined;
    },

    async getEvent(key: SprintOrchestrationKey, eventId: string): Promise<StoredSprintEvent | undefined> {
      await ensureCompanyRecordsSchema();
      const rows = await connection()`select * from companyos_records.sprint_events
        where instance_id = ${key.instanceId} and definition_id = ${key.definitionId}
          and event_id = ${eventId} limit 1`;
      return rows[0] ? storedEvent(rows[0]) : undefined;
    },

    async commitEvent(args): Promise<SprintCommitResult> {
      await ensureCompanyRecordsSchema();
      const intents = JSON.stringify(args.decision.intents);
      const rows = await connection()`with new_intents as (
          select value as intent_json from jsonb_array_elements(${intents}::jsonb)
        ), candidate as (
          select 1 as available
          where not exists (
            select 1 from companyos_records.sprint_events
            where instance_id = ${args.instanceId} and definition_id = ${args.definitionId}
              and event_id = ${args.event.event_id}
          ) and not exists (
            select 1 from new_intents incoming
            join companyos_records.sprint_intents existing
              on existing.instance_id = ${args.instanceId}
             and existing.definition_id = ${args.definitionId}
             and existing.intent_id = incoming.intent_json->>'intent_id'
            where existing.intent_json <> incoming.intent_json
          )
        ), state_written as (
          insert into companyos_records.sprint_states
            (instance_id, definition_id, state_version, state_json, updated_at)
          select ${args.instanceId}, ${args.definitionId}, ${args.expectedStateVersion + 1},
            ${JSON.stringify(args.decision.state)}::jsonb, ${args.committedAt}
          from candidate
          on conflict (instance_id, definition_id) do update
            set state_version = excluded.state_version, state_json = excluded.state_json,
                updated_at = excluded.updated_at
          where companyos_records.sprint_states.state_version = ${args.expectedStateVersion}
          returning state_version
        ), event_written as (
          insert into companyos_records.sprint_events
            (instance_id, definition_id, event_id, event_type, occurred_at,
             state_version, event_json, decision_json, committed_at)
          select ${args.instanceId}, ${args.definitionId}, ${args.event.event_id}, ${args.event.type},
            ${args.event.occurred_at}, state_version, ${JSON.stringify(args.event)}::jsonb,
            ${JSON.stringify(args.decision)}::jsonb, ${args.committedAt}
          from state_written
          on conflict (instance_id, definition_id, event_id) do nothing
          returning state_version
        ), intents_written as (
          insert into companyos_records.sprint_intents
            (instance_id, definition_id, intent_id, created_by_event_id, intent_type,
             intent_json, available_at, updated_at)
          select ${args.instanceId}, ${args.definitionId}, incoming.intent_json->>'intent_id',
            ${args.event.event_id}, incoming.intent_json->>'type', incoming.intent_json,
            case when incoming.intent_json ? 'due_at'
              then (incoming.intent_json->>'due_at')::timestamptz
              else ${args.committedAt}::timestamptz end,
            ${args.committedAt}
          from event_written cross join new_intents incoming
          on conflict (instance_id, definition_id, intent_id) do nothing
          returning intent_id
        )
        select state_version, (select count(*) from intents_written) as written_intents
        from event_written`;
      if (rows.length === 1) {
        const outcome: StoredSprintEvent = {
          instanceId: args.instanceId,
          definitionId: args.definitionId,
          event: structuredClone(args.event),
          stateVersion: Number(rows[0].state_version),
          decision: structuredClone(args.decision),
          committedAt: args.committedAt,
        };
        return { status: "applied", outcome };
      }
      const existing = await this.getEvent(args, args.event.event_id);
      if (existing) return { status: "duplicate", outcome: existing };
      const conflictRows = await connection()`select existing.intent_id
        from jsonb_array_elements(${intents}::jsonb) incoming(intent_json)
        join companyos_records.sprint_intents existing
          on existing.instance_id = ${args.instanceId}
         and existing.definition_id = ${args.definitionId}
         and existing.intent_id = incoming.intent_json->>'intent_id'
        where existing.intent_json <> incoming.intent_json limit 1`;
      if (conflictRows[0]) throw new Error(`Sprint intent '${String(conflictRows[0].intent_id)}' conflicts with its existing identity`);
      return { status: "conflict" };
    },

    async claimIntents(args): Promise<ClaimedSprintIntent[]> {
      await ensureCompanyRecordsSchema();
      const rows = await connection()`with due as (
          select instance_id, definition_id, intent_id
          from companyos_records.sprint_intents
          where instance_id = ${args.instanceId} and definition_id = ${args.definitionId}
            and available_at <= ${args.now}
            and (state = 'pending' or (state = 'leased' and lease_expires_at <= ${args.now}))
          order by available_at, intent_id limit ${args.limit}
          for update skip locked
        )
        update companyos_records.sprint_intents intents
          set state = 'leased', lease_owner = ${args.owner}, lease_token = ${args.leaseToken},
              lease_expires_at = ${args.leaseExpiresAt}, attempts = attempts + 1,
              updated_at = ${args.now}
        from due
        where intents.instance_id = due.instance_id and intents.definition_id = due.definition_id
          and intents.intent_id = due.intent_id
        returning intents.*`;
      return rows.map(claimedIntent);
    },

    async completeIntent(args): Promise<boolean> {
      await ensureCompanyRecordsSchema();
      const rows = await connection()`update companyos_records.sprint_intents
        set state = 'succeeded', evidence = ${JSON.stringify(args.evidence ?? null)}::jsonb,
            completed_at = ${args.completedAt}, updated_at = ${args.completedAt}
        where instance_id = ${args.instanceId} and definition_id = ${args.definitionId}
          and intent_id = ${args.intentId} and state = 'leased' and lease_token = ${args.leaseToken}
        returning intent_id`;
      return rows.length === 1;
    },

    async retryIntent(args): Promise<boolean> {
      await ensureCompanyRecordsSchema();
      const rows = await connection()`update companyos_records.sprint_intents
        set state = 'pending', available_at = ${args.availableAt},
            evidence = ${JSON.stringify(args.evidence ?? null)}::jsonb,
            lease_owner = null, lease_token = null, lease_expires_at = null,
            completed_at = null, updated_at = ${args.retriedAt}
        where instance_id = ${args.instanceId} and definition_id = ${args.definitionId}
          and intent_id = ${args.intentId} and state = 'leased' and lease_token = ${args.leaseToken}
        returning intent_id`;
      return rows.length === 1;
    },

    async failIntent(args): Promise<boolean> {
      await ensureCompanyRecordsSchema();
      const rows = await connection()`update companyos_records.sprint_intents
        set state = 'failed', evidence = ${JSON.stringify(args.evidence ?? null)}::jsonb,
            completed_at = ${args.failedAt}, updated_at = ${args.failedAt}
        where instance_id = ${args.instanceId} and definition_id = ${args.definitionId}
          and intent_id = ${args.intentId} and state = 'leased' and lease_token = ${args.leaseToken}
        returning intent_id`;
      return rows.length === 1;
    },

    async cancelIntent(args): Promise<boolean> {
      await ensureCompanyRecordsSchema();
      const rows = await connection()`update companyos_records.sprint_intents
        set state = 'cancelled', evidence = ${JSON.stringify(args.evidence ?? null)}::jsonb,
            completed_at = ${args.cancelledAt}, updated_at = ${args.cancelledAt}
        where instance_id = ${args.instanceId} and definition_id = ${args.definitionId}
          and intent_id = ${args.intentId} and state in ('pending','leased')
        returning intent_id`;
      return rows.length === 1;
    },
  };
}
