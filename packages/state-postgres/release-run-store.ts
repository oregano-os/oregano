import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { type ReleaseLease, type ReleaseRun, type ReleaseRunStore } from "../state-store/release-runs.ts";

/**
 * Reuses existing control-plane runs/events and the existing atomic lease
 * relation. Release snapshots are append-only events, never expiring chat state.
 * This adapter introduces no runtime schema migration.
 */
export function createPostgresReleaseRunStore(databaseUrl = process.env.DATABASE_URL): ReleaseRunStore {
  if (!databaseUrl) throw new Error("Release StateStore is not configured.");
  const sql = neon(databaseUrl);
  const workflow = (instanceId: string) => `builder.release:${instanceId}`;
  const lockKey = (instanceId: string) => `builder.release:${instanceId}`;
  const decode = (value: unknown): ReleaseRun => (typeof value === "string" ? JSON.parse(value) : value) as ReleaseRun;
  const get = async (id: string): Promise<ReleaseRun | undefined> => {
    const rows = await sql`select payload from companyos.events where run_id = ${id} and event = 'release.snapshot'
      order by (payload->>'revision')::int desc limit 1`;
    return rows[0] ? decode(rows[0].payload) : undefined;
  };
  const release = async (lease: ReleaseLease) => {
    await sql`delete from companyos.chat_locks where thread_id = ${lockKey(lease.run.candidate.instanceId)} and token = ${lease.token}`;
  };
  const store: ReleaseRunStore = {
    get,
    async create(run) {
      await sql`with created as (
        insert into companyos.workflow_runs (run_id, workflow, workflow_version, company_commit, company_snapshot_hash, agent_definition_hash, agent_adapter)
        values (${run.id}, ${workflow(run.candidate.instanceId)}, ${run.candidate.coreCommit}, ${run.candidate.candidateCommit}, ${run.candidateDigest}, ${run.candidate.policyDigest}, 'release-coordinator')
        on conflict (run_id) do nothing returning run_id
      ) insert into companyos.events (run_id, step_id, actor, subject_principal, event, payload)
        select run_id, 'accept', 'human', ${run.acceptedBy}, 'release.snapshot', ${JSON.stringify(run)}::jsonb from created`;
      const existing = await get(run.id);
      if (!existing || existing.candidateDigest !== run.candidateDigest) throw new Error("Release identity conflicts with stored content.");
      return existing;
    },
    async claim(instanceId, workerId, now, leaseMs) {
      if (!workerId || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || !Number.isFinite(Date.parse(now))) throw new Error("Invalid release lease.");
      const token = randomUUID();
      const expiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
      const locks = await sql`insert into companyos.chat_locks (thread_id, token, expires_at)
        values (${lockKey(instanceId)}, ${token}, ${expiresAt})
        on conflict (thread_id) do update set token = excluded.token, expires_at = excluded.expires_at
        where companyos.chat_locks.expires_at <= ${now} returning thread_id`;
      if (!locks.length) return undefined;
      const rows = await sql`select latest.payload from companyos.workflow_runs r
        cross join lateral (select payload from companyos.events e where e.run_id = r.run_id and e.event = 'release.snapshot'
          order by (payload->>'revision')::int desc limit 1) latest
        where r.workflow = ${workflow(instanceId)}
          and (latest.payload->>'stage' not in ('live','failed','rolled-back') or coalesce((latest.payload->>'notificationDelivered')::boolean, false) = false)
        order by case when latest.payload->>'stage' in ('live','failed','rolled-back') then 1 else 0 end,
          r.started_at, r.run_id limit 1`;
      if (!rows[0]) { await sql`delete from companyos.chat_locks where thread_id = ${lockKey(instanceId)} and token = ${token}`; return undefined; }
      return { run: decode(rows[0].payload), token, expiresAt };
    },
    async save(lease, run, now) {
      if (run.id !== lease.run.id || run.revision !== lease.run.revision + 1 || run.candidateDigest !== lease.run.candidateDigest) throw new Error("Invalid release revision.");
      const rows = await sql`with owned as (
        select thread_id from companyos.chat_locks where thread_id = ${lockKey(run.candidate.instanceId)}
          and token = ${lease.token} and expires_at > ${now} for update
      ), appended as (
        insert into companyos.events (run_id, step_id, actor, event, payload)
        select ${run.id}, ${run.stage}, 'release-coordinator', 'release.snapshot', ${JSON.stringify(run)}::jsonb from owned
        where (select max((payload->>'revision')::int) from companyos.events where run_id = ${run.id} and event = 'release.snapshot') = ${lease.run.revision}
        returning event_id
      ) select event_id from appended`;
      if (!rows.length) throw new Error("Release lease or revision is stale.");
      return { ...lease, run };
    },
    release,
    async requestRollback(id, actor, expectedRevision, now) {
      const run = await get(id);
      if (!run || run.revision !== expectedRevision || !["live", "failed"].includes(run.stage)) throw new Error("Release changed before rollback.");
      const token = randomUUID();
      const expiresAt = new Date(Date.parse(now) + 30000).toISOString();
      const locked = await sql`insert into companyos.chat_locks (thread_id, token, expires_at)
        values (${lockKey(run.candidate.instanceId)}, ${token}, ${expiresAt})
        on conflict (thread_id) do update set token = excluded.token, expires_at = excluded.expires_at
        where companyos.chat_locks.expires_at <= ${now} returning thread_id`;
      if (!locked.length) throw new Error("The release target is busy.");
      const lease = { run, token, expiresAt };
      try {
        return (await store.save(lease, { ...run, stage: "rolling-back", rollbackBy: actor, notificationDelivered: false, revision: run.revision + 1, updatedAt: now }, now)).run;
      } finally { await release(lease); }
    },
  };
  return store;
}
