import { neon } from "@neondatabase/serverless";

let migration: Promise<void> | undefined;

const databaseUrl = (): string => {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is not set — Company Records uses the existing Company Instance database.");
  return value;
};

/** Add the isolated records schema to the existing Company Instance database. */
export function ensureCompanyRecordsSchema(): Promise<void> {
  migration ??= (async () => {
    const sql = neon(databaseUrl());
    await sql`create schema if not exists companyos_records`;
    await sql`create table if not exists companyos_records.source_events (
      instance_id text not null, source_id text not null, event_id text not null,
      object_id text not null,
      event_kind text not null check (event_kind in ('created','updated','deleted','access-changed','reconcile')),
      observed_at timestamptz not null, cursor text, receipt jsonb not null,
      recorded_at timestamptz not null default now(),
      primary key (instance_id, source_id, event_id))`;
    await sql`create index if not exists records_source_events_object_idx
      on companyos_records.source_events(instance_id, source_id, object_id, observed_at desc)`;
    await sql`create table if not exists companyos_records.object_versions (
      instance_id text not null, source_id text not null, record_type text not null,
      object_id text not null, version_id text not null, digest text not null,
      observed_at timestamptz not null, deleted boolean not null,
      values_json jsonb not null, source_receipt jsonb not null,
      recorded_at timestamptz not null default now(),
      primary key (instance_id, source_id, version_id),
      unique (instance_id, source_id, object_id, digest))`;
    await sql`create index if not exists records_object_versions_object_idx
      on companyos_records.object_versions(instance_id, source_id, object_id, observed_at desc)`;
    await sql`create table if not exists companyos_records.current_objects (
      instance_id text not null, source_id text not null, object_id text not null,
      version_id text not null, updated_at timestamptz not null,
      primary key (instance_id, source_id, object_id),
      foreign key (instance_id, source_id, version_id)
        references companyos_records.object_versions(instance_id, source_id, version_id))`;
    await sql`create table if not exists companyos_records.projection_rows (
      instance_id text not null, projection_id text not null, record_id text not null,
      record_type text not null, source_version_id text not null,
      projected_at timestamptz not null, values_json jsonb not null,
      primary key (instance_id, projection_id, record_id))`;
    await sql`create index if not exists records_projection_rows_values_idx
      on companyos_records.projection_rows using gin(values_json)`;
    await sql`create table if not exists companyos_records.access_decisions (
      decision_id uuid primary key default gen_random_uuid(), projection_id text not null,
      principal_id text not null, allowed boolean not null, policy_digest text not null,
      reason text not null check (reason in ('group-allowed','role-allowed','no-matching-grant','inactive-subject')),
      decided_at timestamptz not null)`;
    await sql`create index if not exists records_access_decisions_principal_idx
      on companyos_records.access_decisions(principal_id, decided_at desc)`;
    await sql`create table if not exists companyos_records.sync_receipts (
      instance_id text not null, source_id text not null, run_id text not null,
      started_at timestamptz not null, completed_at timestamptz not null,
      watermark text, summary jsonb not null,
      primary key (instance_id, source_id, run_id))`;
    await sql`create table if not exists companyos_records.source_watermarks (
      instance_id text not null, source_id text not null, watermark text not null,
      observed_at timestamptz not null, primary key (instance_id, source_id))`;
    await sql`create table if not exists companyos_records.sync_leases (
      instance_id text not null, source_id text not null, lease_owner text not null,
      lease_token text not null, lease_expires_at timestamptz not null,
      updated_at timestamptz not null, primary key (instance_id, source_id))`;
    await sql`create index if not exists records_sync_leases_due_idx
      on companyos_records.sync_leases(lease_expires_at, instance_id, source_id)`;
    await sql`create table if not exists companyos_records.durable_timers (
      instance_id text not null, timer_id text not null, timer_kind text not null,
      due_at timestamptz not null, idempotency_key text not null, payload jsonb not null,
      state text not null default 'scheduled' check (state in ('scheduled','leased','completed','failed','cancelled')),
      attempts integer not null default 0, lease_owner text, lease_token text,
      lease_expires_at timestamptz, evidence jsonb, completed_at timestamptz,
      updated_at timestamptz not null default now(), primary key (instance_id, timer_id),
      unique (instance_id, idempotency_key))`;
    await sql`create index if not exists records_durable_timers_due_idx
      on companyos_records.durable_timers(instance_id, state, due_at, lease_expires_at)`;
    await sql`create table if not exists companyos_records.sprint_states (
      instance_id text not null, definition_id text not null,
      state_version bigint not null check (state_version > 0), state_json jsonb not null,
      updated_at timestamptz not null, primary key (instance_id, definition_id))`;
    await sql`create table if not exists companyos_records.sprint_events (
      instance_id text not null, definition_id text not null, event_id text not null,
      event_type text not null, occurred_at timestamptz not null,
      state_version bigint not null check (state_version > 0), event_json jsonb not null,
      decision_json jsonb not null, committed_at timestamptz not null,
      primary key (instance_id, definition_id, event_id))`;
    await sql`create unique index if not exists records_sprint_events_sequence_idx
      on companyos_records.sprint_events(instance_id, definition_id, state_version)`;
    await sql`create table if not exists companyos_records.sprint_intents (
      instance_id text not null, definition_id text not null, intent_id text not null,
      created_by_event_id text not null, intent_type text not null, intent_json jsonb not null,
      state text not null default 'pending' check (state in ('pending','leased','succeeded','failed','cancelled')),
      available_at timestamptz not null, attempts integer not null default 0,
      lease_owner text, lease_token text, lease_expires_at timestamptz, evidence jsonb,
      completed_at timestamptz, updated_at timestamptz not null,
      primary key (instance_id, definition_id, intent_id),
      constraint records_sprint_intents_event_fk foreign key (instance_id, definition_id, created_by_event_id)
        references companyos_records.sprint_events(instance_id, definition_id, event_id),
      constraint records_sprint_intents_lease_check check (
        state <> 'leased' or (lease_owner is not null and lease_token is not null and lease_expires_at is not null)),
      constraint records_sprint_intents_completion_check check (
        (state in ('succeeded','failed','cancelled') and completed_at is not null)
        or (state in ('pending','leased') and completed_at is null)))`;
    await sql`create index if not exists records_sprint_intents_due_idx
      on companyos_records.sprint_intents(instance_id, definition_id, state, available_at, lease_expires_at)`;
    await sql`create table if not exists companyos_records.connector_echo_receipts (
      instance_id text not null, connector_id text not null, resource_binding text not null,
      object_id text not null, provider_version text not null, actor_id text not null,
      idempotency_key text not null, expires_at timestamptz not null,
      recorded_at timestamptz not null default now(),
      primary key (instance_id, connector_id, resource_binding, object_id, provider_version, actor_id))`;
    await sql`create index if not exists records_connector_echo_expiry_idx
      on companyos_records.connector_echo_receipts(expires_at)`;
    await sql`create table if not exists companyos_records.callback_replay_claims (
      claim_digest text primary key, expires_at timestamptz not null,
      recorded_at timestamptz not null default now())`;
    await sql`create index if not exists records_callback_replay_expiry_idx
      on companyos_records.callback_replay_claims(expires_at)`;
  })();
  return migration;
}
