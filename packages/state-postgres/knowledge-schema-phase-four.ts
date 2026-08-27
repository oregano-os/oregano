// Trusted, additive statements for Source-wide synchronization leases.
// Leases coordinate schedulers only and never contain provider payloads.
export const COMPANY_KNOWLEDGE_PHASE_FOUR_SCHEMA_STATEMENTS = [
  `create table if not exists companyos_knowledge.source_sync_leases (
    source_id text not null references companyos_knowledge.sources(source_id),
    stream_id text not null,
    lease_owner text not null,
    acquired_at timestamptz not null,
    lease_until timestamptz not null,
    primary key (source_id, stream_id),
    check (lease_until > acquired_at)
  )`,
  `create index if not exists knowledge_source_sync_leases_due_idx
    on companyos_knowledge.source_sync_leases(lease_until, source_id, stream_id)`,
] as const;
