import { neon } from "@neondatabase/serverless";

let migration: Promise<void> | undefined;

function databaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is not set — provision Neon and bind it to the Company Instance.");
  return value;
}

export function ensureCompanyOSSchema(): Promise<void> {
  migration ??= (async () => {
    const sql = neon(databaseUrl());
    await sql`create schema if not exists companyos`;
    await sql`create table if not exists companyos.schema_manifests (
      manifest_id text not null, manifest_version text not null, manifest_digest text not null,
      features jsonb not null, applied_at timestamptz not null default now(),
      primary key (manifest_id, manifest_version))`;
    await sql`create table if not exists companyos.workflow_runs (
      run_id text primary key, workflow text not null, workflow_version text not null,
      company_commit text, company_snapshot_hash text not null, agent_definition_hash text not null,
      agent_adapter text not null, adapter_version text, agent_deployment text,
      status text not null default 'running' check (status in ('running','waiting','done','cancelled','failed')),
      started_at timestamptz not null default now())`;
    await sql`create table if not exists companyos.events (
      event_id uuid primary key default gen_random_uuid(),
      run_id text not null references companyos.workflow_runs(run_id), step_id text not null,
      ts timestamptz not null default now(), actor text not null, subject_principal text,
      event text not null, status text check (status in ('succeeded','failed','effect-unknown')),
      caused_by_event_id uuid, tool_version text, idempotency_key text, evidence jsonb, payload jsonb)`;
    await sql`create table if not exists companyos.approval_requests (
      request_id uuid primary key default gen_random_uuid(),
      run_id text not null references companyos.workflow_runs(run_id), step_id text not null,
      action text not null, input_hash text not null, connection text, max_spend numeric,
      expires_at timestamptz, created_at timestamptz not null default now())`;
    await sql`create table if not exists companyos.approvals (
      approval_id uuid primary key default gen_random_uuid(),
      request_id uuid not null references companyos.approval_requests(request_id),
      subject_principal text not null, role text not null,
      decision text not null check (decision in ('approved','rejected')),
      decided_at timestamptz not null default now(), consumed_at timestamptz)`;
    await sql`create table if not exists companyos.effects (
      idempotency_key text primary key,
      run_id text not null references companyos.workflow_runs(run_id), step_id text not null,
      approval_id uuid references companyos.approvals(approval_id) unique, input_hash text,
      status text not null default 'claimed' check (status in ('claimed','dispatched','succeeded','failed','unknown')),
      claimed_at timestamptz not null default now(), updated_at timestamptz not null default now(), evidence jsonb)`;
    await sql`create table if not exists companyos.chat_values (
      key text primary key, value jsonb not null, expires_at timestamptz)`;
    await sql`create table if not exists companyos.chat_subscriptions (
      thread_id text primary key, subscribed_at timestamptz not null default now())`;
    await sql`create table if not exists companyos.chat_locks (
      thread_id text primary key, token text not null, expires_at timestamptz not null)`;
    await sql`create table if not exists companyos.chat_lists (
      sequence bigserial primary key, key text not null, value jsonb not null, expires_at timestamptz)`;
    await sql`create index if not exists chat_lists_key_sequence_idx on companyos.chat_lists(key, sequence)`;
    await sql`create table if not exists companyos.chat_queue (
      sequence bigserial primary key, thread_id text not null, entry jsonb not null, expires_at timestamptz not null)`;
    await sql`create index if not exists chat_queue_thread_sequence_idx on companyos.chat_queue(thread_id, sequence)`;
    await sql`create table if not exists companyos.published_artifacts (
      artifact_id text primary key, content text not null, content_type text not null, digest text not null,
      run_id text not null references companyos.workflow_runs(run_id), published_at timestamptz not null default now())`;
  })();
  return migration;
}
