import { neon } from "@neondatabase/serverless";
import { ensureCompanyOSSchema } from "./migrate.ts";

export const WORKFLOW_SCHEMA_STATEMENTS = [
  `create table if not exists companyos.workflow_artifacts (
  artifact_hash text primary key,
  instance_id text not null,
  artifact_json jsonb not null,
  created_at timestamptz not null default now()
)`,
  `create table if not exists companyos.workflow_executions (
  run_id text primary key references companyos.workflow_runs(run_id),
  instance_id text not null,
  workflow_id text not null,
  artifact_hash text not null references companyos.workflow_artifacts(artifact_hash),
  manifest_hash text not null,
  origin_key text not null,
  origin_digest text not null,
  identity_json jsonb not null,
  state_json jsonb not null,
  revision bigint not null default 0,
  lease_owner text,
  lease_token text,
  lease_expires_at timestamptz,
  updated_at timestamptz not null,
  constraint workflow_execution_origin_unique unique(instance_id, workflow_id, origin_key),
  constraint workflow_execution_revision_check check(revision >= 0),
  constraint workflow_execution_lease_check check(
    (lease_owner is null and lease_token is null and lease_expires_at is null)
    or (lease_owner is not null and lease_token is not null and lease_expires_at is not null))
)`,
  `create index if not exists workflow_executions_status_idx
  on companyos.workflow_executions(instance_id, (state_json->>'status'), updated_at, run_id)`,
  `create table if not exists companyos.workflow_thread_assignments (
  instance_id text not null,
  assignment_key text not null,
  run_id text not null references companyos.workflow_executions(run_id),
  assignment_json jsonb not null,
  expires_at timestamptz not null,
  primary key(instance_id, assignment_key)
)`,
  `create index if not exists workflow_thread_assignments_run_idx
  on companyos.workflow_thread_assignments(instance_id, run_id)`
] as const;

const migrations = new Map<string, Promise<void>>();
export function ensureWorkflowExecutionSchema(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for workflow persistence");
  let pending = migrations.get(url);
  if (!pending) {
    pending = (async () => {
      await ensureCompanyOSSchema();
      const sql = neon(url);
      for (const statement of WORKFLOW_SCHEMA_STATEMENTS) await sql.query(statement, []);
    })().catch((error) => { migrations.delete(url); throw error; });
    migrations.set(url, pending);
  }
  return pending;
}
