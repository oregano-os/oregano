import { neon } from "@neondatabase/serverless";
import {
  assertBuilderJobInput,
  assertBuilderJobTransition,
  builderJobFingerprint,
  newLeaseToken,
  type BuilderJob,
  type BuilderJobInput,
  type BuilderJobLease,
  type BuilderJobState,
  type BuilderJobStore,
} from "../state-store/builder-jobs.ts";
import { ensureCompanyOSSchema } from "./migrate.ts";

function connection() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — bind the Company Instance StateStore.");
  return neon(url);
}

export function createPostgresBuilderJobStore(): BuilderJobStore {
  return {
    async create(input: BuilderJobInput, now = new Date()): Promise<BuilderJob> {
      assertBuilderJobInput(input);
      await ensureCompanyOSSchema();
      const fingerprint = builderJobFingerprint(input);
      const rows = await connection()`
        insert into companyos.builder_jobs (
          job_id, request_id, fingerprint, input, state, attempts, created_at, updated_at)
        values (
          ${input.jobId}, ${input.requestId}, ${fingerprint}, ${JSON.stringify(input)},
          'queued', 0, ${now.toISOString()}, ${now.toISOString()})
        on conflict (request_id) do update set request_id = excluded.request_id
        where companyos.builder_jobs.fingerprint = excluded.fingerprint
        returning *`;
      if (rows.length === 0) {
        throw new Error("Builder request id was reused with different immutable input.");
      }
      return rowToJob(rows[0]);
    },

    async get(jobId) {
      await ensureCompanyOSSchema();
      const rows = await connection()`select * from companyos.builder_jobs where job_id = ${jobId} limit 1`;
      return rows[0] ? rowToJob(rows[0]) : undefined;
    },

    async getByRequestId(requestId) {
      await ensureCompanyOSSchema();
      const rows = await connection()`select * from companyos.builder_jobs where request_id = ${requestId} limit 1`;
      return rows[0] ? rowToJob(rows[0]) : undefined;
    },

    async claimNext({ workerId, leaseMs, now = new Date() }): Promise<BuilderJobLease | undefined> {
      assertLease(workerId, leaseMs);
      await ensureCompanyOSSchema();
      const token = newLeaseToken();
      const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
      const rows = await connection()`
        with candidate as (
          select job_id from companyos.builder_jobs
          where state not in ('published', 'failed', 'cancelled')
            and (
              lease_token is null
              or lease_expires_at <= ${now.toISOString()}
            )
          order by created_at
          for update skip locked
          limit 1
        )
        update companyos.builder_jobs
        set lease_owner = ${workerId}, lease_token = ${token},
            lease_expires_at = ${expiresAt}, attempts = attempts + 1,
            updated_at = ${now.toISOString()}
        where job_id in (select job_id from candidate)
        returning *`;
      if (!rows[0]) return undefined;
      return {
        job: rowToJob(rows[0]),
        workerId,
        leaseToken: token,
        leaseExpiresAt: expiresAt,
      };
    },

    async renewLease({ jobId, workerId, leaseToken, leaseMs, now = new Date() }): Promise<BuilderJobLease> {
      assertLease(workerId, leaseMs);
      const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
      const rows = await connection()`
        update companyos.builder_jobs
        set lease_expires_at = ${expiresAt}, updated_at = ${now.toISOString()}
        where job_id = ${jobId} and lease_owner = ${workerId}
          and lease_token = ${leaseToken} and lease_expires_at > ${now.toISOString()}
        returning *`;
      if (!rows[0]) throw new Error(`Builder job '${jobId}' lease is missing, stale, or owned by another worker.`);
      return { job: rowToJob(rows[0]), workerId, leaseToken, leaseExpiresAt: expiresAt };
    },

    async releaseLease({ jobId, workerId, leaseToken, now = new Date() }): Promise<void> {
      const rows = await connection()`
        update companyos.builder_jobs
        set lease_owner = null, lease_token = null, lease_expires_at = null,
            updated_at = ${now.toISOString()}
        where job_id = ${jobId} and lease_owner = ${workerId}
          and lease_token = ${leaseToken} and lease_expires_at > ${now.toISOString()}
          and state not in ('published','failed','cancelled')
        returning job_id`;
      if (!rows[0]) throw new Error(`Builder job '${jobId}' lease release was rejected.`);
    },

    async transition(args): Promise<BuilderJob> {
      const now = args.now ?? new Date();
      for (const from of args.from) assertBuilderJobTransition(from, args.to);
      const rows = await connection()`
        update companyos.builder_jobs
        set state = ${args.to}, updated_at = ${now.toISOString()},
            execution_handle = coalesce(${JSON.stringify(args.executionHandle ?? null)}::jsonb, execution_handle),
            evidence = coalesce(${JSON.stringify(args.evidence ?? null)}::jsonb, evidence),
            terminal_reason = coalesce(${args.terminalReason ?? null}, terminal_reason),
            lease_owner = case when ${args.to} in ('published','failed','cancelled') then null else lease_owner end,
            lease_token = case when ${args.to} in ('published','failed','cancelled') then null else lease_token end,
            lease_expires_at = case when ${args.to} in ('published','failed','cancelled') then null else lease_expires_at end
        where job_id = ${args.jobId} and lease_owner = ${args.workerId}
          and lease_token = ${args.leaseToken} and lease_expires_at > ${now.toISOString()}
          and state = any(${[...args.from]}::text[])
        returning *`;
      if (!rows[0]) throw new Error(`Builder job '${args.jobId}' transition was rejected by state or lease guards.`);
      return rowToJob(rows[0]);
    },

    async requestCancellation(jobId, requestedAt = new Date()): Promise<BuilderJob> {
      const rows = await connection()`
        update companyos.builder_jobs
        set cancel_requested_at = coalesce(cancel_requested_at, ${requestedAt.toISOString()}),
            updated_at = ${requestedAt.toISOString()}
        where job_id = ${jobId} and state not in ('published','failed','cancelled')
        returning *`;
      if (rows[0]) return rowToJob(rows[0]);
      const existing = await connection()`
        select * from companyos.builder_jobs where job_id = ${jobId} limit 1`;
      if (!existing[0]) throw new Error(`Unknown Builder job '${jobId}'.`);
      return rowToJob(existing[0]);
    },
  };
}

function rowToJob(row: Record<string, any>): BuilderJob {
  const input = (typeof row.input === "string" ? JSON.parse(row.input) : row.input) as BuilderJobInput;
  return {
    ...input,
    fingerprint: String(row.fingerprint),
    state: row.state as BuilderJobState,
    attempts: Number(row.attempts),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    cancelRequestedAt: row.cancel_requested_at ? new Date(row.cancel_requested_at).toISOString() : undefined,
    executionHandle: row.execution_handle ?? undefined,
    evidence: row.evidence ?? undefined,
    terminalReason: row.terminal_reason ?? undefined,
  };
}

function assertLease(workerId: string, leaseMs: number): void {
  if (!workerId || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000) {
    throw new Error("Builder lease request is invalid.");
  }
}
