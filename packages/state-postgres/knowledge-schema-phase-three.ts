// Trusted, additive PostgreSQL statements for the Company Knowledge Phase 3C
// shared Source ingestion pipeline. Statements contain no runtime input.
export const COMPANY_KNOWLEDGE_PHASE_THREE_SCHEMA_STATEMENTS = [
  `create table if not exists companyos_knowledge.source_events (
    event_id text primary key,
    source_id text not null references companyos_knowledge.sources(source_id),
    delivery_id text not null,
    provider_tenant_id text not null,
    event_type text not null check (event_type in ('created','updated','deleted','access-changed')),
    provider_object_id text not null,
    provider_version text,
    occurred_at timestamptz not null,
    observed_at timestamptz not null,
    event jsonb not null,
    status text not null check (status in ('received','leased','processed','quarantined','failed','deferred')),
    attempt integer not null default 0 check (attempt >= 0),
    lease_owner text,
    lease_until timestamptz,
    failure_class text check (failure_class in ('provider-failure','integrity-failure','policy-failure','content-failure','storage-failure','unsupported')),
    retry_after timestamptz,
    completed_at timestamptz,
    recorded_at timestamptz not null default now(),
    unique (source_id, delivery_id)
  )`,
  `create index if not exists knowledge_source_events_queue_idx
    on companyos_knowledge.source_events(status, retry_after, lease_until, observed_at, event_id)`,
  `create index if not exists knowledge_source_events_object_idx
    on companyos_knowledge.source_events(source_id, provider_object_id, observed_at, event_id)`,
  `create table if not exists companyos_knowledge.source_acl_snapshots (
    source_id text not null references companyos_knowledge.sources(source_id),
    provider_object_id text not null,
    provider_access_version text not null,
    observed_at timestamptz not null,
    evidence_digest text not null,
    snapshot jsonb not null,
    recorded_at timestamptz not null default now(),
    primary key (source_id, provider_object_id, provider_access_version)
  )`,
  `create index if not exists knowledge_source_acl_object_idx
    on companyos_knowledge.source_acl_snapshots(source_id, provider_object_id, observed_at desc, provider_access_version)`,
  `create table if not exists companyos_knowledge.source_pipeline_receipts (
    receipt_id text primary key,
    source_id text not null references companyos_knowledge.sources(source_id),
    connector_id text not null,
    connector_version text not null,
    operation text not null check (operation in ('resolve','verify','enumerate','read-changes','webhook','fetch','read-access','enqueue','reconcile','cursor','quarantine','lifecycle','health','revoke')),
    outcome text not null check (outcome in ('succeeded','failed','deferred','skipped')),
    observed_at timestamptz not null,
    evidence_digest text not null,
    receipt jsonb not null,
    recorded_at timestamptz not null default now()
  )`,
  `create index if not exists knowledge_source_pipeline_receipts_source_idx
    on companyos_knowledge.source_pipeline_receipts(source_id, observed_at, receipt_id)`,
  `create table if not exists companyos_knowledge.source_watermarks (
    source_id text not null references companyos_knowledge.sources(source_id),
    stream_id text not null,
    cursor_value text,
    watermark_value text,
    completed boolean not null,
    state_digest text not null,
    updated_at timestamptz not null,
    primary key (source_id, stream_id)
  )`,
  `create table if not exists companyos_knowledge.knowledge_change_stream (
    sequence bigint generated always as identity primary key,
    change_id text not null unique,
    previous_digest text,
    chain_digest text not null unique,
    source_id text not null references companyos_knowledge.sources(source_id),
    object_kind text not null check (object_kind in ('source-object','raw-asset','access-policy')),
    object_id text not null,
    object_version text,
    change_kind text not null check (change_kind in ('ingested','deleted','access-changed','quarantined','restored','purged')),
    access_policy_id text not null references companyos_knowledge.acl_policies(policy_id),
    payload_digest text not null,
    receipt_id text not null references companyos_knowledge.source_pipeline_receipts(receipt_id),
    occurred_at timestamptz not null,
    recorded_at timestamptz not null default now()
  )`,
  `create index if not exists knowledge_change_stream_source_idx
    on companyos_knowledge.knowledge_change_stream(source_id, sequence, change_id)`,
  `create unique index if not exists knowledge_change_stream_previous_idx
    on companyos_knowledge.knowledge_change_stream(previous_digest) where previous_digest is not null`,
  `create unique index if not exists knowledge_change_stream_genesis_idx
    on companyos_knowledge.knowledge_change_stream ((1)) where previous_digest is null`,
  `create table if not exists companyos_knowledge.source_lifecycle_requests (
    request_id text primary key,
    source_id text not null references companyos_knowledge.sources(source_id),
    target_kind text not null check (target_kind in ('source-object','raw-asset')),
    target_id text not null,
    target_version text,
    requested_by text not null,
    reason text not null,
    requested_at timestamptz not null,
    purge_after timestamptz not null,
    dependency_ids jsonb not null,
    access_policy_id text not null references companyos_knowledge.acl_policies(policy_id),
    status text not null check (status in ('requested','restored','held','purged')),
    legal_hold boolean not null default false,
    restored_at timestamptz,
    purged_at timestamptz,
    receipt_id text not null references companyos_knowledge.source_pipeline_receipts(receipt_id),
    updated_at timestamptz not null default now(),
    check (purge_after >= requested_at)
  )`,
  `create index if not exists knowledge_source_lifecycle_due_idx
    on companyos_knowledge.source_lifecycle_requests(status, legal_hold, purge_after, request_id)`,
  `create table if not exists companyos_knowledge.session_lifecycle_receipts (
    receipt_id text primary key,
    operation text not null check (operation in ('transfer','buffer-cleanup','corpus-cleanup','archive','recovery')),
    outcome text not null check (outcome in ('succeeded','failed','skipped')),
    session_id text not null,
    corpus_id text,
    buffer_id text,
    occurred_at timestamptz not null,
    evidence_digest text not null,
    reason_code text not null,
    receipt jsonb not null,
    recorded_at timestamptz not null default now()
  )`,
  `create index if not exists knowledge_session_lifecycle_receipts_session_idx
    on companyos_knowledge.session_lifecycle_receipts(session_id, occurred_at, receipt_id)`,
  `alter table companyos_knowledge.source_object_versions add column if not exists event_id text`,
  `alter table companyos_knowledge.source_object_versions add column if not exists provider_tenant_id text`,
  `alter table companyos_knowledge.source_object_versions add column if not exists provider_access_version text`,
  `alter table companyos_knowledge.source_object_versions add column if not exists sanity_codes jsonb not null default '[]'::jsonb`,
  `alter table companyos_knowledge.source_object_versions add column if not exists model_ready boolean not null default false`,
  `alter table companyos_knowledge.source_object_versions add column if not exists payload_state text not null default 'active'`,
  `alter table companyos_knowledge.source_object_versions add column if not exists redacted_at timestamptz`,
  `do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'knowledge_source_object_payload_state_check'
        and conrelid = 'companyos_knowledge.source_object_versions'::regclass) then
        alter table companyos_knowledge.source_object_versions add constraint knowledge_source_object_payload_state_check
          check (payload_state in ('active','deletion-requested','purged'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'knowledge_source_events_event_fk'
        and conrelid = 'companyos_knowledge.source_object_versions'::regclass) then
        alter table companyos_knowledge.source_object_versions add constraint knowledge_source_events_event_fk
          foreign key (event_id) references companyos_knowledge.source_events(event_id);
      end if;
    end $$`,
] as const;
