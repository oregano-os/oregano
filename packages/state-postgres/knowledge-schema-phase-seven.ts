// Trusted, additive storage for rebuildable Retrieval V3 projections and
// payload-free productization evidence. Durable Brain and Handbook objects
// remain in their existing immutable tables.
export const COMPANY_KNOWLEDGE_PHASE_SEVEN_SCHEMA_STATEMENTS = [
  `create table if not exists companyos_knowledge.retrieval_projection_runs (
    projection_hash text primary key,
    contract_version text not null,
    source_snapshot_ids jsonb not null,
    unit_count integer not null check (unit_count >= 0),
    status text not null check (status in ('staged','verified','active','retired','failed')),
    embedding_profile jsonb,
    created_at timestamptz not null,
    verified_at timestamptz,
    activated_at timestamptz,
    failure_digest text,
    check ((status = 'failed' and failure_digest is not null)
      or (status <> 'failed' and failure_digest is null))
  )`,
  `create unique index if not exists knowledge_one_active_retrieval_projection_idx
    on companyos_knowledge.retrieval_projection_runs ((status)) where status = 'active'`,
  `create index if not exists knowledge_retrieval_projection_status_idx
    on companyos_knowledge.retrieval_projection_runs(status, created_at desc, projection_hash)`,
  `create table if not exists companyos_knowledge.retrieval_units (
    projection_hash text not null references companyos_knowledge.retrieval_projection_runs(projection_hash) on delete cascade,
    unit_id text not null,
    parent_id text not null,
    unit_kind text not null check (unit_kind in ('handbook-fragment','page-fragment','claim','source-object','timeline-event','working-synthesis')),
    authority_layer text not null check (authority_layer in ('official','attributed','evidence','synthesized')),
    lifecycle_state text not null check (lifecycle_state in ('active','proposed','contested','resolved','superseded','expired')),
    title text not null,
    aliases jsonb not null,
    body text not null,
    content_digest text not null,
    access_policy_id text not null references companyos_knowledge.acl_policies(policy_id),
    source_ids jsonb not null,
    observed_at timestamptz not null,
    valid_from timestamptz,
    valid_until timestamptz,
    evidence_locator jsonb,
    graph_neighbors jsonb not null,
    ranking_signals jsonb not null,
    search_vector tsvector generated always as (
      to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, ''))
    ) stored,
    primary key (projection_hash, unit_id),
    check (valid_until is null or valid_from is null or valid_until >= valid_from),
    check ((unit_kind = 'handbook-fragment' and authority_layer = 'official')
      or (unit_kind <> 'handbook-fragment' and authority_layer <> 'official')),
    check (unit_kind <> 'working-synthesis' or authority_layer = 'synthesized'),
    check (unit_kind <> 'source-object' or authority_layer = 'evidence')
  )`,
  `create index if not exists knowledge_retrieval_units_search_idx
    on companyos_knowledge.retrieval_units using gin(search_vector)`,
  `create index if not exists knowledge_retrieval_units_policy_idx
    on companyos_knowledge.retrieval_units(projection_hash, access_policy_id, unit_kind, lifecycle_state, unit_id)`,
  `create index if not exists knowledge_retrieval_units_parent_idx
    on companyos_knowledge.retrieval_units(projection_hash, parent_id, observed_at desc, unit_id)`,
  `create table if not exists companyos_knowledge.knowledge_benchmark_runs (
    report_id text primary key,
    suite_id text not null,
    implementation_id text not null,
    status text not null check (status in ('passed','failed','insufficient-evidence')),
    sample_size integer not null check (sample_size >= 0),
    metrics jsonb not null,
    gates jsonb not null,
    failures jsonb not null,
    case_receipts jsonb not null,
    report jsonb not null,
    recorded_at timestamptz not null
  )`,
  `create index if not exists knowledge_benchmark_runs_suite_idx
    on companyos_knowledge.knowledge_benchmark_runs(suite_id, recorded_at desc, report_id)`,
  `create table if not exists companyos_knowledge.knowledge_shadow_comparisons (
    comparison_id text primary key,
    baseline_report_id text not null references companyos_knowledge.knowledge_benchmark_runs(report_id),
    candidate_report_id text not null references companyos_knowledge.knowledge_benchmark_runs(report_id),
    status text not null check (status in ('promotable','blocked')),
    deltas jsonb not null,
    blockers jsonb not null,
    comparison jsonb not null,
    compared_at timestamptz not null,
    check (baseline_report_id <> candidate_report_id)
  )`,
  `create index if not exists knowledge_shadow_comparisons_status_idx
    on companyos_knowledge.knowledge_shadow_comparisons(status, compared_at desc, comparison_id)`,
  `create table if not exists companyos_knowledge.knowledge_productization_receipts (
    receipt_id text primary key,
    receipt_kind text not null check (receipt_kind in ('environment-qualification','doctor','activation-qualification')),
    status text not null,
    evidence_digest text not null,
    receipt jsonb not null,
    recorded_at timestamptz not null
  )`,
  `create index if not exists knowledge_productization_receipts_kind_idx
    on companyos_knowledge.knowledge_productization_receipts(receipt_kind, recorded_at desc, receipt_id)`,
] as const;
