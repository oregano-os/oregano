-- Company Records v1. Additive, provider-neutral operational projections.
-- This schema contains synchronized business records, not curated Handbook authority.

create schema if not exists companyos_records;

create table if not exists companyos_records.source_events (
  instance_id text not null,
  source_id text not null,
  event_id text not null,
  object_id text not null,
  event_kind text not null check (event_kind in ('created','updated','deleted','access-changed','reconcile')),
  observed_at timestamptz not null,
  cursor text,
  receipt jsonb not null,
  recorded_at timestamptz not null default now(),
  primary key (instance_id, source_id, event_id)
);
create index if not exists records_source_events_object_idx
  on companyos_records.source_events(instance_id, source_id, object_id, observed_at desc);

create table if not exists companyos_records.object_versions (
  instance_id text not null,
  source_id text not null,
  record_type text not null,
  object_id text not null,
  version_id text not null,
  digest text not null,
  observed_at timestamptz not null,
  deleted boolean not null,
  values_json jsonb not null,
  source_receipt jsonb not null,
  recorded_at timestamptz not null default now(),
  primary key (instance_id, source_id, version_id),
  unique (instance_id, source_id, object_id, digest)
);
create index if not exists records_object_versions_object_idx
  on companyos_records.object_versions(instance_id, source_id, object_id, observed_at desc);

create table if not exists companyos_records.current_objects (
  instance_id text not null,
  source_id text not null,
  object_id text not null,
  version_id text not null,
  updated_at timestamptz not null,
  primary key (instance_id, source_id, object_id),
  foreign key (instance_id, source_id, version_id)
    references companyos_records.object_versions(instance_id, source_id, version_id)
);

create table if not exists companyos_records.projection_rows (
  instance_id text not null,
  projection_id text not null,
  record_id text not null,
  record_type text not null,
  source_version_id text not null,
  projected_at timestamptz not null,
  values_json jsonb not null,
  primary key (instance_id, projection_id, record_id)
);
create index if not exists records_projection_rows_values_idx
  on companyos_records.projection_rows using gin(values_json);

create table if not exists companyos_records.access_decisions (
  decision_id uuid primary key default gen_random_uuid(),
  projection_id text not null,
  principal_id text not null,
  allowed boolean not null,
  policy_digest text not null,
  reason text not null check (reason in ('group-allowed','role-allowed','no-matching-grant','inactive-subject')),
  decided_at timestamptz not null
);
create index if not exists records_access_decisions_principal_idx
  on companyos_records.access_decisions(principal_id, decided_at desc);

create table if not exists companyos_records.sync_receipts (
  instance_id text not null,
  source_id text not null,
  run_id text not null,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  watermark text,
  summary jsonb not null,
  primary key (instance_id, source_id, run_id)
);

create table if not exists companyos_records.source_watermarks (
  instance_id text not null,
  source_id text not null,
  watermark text not null,
  observed_at timestamptz not null,
  primary key (instance_id, source_id)
);

create table if not exists companyos_records.sync_leases (
  instance_id text not null,
  source_id text not null,
  lease_owner text not null,
  lease_token text not null,
  lease_expires_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (instance_id, source_id)
);
create index if not exists records_sync_leases_due_idx
  on companyos_records.sync_leases(lease_expires_at, instance_id, source_id);
