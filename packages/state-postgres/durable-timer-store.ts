import { neon } from "@neondatabase/serverless";
import type { ClaimedDurableTimer, DurableTimerStore, StoredDurableTimer } from "../state-store/durable-timers.ts";
import { canonicalJson } from "../runtime/canonical.ts";
import { postgresTimestampToIso } from "./postgres-values.ts";
import { ensureCompanyRecordsSchema } from "./records-migrate.ts";

const connection = () => {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is not set — durable timers use the existing Company Instance database.");
  return neon(value);
};

const payload = (value: unknown): any => typeof value === "string" ? JSON.parse(value) : value;

/** PostgreSQL JSONB does not preserve object-key order; timer identity must. */
export const durableTimerPayloadIdentity = (value: unknown): string => canonicalJson(payload(value));

const claimedTimer = (row: Record<string, any>): ClaimedDurableTimer => ({
  instanceId: String(row.instance_id),
  timerId: String(row.timer_id),
  timerKind: String(row.timer_kind),
  dueAt: postgresTimestampToIso(row.due_at),
  idempotencyKey: String(row.idempotency_key),
  payload: payload(row.payload),
  leaseOwner: String(row.lease_owner),
  leaseToken: String(row.lease_token),
  leaseExpiresAt: postgresTimestampToIso(row.lease_expires_at),
  attempts: Number(row.attempts),
});

const storedTimer = (row: Record<string, any>): StoredDurableTimer => ({
  instanceId: String(row.instance_id),
  timerId: String(row.timer_id),
  timerKind: String(row.timer_kind),
  dueAt: postgresTimestampToIso(row.due_at),
  idempotencyKey: String(row.idempotency_key),
  payload: payload(row.payload),
  state: row.state as StoredDurableTimer["state"],
  attempts: Number(row.attempts),
  ...(row.evidence === null || row.evidence === undefined ? {} : { evidence: payload(row.evidence) }),
  ...(row.completed_at ? { completedAt: postgresTimestampToIso(row.completed_at) } : {}),
});

export function createPostgresDurableTimerStore(): DurableTimerStore {
  return {
    async schedule(timer) {
      await ensureCompanyRecordsSchema();
      const rows = await connection()`insert into companyos_records.durable_timers
        (instance_id, timer_id, timer_kind, due_at, idempotency_key, payload)
        values (${timer.instanceId}, ${timer.timerId}, ${timer.timerKind}, ${timer.dueAt},
          ${timer.idempotencyKey}, ${JSON.stringify(timer.payload)})
        on conflict (instance_id, timer_id) do nothing returning timer_id`;
      if (rows.length === 1) return true;
      const existing = (await connection()`select timer_kind, due_at, idempotency_key, payload
        from companyos_records.durable_timers
        where instance_id = ${timer.instanceId} and timer_id = ${timer.timerId} limit 1`)[0];
      if (!existing || String(existing.timer_kind) !== timer.timerKind || postgresTimestampToIso(existing.due_at) !== timer.dueAt ||
        String(existing.idempotency_key) !== timer.idempotencyKey
        || durableTimerPayloadIdentity(existing.payload) !== durableTimerPayloadIdentity(timer.payload)) {
        throw new Error(`Durable timer '${timer.timerId}' conflicts with its existing identity`);
      }
      return false;
    },

    async list(args) {
      await ensureCompanyRecordsSchema();
      const rows = await connection()`select * from companyos_records.durable_timers
        where instance_id = ${args.instanceId}
          and (${args.timerKind ?? null}::text is null or timer_kind = ${args.timerKind ?? null})
        order by due_at, timer_id`;
      return rows.map(storedTimer);
    },

    async claimDue(args) {
      await ensureCompanyRecordsSchema();
      const rows = await connection()`with due as (
          select instance_id, timer_id from companyos_records.durable_timers
          where instance_id = ${args.instanceId}
            and (${args.timerKind ?? null}::text is null or timer_kind = ${args.timerKind ?? null})
            and due_at <= ${args.now}
            and (state = 'scheduled' or (state = 'leased' and lease_expires_at <= ${args.now}))
          order by due_at, timer_id limit ${args.limit}
          for update skip locked
        )
        update companyos_records.durable_timers timers
          set state = 'leased', lease_owner = ${args.owner}, lease_token = ${args.leaseToken},
              lease_expires_at = ${args.leaseExpiresAt}, attempts = attempts + 1, updated_at = ${args.now}
        from due where timers.instance_id = due.instance_id and timers.timer_id = due.timer_id
        returning timers.*`;
      return rows.map(claimedTimer);
    },

    async complete(args) {
      await ensureCompanyRecordsSchema();
      const rows = await connection()`update companyos_records.durable_timers
        set state = 'completed', evidence = ${JSON.stringify(args.evidence)},
            completed_at = ${args.completedAt}, updated_at = ${args.completedAt}
        where instance_id = ${args.instanceId} and timer_id = ${args.timerId}
          and state = 'leased' and lease_token = ${args.leaseToken} returning timer_id`;
      return rows.length === 1;
    },

    async retry(args) {
      await ensureCompanyRecordsSchema();
      const rows = await connection()`update companyos_records.durable_timers
        set state = 'scheduled', due_at = ${args.dueAt}, evidence = ${JSON.stringify(args.evidence)},
            lease_owner = null, lease_token = null, lease_expires_at = null, updated_at = now()
        where instance_id = ${args.instanceId} and timer_id = ${args.timerId}
          and state = 'leased' and lease_token = ${args.leaseToken} returning timer_id`;
      return rows.length === 1;
    },

    async fail(args) {
      await ensureCompanyRecordsSchema();
      const rows = await connection()`update companyos_records.durable_timers
        set state = 'failed', evidence = ${JSON.stringify(args.evidence)},
            completed_at = ${args.failedAt}, updated_at = ${args.failedAt}
        where instance_id = ${args.instanceId} and timer_id = ${args.timerId}
          and state = 'leased' and lease_token = ${args.leaseToken} returning timer_id`;
      return rows.length === 1;
    },

    async cancel(args) {
      await ensureCompanyRecordsSchema();
      const rows = await connection()`update companyos_records.durable_timers
        set state = 'cancelled', evidence = ${JSON.stringify(args.evidence)},
            completed_at = ${args.cancelledAt}, updated_at = ${args.cancelledAt}
        where instance_id = ${args.instanceId} and timer_id = ${args.timerId}
          and state in ('scheduled','leased') returning timer_id`;
      return rows.length === 1;
    },
  };
}
