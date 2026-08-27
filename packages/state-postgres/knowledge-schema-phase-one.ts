// Trusted, additive PostgreSQL statements for the complete Company Brain
// Phase 1 storage foundation. These statements contain no runtime input and
// are executed sequentially by the maintained schema initializer.
export const COMPANY_BRAIN_PHASE_ONE_SCHEMA_STATEMENTS = [
  `create table if not exists companyos_knowledge.acl_policies (
    policy_id text primary key,
    policy_version integer not null check (policy_version > 0),
    visibility text not null check (visibility in ('public','company','team','restricted_group','individual','private')),
    parent_policy_id text references companyos_knowledge.acl_policies(policy_id),
    source_root boolean not null default false,
    status text not null check (status in ('active','quarantined','revoked')),
    definition jsonb not null,
    created_by text not null,
    created_at timestamptz not null default now()
  )`,
  `insert into companyos_knowledge.acl_policies
    (policy_id, policy_version, visibility, source_root, status, definition, created_by)
    values
      ('policy:quarantine', 1, 'private', true, 'quarantined',
        '{"reason":"unresolved-or-unmapped-access-policy"}'::jsonb, 'system:schema-upgrade'),
      ('policy:company-handbook', 1, 'company', true, 'active',
        '{"authority_layer":"handbook"}'::jsonb, 'system:schema-upgrade')
    on conflict (policy_id) do nothing`,
  `create table if not exists companyos_knowledge.acl_entries (
    entry_id text primary key,
    policy_id text not null references companyos_knowledge.acl_policies(policy_id),
    subject_kind text not null check (subject_kind in ('principal','group')),
    subject_id text not null,
    permission text not null check (permission in ('read','review','write','promote','admin')),
    effect text not null check (effect in ('allow','deny')),
    evidence jsonb not null,
    created_at timestamptz not null default now(),
    unique (policy_id, subject_kind, subject_id, permission)
  )`,
  `create index if not exists knowledge_acl_entries_subject_idx
    on companyos_knowledge.acl_entries(subject_kind, subject_id, permission, policy_id)`,
  `create table if not exists companyos_knowledge.external_principals (
    mapping_id text primary key,
    provider text not null,
    provider_account_id text not null,
    external_principal_id text not null,
    canonical_principal_id text,
    mapping_status text not null check (mapping_status in ('unresolved','verified','revoked')),
    mapping_evidence jsonb not null,
    verified_by text,
    created_at timestamptz not null default now(),
    verified_at timestamptz,
    unique (provider, provider_account_id, external_principal_id)
  )`,
  `create index if not exists knowledge_external_principals_canonical_idx
    on companyos_knowledge.external_principals(canonical_principal_id, mapping_status)
    where canonical_principal_id is not null`,
  `alter table companyos_knowledge.sources
    add column if not exists access_policy_id text not null default 'policy:quarantine'`,
  `alter table companyos_knowledge.sources
    add column if not exists provider_acl jsonb not null default '{}'::jsonb`,
  `alter table companyos_knowledge.source_object_versions
    add column if not exists access_policy_id text not null default 'policy:quarantine'`,
  `alter table companyos_knowledge.source_object_versions
    add column if not exists provider_acl jsonb not null default '{}'::jsonb`,
  `alter table companyos_knowledge.source_object_versions
    add column if not exists provider_locator text`,
  `alter table companyos_knowledge.source_object_versions
    add column if not exists byte_size bigint check (byte_size is null or byte_size >= 0)`,
  `alter table companyos_knowledge.source_object_versions
    add column if not exists mime_type text`,
  `alter table companyos_knowledge.source_object_versions
    add column if not exists encoding text`,
  `alter table companyos_knowledge.documents
    add column if not exists access_policy_id text not null default 'policy:company-handbook'`,
  `alter table companyos_knowledge.fragments
    add column if not exists access_policy_id text not null default 'policy:company-handbook'`,
  `alter table companyos_knowledge.review_candidates
    add column if not exists access_policy_id text not null default 'policy:quarantine'`,
  `alter table companyos_knowledge.runtime_observations
    add column if not exists access_policy_id text not null default 'policy:quarantine'`,
  `alter table companyos_knowledge.claim_evidence
    add column if not exists access_policy_id text not null default 'policy:quarantine'`,
  `alter table companyos_knowledge.claims
    add column if not exists notability numeric(5,4) not null default 0.5000 check (notability between 0 and 1)`,
  `alter table companyos_knowledge.claims
    add column if not exists typed_value jsonb`,
  `alter table companyos_knowledge.claims
    add column if not exists ontology_mapping jsonb`,
  `alter table companyos_knowledge.claims
    add column if not exists resolution_outcome text check (resolution_outcome in ('correct','incorrect','partial','unresolvable'))`,
  `alter table companyos_knowledge.claims
    add column if not exists resolution_evidence jsonb`,
  `alter table companyos_knowledge.claims
    add column if not exists resolved_at timestamptz`,
  `alter table companyos_knowledge.claims
    add column if not exists superseded_by_claim_id text references companyos_knowledge.claims(claim_id)`,
  `insert into companyos_knowledge.acl_policies
    (policy_id, policy_version, visibility, source_root, status, definition, created_by)
    select policy_id, 1, 'private', false, 'quarantined',
      '{"reason":"unresolved-legacy-policy"}'::jsonb, 'system:schema-upgrade'
    from (
      select access_policy_id as policy_id from companyos_knowledge.pages
      union select access_policy_id from companyos_knowledge.page_versions
      union select access_policy_id from companyos_knowledge.claims
      union select page_access_policy_id from companyos_knowledge.entity_identity_members
      union select candidate_access_policy_id from companyos_knowledge.entity_identity_proposals
    ) legacy_policies
    where policy_id is not null and policy_id <> ''
    on conflict (policy_id) do nothing`,
  `do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'knowledge_sources_access_policy_fk'
        and conrelid = 'companyos_knowledge.sources'::regclass) then
        alter table companyos_knowledge.sources add constraint knowledge_sources_access_policy_fk
          foreign key (access_policy_id) references companyos_knowledge.acl_policies(policy_id);
      end if;
      if not exists (select 1 from pg_constraint where conname = 'knowledge_source_objects_access_policy_fk'
        and conrelid = 'companyos_knowledge.source_object_versions'::regclass) then
        alter table companyos_knowledge.source_object_versions add constraint knowledge_source_objects_access_policy_fk
          foreign key (access_policy_id) references companyos_knowledge.acl_policies(policy_id);
      end if;
      if not exists (select 1 from pg_constraint where conname = 'knowledge_claim_evidence_access_policy_fk'
        and conrelid = 'companyos_knowledge.claim_evidence'::regclass) then
        alter table companyos_knowledge.claim_evidence add constraint knowledge_claim_evidence_access_policy_fk
          foreign key (access_policy_id) references companyos_knowledge.acl_policies(policy_id);
      end if;
    end $$`,
  `create table if not exists companyos_knowledge.raw_assets (
    asset_id text primary key,
    source_id text references companyos_knowledge.sources(source_id),
    provider_object_id text,
    provider_version text,
    content_digest text not null,
    byte_size bigint not null check (byte_size >= 0),
    mime_type text not null,
    encoding text,
    inline_content bytea,
    storage_pointer jsonb,
    access_policy_id text not null default 'policy:quarantine',
    retention_class text not null check (retention_class in ('durable','session-temporary','projection')),
    lifecycle_status text not null check (lifecycle_status in ('active','deletion-requested','deleted','legal-hold')),
    created_at timestamptz not null default now(),
    deleted_at timestamptz,
    constraint knowledge_raw_assets_access_policy_fk
      foreign key (access_policy_id) references companyos_knowledge.acl_policies(policy_id),
    check ((inline_content is not null)::integer + (storage_pointer is not null)::integer = 1),
    check ((provider_object_id is null and provider_version is null)
      or (provider_object_id is not null and provider_version is not null))
  )`,
  `create index if not exists knowledge_raw_assets_source_idx
    on companyos_knowledge.raw_assets(source_id, provider_object_id, provider_version)`,
  `create table if not exists companyos_knowledge.merge_ledger (
    merge_id text primary key,
    merge_kind text not null check (merge_kind in ('page','claim','entity','synthesis')),
    survivor_id text not null,
    merged_ids jsonb not null,
    decision_basis text not null check (decision_basis in ('deterministic-rule','review-decision','model-proposal')),
    decision_receipt_id text,
    rule_version text,
    source_count integer not null check (source_count >= 0),
    independent_source_count integer not null check (independent_source_count >= 0),
    merge_count integer not null check (merge_count > 0),
    facets jsonb not null,
    backlinks jsonb not null,
    angles jsonb not null,
    reversal_information jsonb,
    access_policy_id text not null default 'policy:quarantine'
      references companyos_knowledge.acl_policies(policy_id),
    status text not null check (status in ('proposed','applied','reversed')),
    created_by text not null,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists knowledge_merge_ledger_status_idx
    on companyos_knowledge.merge_ledger(status, merge_kind, created_at, merge_id)`,
  `create table if not exists companyos_knowledge.calibration_profiles (
    profile_id text primary key,
    profile_version integer not null check (profile_version > 0),
    holder_id text references companyos_knowledge.holders(holder_id),
    claim_kind text,
    sample_count integer not null check (sample_count >= 0),
    brier_score numeric(8,7) check (brier_score is null or brier_score between 0 and 1),
    calibration jsonb not null,
    evidence_digest text not null,
    access_policy_id text not null default 'policy:quarantine'
      references companyos_knowledge.acl_policies(policy_id),
    status text not null check (status in ('active','superseded')),
    valid_from timestamptz not null,
    valid_until timestamptz,
    created_at timestamptz not null default now(),
    check (valid_until is null or valid_until >= valid_from)
  )`,
  `create table if not exists companyos_knowledge.timeline_events (
    event_id text primary key,
    event_type text not null,
    subject_type text not null,
    subject_id text not null,
    page_version_id text references companyos_knowledge.page_versions(page_version_id),
    claim_id text references companyos_knowledge.claims(claim_id),
    source_id text,
    observed_at timestamptz not null,
    effective_at timestamptz,
    provenance_class text not null check (provenance_class in ('source','deterministic-rule','inferred','human-decision')),
    evidence jsonb not null,
    access_policy_id text not null default 'policy:quarantine'
      references companyos_knowledge.acl_policies(policy_id),
    lifecycle_status text not null check (lifecycle_status in ('active','superseded','deleted')),
    created_at timestamptz not null default now()
  )`,
  `create index if not exists knowledge_timeline_subject_idx
    on companyos_knowledge.timeline_events(subject_type, subject_id, observed_at, event_id)`,
  `create table if not exists companyos_knowledge.knowledge_edges (
    edge_id text primary key,
    from_type text not null,
    from_id text not null,
    to_type text not null,
    to_id text not null,
    edge_type text not null,
    provenance_class text not null check (provenance_class in ('sourced','inferred')),
    evidence jsonb not null,
    evidence_digest text not null,
    rule_version text,
    confidence numeric(5,4) check (confidence is null or confidence between 0 and 1),
    observed_at timestamptz not null,
    access_policy_id text not null default 'policy:quarantine'
      references companyos_knowledge.acl_policies(policy_id),
    lifecycle_status text not null check (lifecycle_status in ('active','superseded','deleted')),
    created_at timestamptz not null default now(),
    unique (from_type, from_id, to_type, to_id, edge_type, provenance_class, evidence_digest)
  )`,
  `create index if not exists knowledge_edges_from_idx
    on companyos_knowledge.knowledge_edges(from_type, from_id, edge_type, lifecycle_status, edge_id)`,
  `create index if not exists knowledge_edges_to_idx
    on companyos_knowledge.knowledge_edges(to_type, to_id, edge_type, lifecycle_status, edge_id)`,
  `create table if not exists companyos_knowledge.syntheses (
    synthesis_id text primary key,
    subject_type text not null,
    subject_id text not null,
    current_version_id text not null,
    access_policy_id text not null default 'policy:quarantine'
      references companyos_knowledge.acl_policies(policy_id),
    lifecycle_status text not null check (lifecycle_status in ('active','superseded','deleted')),
    created_at timestamptz not null default now(),
    unique (subject_type, subject_id)
  )`,
  `create table if not exists companyos_knowledge.synthesis_versions (
    synthesis_version_id text primary key,
    synthesis_id text not null references companyos_knowledge.syntheses(synthesis_id),
    version_number integer not null check (version_number > 0),
    content text not null,
    content_digest text not null,
    supporting_claim_ids jsonb not null,
    contested_claim_ids jsonb not null,
    superseded_claim_ids jsonb not null,
    gaps jsonb not null,
    citations jsonb not null,
    model_provenance jsonb not null,
    access_policy_id text not null default 'policy:quarantine'
      references companyos_knowledge.acl_policies(policy_id),
    synthesized_at timestamptz not null,
    created_at timestamptz not null default now(),
    unique (synthesis_id, version_number),
    unique (synthesis_id, synthesis_version_id)
  )`,
  `do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'knowledge_syntheses_current_version_fk'
        and conrelid = 'companyos_knowledge.syntheses'::regclass) then
        alter table companyos_knowledge.syntheses add constraint knowledge_syntheses_current_version_fk
          foreign key (current_version_id) references companyos_knowledge.synthesis_versions(synthesis_version_id)
          deferrable initially deferred;
      end if;
      if not exists (select 1 from pg_constraint where conname = 'knowledge_syntheses_current_version_parent_fk'
        and conrelid = 'companyos_knowledge.syntheses'::regclass) then
        alter table companyos_knowledge.syntheses add constraint knowledge_syntheses_current_version_parent_fk
          foreign key (synthesis_id, current_version_id)
          references companyos_knowledge.synthesis_versions(synthesis_id, synthesis_version_id)
          deferrable initially deferred;
      end if;
    end $$`,
  `create index if not exists knowledge_synthesis_versions_created_idx
    on companyos_knowledge.synthesis_versions(synthesis_id, synthesized_at desc, synthesis_version_id)`,
  `create table if not exists companyos_knowledge.decision_receipts (
    receipt_id text primary key,
    authority_principal_id text not null,
    authority_role text not null,
    authority_scope jsonb not null,
    decision_type text not null,
    source_digest text not null,
    effect_digest text not null,
    decision text not null check (decision in ('accepted','rejected','superseded','request-more-evidence')),
    evidence jsonb not null,
    decided_at timestamptz not null,
    recorded_at timestamptz not null default now()
  )`,
  `create table if not exists companyos_knowledge.promotion_candidates (
    candidate_id text primary key,
    target_path text not null,
    base_digest text,
    proposed_digest text not null,
    proposed_diff text not null,
    evidence_claim_ids jsonb not null,
    conflict_summary jsonb not null,
    consequence_summary jsonb not null,
    decision_receipt_id text references companyos_knowledge.decision_receipts(receipt_id),
    access_policy_id text not null default 'policy:quarantine'
      references companyos_knowledge.acl_policies(policy_id),
    status text not null check (status in ('proposed','accepted','rejected','superseded','needs-evidence')),
    created_by text not null,
    created_at timestamptz not null default now(),
    decided_at timestamptz
  )`,
  `create index if not exists knowledge_promotion_candidates_queue_idx
    on companyos_knowledge.promotion_candidates(status, created_at, candidate_id)`,
  `create table if not exists companyos_knowledge.sessions (
    session_id text primary key,
    principal_id text not null,
    surface text not null,
    external_session_id text,
    access_policy_id text not null default 'policy:quarantine'
      references companyos_knowledge.acl_policies(policy_id),
    lifecycle_status text not null check (lifecycle_status in ('open','transferred','closed','deleted')),
    archive_status text not null check (archive_status in ('not-requested','requested','archived','failed')),
    started_at timestamptz not null,
    ended_at timestamptz,
    created_at timestamptz not null default now(),
    unique (surface, external_session_id)
  )`,
  `create table if not exists companyos_knowledge.session_corpus (
    corpus_id text primary key,
    session_id text not null references companyos_knowledge.sessions(session_id),
    content text not null,
    content_digest text not null,
    normalized_format text not null,
    access_policy_id text not null default 'policy:quarantine'
      references companyos_knowledge.acl_policies(policy_id),
    lifecycle_status text not null check (lifecycle_status in ('active','expired','deleted','legal-hold')),
    transferred_at timestamptz not null,
    expires_at timestamptz not null,
    archive_receipt_id text,
    deleted_at timestamptz,
    check (expires_at >= transferred_at)
  )`,
  `create index if not exists knowledge_session_corpus_expiry_idx
    on companyos_knowledge.session_corpus(lifecycle_status, expires_at, corpus_id)`,
  `create table if not exists companyos_knowledge.session_cursors (
    cursor_id text primary key,
    consumer_id text not null,
    scope_digest text not null,
    last_sequence bigint not null check (last_sequence >= 0),
    last_event_id text,
    cursor_digest text not null,
    access_policy_id text not null default 'policy:quarantine'
      references companyos_knowledge.acl_policies(policy_id),
    status text not null check (status in ('active','revoked')),
    updated_at timestamptz not null,
    unique (consumer_id, scope_digest)
  )`,
  `create index if not exists knowledge_session_cursors_consumer_idx
    on companyos_knowledge.session_cursors(consumer_id, status, updated_at, cursor_id)`,
  `create table if not exists companyos_knowledge.extraction_runs (
    run_id text primary key,
    run_key text not null unique,
    processor_kind text not null check (processor_kind in ('deterministic','model')),
    pipeline_version text not null,
    prompt_version text,
    schema_version text not null,
    model_route text,
    model_id text,
    input_digest text not null,
    input_manifest jsonb not null,
    output_digest text,
    output_manifest jsonb,
    usage_evidence jsonb,
    authorization_context jsonb not null,
    access_policy_id text not null default 'policy:quarantine'
      references companyos_knowledge.acl_policies(policy_id),
    attempt integer not null check (attempt > 0),
    status text not null check (status in ('queued','running','succeeded','failed','deferred')),
    failure_class text check (failure_class in ('refusal','truncated','parse-failure','provider-failure','budget-deferral','validation-failure')),
    retry_after timestamptz,
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    check (processor_kind <> 'model' or (model_route is not null and model_id is not null and prompt_version is not null)),
    check (status not in ('failed','deferred') or failure_class is not null)
  )`,
  `create index if not exists knowledge_extraction_runs_status_idx
    on companyos_knowledge.extraction_runs(status, retry_after, created_at, run_id)`,
  `create table if not exists companyos_knowledge.brain_export_ledger (
    export_id text primary key,
    manifest_id text not null,
    manifest_version text not null,
    state_digest text not null,
    identity_manifest jsonb not null,
    table_counts jsonb not null,
    cursor_state jsonb not null,
    access_policy_id text not null default 'policy:quarantine'
      references companyos_knowledge.acl_policies(policy_id),
    status text not null check (status in ('started','verified','failed')),
    evidence jsonb not null,
    started_at timestamptz not null,
    completed_at timestamptz
  )`,
  `create index if not exists knowledge_brain_export_ledger_status_idx
    on companyos_knowledge.brain_export_ledger(status, started_at, export_id)`,
] as const;
