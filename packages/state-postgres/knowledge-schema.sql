-- Company Knowledge V1 uses the same Company Instance database as the
-- companyos control plane, but owns an explicitly qualified schema.

create schema if not exists companyos_knowledge;

create table if not exists companyos_knowledge.snapshots (
  snapshot_hash text primary key,
  status text not null check (status in ('staged','verified','active','retired')),
  workspace_commit text not null,
  okf_version text not null,
  policy_hash text not null,
  document_count integer not null,
  fragment_count integer not null,
  bundle jsonb not null,
  staged_at timestamptz not null default now(),
  verified_at timestamptz,
  activated_at timestamptz
);
create unique index if not exists knowledge_one_active_snapshot_idx
  on companyos_knowledge.snapshots ((status)) where status = 'active';

create table if not exists companyos_knowledge.documents (
  snapshot_hash text not null references companyos_knowledge.snapshots(snapshot_hash) on delete cascade,
  path text not null,
  type text not null check (type in ('concept','playbook','note')),
  description text not null,
  title text not null,
  knowledge_status text not null default 'current' check (knowledge_status in ('current','stale','contested')),
  valid_until timestamptz,
  digest text not null,
  document jsonb not null,
  primary key (snapshot_hash, path)
);

create table if not exists companyos_knowledge.fragments (
  snapshot_hash text not null references companyos_knowledge.snapshots(snapshot_hash) on delete cascade,
  fragment_id text not null,
  path text not null,
  heading text not null,
  start_line integer not null,
  end_line integer not null,
  digest text not null,
  body text not null,
  search_vector tsvector generated always as (
    to_tsvector('simple', coalesce(heading, '') || ' ' || coalesce(body, ''))
  ) stored,
  primary key (snapshot_hash, fragment_id),
  foreign key (snapshot_hash, path) references companyos_knowledge.documents(snapshot_hash, path) on delete cascade
);
create index if not exists knowledge_fragments_search_idx
  on companyos_knowledge.fragments using gin(search_vector);

create table if not exists companyos_knowledge.graph_edges (
  snapshot_hash text not null references companyos_knowledge.snapshots(snapshot_hash) on delete cascade,
  from_path text not null,
  to_path text not null,
  primary key (snapshot_hash, from_path, to_path),
  foreign key (snapshot_hash, from_path) references companyos_knowledge.documents(snapshot_hash, path) on delete cascade,
  foreign key (snapshot_hash, to_path) references companyos_knowledge.documents(snapshot_hash, path) on delete cascade
);
create index if not exists knowledge_graph_edges_to_idx
  on companyos_knowledge.graph_edges(snapshot_hash, to_path, from_path);

create table if not exists companyos_knowledge.index_runs (
  run_id uuid primary key default gen_random_uuid(),
  snapshot_hash text not null references companyos_knowledge.snapshots(snapshot_hash),
  status text not null check (status in ('started','verified','failed')),
  evidence jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists companyos_knowledge.review_candidates (
  candidate_id text primary key,
  source_path text not null,
  source_digest text not null,
  route text not null check (route in ('okf','playbook','learning')),
  status text not null check (status in ('pending','accepted','rejected','superseded','quarantined')),
  candidate jsonb not null,
  decision jsonb,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create table if not exists companyos_knowledge.sources (
  source_id text primary key,
  connector_id text not null,
  connector_version text not null,
  requirement jsonb not null,
  binding jsonb not null,
  cursor text,
  cursor_complete boolean not null default false,
  status text not null default 'registered' check (status in ('registered','healthy','stale','error','revoked')),
  health jsonb,
  last_successful_sync timestamptz,
  registered_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists companyos_knowledge.source_receipts (
  receipt_id text primary key,
  source_id text not null references companyos_knowledge.sources(source_id),
  operation text not null check (operation in ('verify','enumerate','fetch','reconcile','revoke','delete')),
  observed_at timestamptz not null,
  receipt jsonb not null,
  recorded_at timestamptz not null default now()
);
create index if not exists knowledge_source_receipts_source_idx
  on companyos_knowledge.source_receipts(source_id, observed_at, receipt_id);

create table if not exists companyos_knowledge.source_object_versions (
  source_id text not null references companyos_knowledge.sources(source_id),
  provider_object_id text not null,
  provider_version text not null,
  content_digest text not null,
  envelope jsonb not null,
  retention_until timestamptz not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  primary key (source_id, provider_object_id, provider_version)
);

create table if not exists companyos_knowledge.source_inventory (
  source_id text not null references companyos_knowledge.sources(source_id),
  provider_object_id text not null,
  current_version text not null,
  deletion_state text not null check (deletion_state in ('present','deleted')),
  last_seen_at timestamptz not null,
  deleted_at timestamptz,
  primary key (source_id, provider_object_id),
  foreign key (source_id, provider_object_id, current_version)
    references companyos_knowledge.source_object_versions(source_id, provider_object_id, provider_version)
);

create table if not exists companyos_knowledge.runtime_observations (
  observation_id text primary key,
  subject text not null,
  content text not null,
  content_digest text not null,
  observed_at timestamptz not null,
  expires_at timestamptz,
  run_id text not null,
  agent_id text not null,
  evidence jsonb not null,
  status text not null check (status in ('active','superseded','expired','deletion-requested','deleted','legal-hold')),
  supersedes text references companyos_knowledge.runtime_observations(observation_id),
  personal_data boolean not null check (personal_data = false),
  deleted_at timestamptz
);
create index if not exists knowledge_observations_status_idx
  on companyos_knowledge.runtime_observations(status, observed_at, observation_id);

create table if not exists companyos_knowledge.observation_events (
  event_id text primary key,
  observation_id text not null references companyos_knowledge.runtime_observations(observation_id),
  event_type text not null,
  actor text not null,
  occurred_at timestamptz not null,
  evidence jsonb not null
);

create table if not exists companyos_knowledge.observation_deletion_requests (
  request_id text primary key,
  observation_id text not null references companyos_knowledge.runtime_observations(observation_id),
  requested_by text not null,
  reason text not null,
  requested_at timestamptz not null,
  applied_at timestamptz
);

create table if not exists companyos_knowledge.observation_legal_holds (
  observation_id text primary key references companyos_knowledge.runtime_observations(observation_id),
  actor text not null,
  enabled_at timestamptz not null,
  released_at timestamptz
);

-- Additive Company Brain foundation. Page types are registry rows rather than
-- a database enum so compatible extension and legacy types do not require a
-- schema rewrite.
create table if not exists companyos_knowledge.page_type_registry (
  type_key text primary key,
  taxonomy_version text not null,
  display_label text not null,
  parent_key text references companyos_knowledge.page_type_registry(type_key),
  extraction_profile text not null,
  origin text not null check (origin in ('core','extension','legacy')),
  lifecycle_status text not null check (lifecycle_status in ('active','deprecated')),
  definition jsonb not null,
  registered_at timestamptz not null default now()
);

insert into companyos_knowledge.page_type_registry
  (type_key, taxonomy_version, display_label, extraction_profile, origin, lifecycle_status, definition)
values
  ('person', '1.0.0', 'Person', 'identity', 'core', 'active', '{}'::jsonb),
  ('company', '1.0.0', 'Company', 'identity', 'core', 'active', '{}'::jsonb),
  ('media', '1.0.0', 'Media', 'media', 'core', 'active', '{}'::jsonb),
  ('tweet', '1.0.0', 'Tweet', 'social-item', 'core', 'active', '{}'::jsonb),
  ('social-digest', '1.0.0', 'Social digest', 'social-digest', 'core', 'active', '{}'::jsonb),
  ('analysis', '1.0.0', 'Analysis', 'analysis', 'core', 'active', '{}'::jsonb),
  ('atom', '1.0.0', 'Atom', 'atomic', 'core', 'active', '{}'::jsonb),
  ('concept', '1.0.0', 'Concept', 'concept', 'core', 'active', '{}'::jsonb),
  ('source', '1.0.0', 'Source', 'source', 'core', 'active', '{}'::jsonb),
  ('deal', '1.0.0', 'Deal', 'commercial', 'core', 'active', '{}'::jsonb),
  ('email', '1.0.0', 'Email', 'message', 'core', 'active', '{}'::jsonb),
  ('slack', '1.0.0', 'Slack', 'message', 'core', 'active', '{}'::jsonb),
  ('meeting', '1.0.0', 'Meeting', 'transcript', 'core', 'active', '{}'::jsonb),
  ('conversation', '1.0.0', 'Conversation', 'transcript', 'core', 'active', '{}'::jsonb),
  ('writing', '1.0.0', 'Writing', 'document', 'core', 'active', '{}'::jsonb),
  ('project', '1.0.0', 'Project', 'project', 'core', 'active', '{}'::jsonb),
  ('note', '1.0.0', 'Note', 'note', 'core', 'active', '{}'::jsonb),
  ('event', '1.0.0', 'Event', 'event', 'core', 'active', '{}'::jsonb),
  ('diary', '1.0.0', 'Diary', 'chronology', 'core', 'active', '{}'::jsonb)
on conflict (type_key) do nothing;

create table if not exists companyos_knowledge.page_type_aliases (
  alias text primary key,
  type_key text not null references companyos_knowledge.page_type_registry(type_key),
  mapping_evidence jsonb not null,
  registered_at timestamptz not null default now(),
  check (alias <> type_key)
);

create table if not exists companyos_knowledge.pages (
  page_id text primary key,
  page_type_key text not null references companyos_knowledge.page_type_registry(type_key),
  source_id text not null,
  source_page_key text not null,
  current_version_id text not null,
  verification_status text not null check (verification_status in ('unverified','verified','rejected')),
  verification_evidence jsonb,
  access_policy_id text not null,
  lifecycle_status text not null check (lifecycle_status in ('active','superseded','forgotten','deleted')),
  created_at timestamptz not null,
  unique (source_id, source_page_key)
);

create table if not exists companyos_knowledge.page_versions (
  page_version_id text primary key,
  page_id text not null references companyos_knowledge.pages(page_id),
  version_number integer not null check (version_number > 0),
  title text not null,
  summary text,
  body text not null,
  metadata jsonb not null,
  content_digest text not null,
  observed_at timestamptz not null,
  created_at timestamptz not null,
  source_object_id text not null,
  source_object_version text not null,
  access_policy_id text not null,
  model_provenance jsonb,
  unique (page_id, version_number),
  unique (page_id, page_version_id)
);
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'knowledge_pages_current_version_fk'
      and conrelid = 'companyos_knowledge.pages'::regclass
  ) then
    alter table companyos_knowledge.pages
      add constraint knowledge_pages_current_version_fk
      foreign key (current_version_id)
      references companyos_knowledge.page_versions(page_version_id)
      deferrable initially deferred;
  end if;
end $$;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'knowledge_pages_current_version_page_fk'
      and conrelid = 'companyos_knowledge.pages'::regclass
  ) then
    alter table companyos_knowledge.pages
      add constraint knowledge_pages_current_version_page_fk
      foreign key (page_id, current_version_id)
      references companyos_knowledge.page_versions(page_id, page_version_id)
      deferrable initially deferred;
  end if;
end $$;
create index if not exists knowledge_page_versions_observed_idx
  on companyos_knowledge.page_versions(page_id, observed_at desc, page_version_id);

create table if not exists companyos_knowledge.entity_identities (
  entity_id text primary key,
  entity_kind text not null check (entity_kind in ('person','organization','project','deal','concept','other')),
  stable_key text not null,
  display_name text not null,
  creation_basis text not null check (creation_basis in ('provider-identifier','administrator-mapping','review-decision')),
  creation_receipt_id text not null,
  lifecycle_status text not null check (lifecycle_status in ('active','merged','deleted')),
  created_at timestamptz not null,
  unique (entity_kind, stable_key)
);

create table if not exists companyos_knowledge.entity_identity_members (
  membership_id text primary key,
  entity_id text not null references companyos_knowledge.entity_identities(entity_id),
  page_id text not null references companyos_knowledge.pages(page_id),
  proof_basis text not null check (proof_basis in ('provider-identifier','administrator-mapping','deterministic-rule','review-decision')),
  proof_receipt_id text not null,
  page_access_policy_id text not null,
  status text not null check (status in ('active','revoked')),
  created_at timestamptz not null,
  unique (page_id)
);
create index if not exists knowledge_entity_members_entity_idx
  on companyos_knowledge.entity_identity_members(entity_id, created_at, membership_id);

create table if not exists companyos_knowledge.entity_identity_proposals (
  proposal_id text primary key,
  candidate_page_id text not null references companyos_knowledge.pages(page_id),
  target_entity_id text not null references companyos_knowledge.entity_identities(entity_id),
  method text not null check (method in ('name-similarity','embedding-similarity','model-judgment')),
  score numeric(5,4) check (score between 0 and 1),
  rationale text not null,
  evidence_receipt_ids jsonb not null,
  candidate_access_policy_id text not null,
  created_by text not null,
  created_at timestamptz not null,
  model_provenance jsonb,
  status text not null check (status in ('proposed','accepted','rejected')),
  decision_id text unique,
  decision jsonb,
  decided_at timestamptz
);
create index if not exists knowledge_entity_proposals_queue_idx
  on companyos_knowledge.entity_identity_proposals(status, created_at, proposal_id);

create table if not exists companyos_knowledge.holders (
  holder_id text primary key,
  holder_type text not null check (holder_type in ('person','team','company','world','system','unresolved')),
  display_name text not null,
  identity_evidence jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists companyos_knowledge.claims (
  claim_id text primary key,
  memory_class text not null check (memory_class in ('fact','take')),
  claim_kind text not null check (claim_kind in ('event','preference','commitment','belief','fact','take','bet','hunch')),
  claim_text text not null,
  owner_principal_id text,
  fact_scope jsonb,
  primary_holder_id text references companyos_knowledge.holders(holder_id),
  source_basis text not null check (source_basis in ('principal-memory','source-literal','fact-consolidation','model-derived','holder-accepted')),
  status text not null check (status in ('proposed','active','superseded','expired','resolved','forgotten','contested','deleted')),
  observed_at timestamptz not null,
  valid_from timestamptz,
  valid_until timestamptz,
  extraction_confidence numeric(5,4) not null check (extraction_confidence between 0 and 1),
  epistemic_weight numeric(5,4) not null check (epistemic_weight between 0 and 1),
  access_policy_id text not null,
  created_by text not null,
  model_provenance jsonb,
  unresolved_evidence_reason text,
  consolidation_receipt_id text,
  activation_receipt_id text,
  supersedes_claim_id text references companyos_knowledge.claims(claim_id),
  created_at timestamptz not null default now(),
  check ((memory_class = 'fact' and owner_principal_id is not null and fact_scope is not null and primary_holder_id is null)
    or (memory_class = 'take' and owner_principal_id is null and fact_scope is null and primary_holder_id is not null)),
  check (source_basis <> 'model-derived' or status = 'proposed'),
  check (valid_until is null or valid_from is null or valid_until >= valid_from)
);
alter table companyos_knowledge.claims add column if not exists unresolved_evidence_reason text;
alter table companyos_knowledge.claims add column if not exists consolidation_receipt_id text;
alter table companyos_knowledge.claims add column if not exists activation_receipt_id text;
create index if not exists knowledge_claims_current_idx
  on companyos_knowledge.claims(status, memory_class, observed_at desc, claim_id);
create index if not exists knowledge_claims_holder_idx
  on companyos_knowledge.claims(primary_holder_id, observed_at desc, claim_id)
  where primary_holder_id is not null;

create table if not exists companyos_knowledge.claim_evidence (
  claim_id text not null references companyos_knowledge.claims(claim_id),
  evidence_id text not null,
  source_id text not null,
  provider_object_id text not null,
  provider_version text not null,
  page_id text references companyos_knowledge.pages(page_id),
  page_version_id text references companyos_knowledge.page_versions(page_version_id),
  content_digest text not null,
  observed_at timestamptz not null,
  locator jsonb not null,
  primary key (claim_id, evidence_id)
);
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'knowledge_claim_evidence_page_version_fk'
      and conrelid = 'companyos_knowledge.claim_evidence'::regclass
  ) then
    alter table companyos_knowledge.claim_evidence
      add constraint knowledge_claim_evidence_page_version_fk
      foreign key (page_id, page_version_id)
      references companyos_knowledge.page_versions(page_id, page_version_id);
  end if;
end $$;

create table if not exists companyos_knowledge.claim_relations (
  claim_id text not null references companyos_knowledge.claims(claim_id),
  relation_type text not null check (relation_type in ('speaker','author','subject','approver','owner','beneficiary','affected-party')),
  entity_type text not null,
  entity_id text not null,
  evidence jsonb not null,
  primary key (claim_id, relation_type, entity_type, entity_id)
);

create table if not exists companyos_knowledge.claim_consolidations (
  receipt_id text primary key,
  fact_claim_id text not null references companyos_knowledge.claims(claim_id),
  take_claim_id text not null references companyos_knowledge.claims(claim_id),
  rule_version text not null,
  evidence jsonb not null,
  consolidated_at timestamptz not null,
  check (fact_claim_id <> take_claim_id)
);

create table if not exists companyos_knowledge.claim_resolution_proposals (
  proposal_id text primary key,
  claim_id text not null references companyos_knowledge.claims(claim_id),
  outcome text not null check (outcome in ('correct','incorrect','partial','unresolvable')),
  outcome_evidence jsonb not null,
  judge_receipt_id text not null,
  proposed_by text not null,
  proposed_at timestamptz not null,
  status text not null default 'proposed' check (status in ('proposed','accepted','rejected','superseded')),
  decision jsonb,
  decided_at timestamptz
);

-- Complete Phase 1 storage foundation. Authorization behavior is enabled only
-- after the Phase 2 conformance gate; unresolved and legacy policy identities
-- are represented fail-closed meanwhile.
create table if not exists companyos_knowledge.acl_policies (
  policy_id text primary key,
  policy_version integer not null check (policy_version > 0),
  visibility text not null check (visibility in ('public','company','team','restricted_group','individual','private')),
  parent_policy_id text references companyos_knowledge.acl_policies(policy_id),
  source_root boolean not null default false,
  status text not null check (status in ('active','quarantined','revoked')),
  definition jsonb not null,
  created_by text not null,
  created_at timestamptz not null default now()
);

insert into companyos_knowledge.acl_policies
  (policy_id, policy_version, visibility, source_root, status, definition, created_by)
values
  ('policy:quarantine', 1, 'private', true, 'quarantined',
    '{"reason":"unresolved-or-unmapped-access-policy"}'::jsonb, 'system:schema-upgrade'),
  ('policy:company-handbook', 1, 'company', true, 'active',
    '{"authority_layer":"handbook"}'::jsonb, 'system:schema-upgrade')
on conflict (policy_id) do nothing;

create table if not exists companyos_knowledge.acl_entries (
  entry_id text primary key,
  policy_id text not null references companyos_knowledge.acl_policies(policy_id),
  subject_kind text not null check (subject_kind in ('principal','group')),
  subject_id text not null,
  permission text not null check (permission in ('read','review','write','promote','admin')),
  effect text not null check (effect in ('allow','deny')),
  evidence jsonb not null,
  created_at timestamptz not null default now(),
  unique (policy_id, subject_kind, subject_id, permission)
);
create index if not exists knowledge_acl_entries_subject_idx
  on companyos_knowledge.acl_entries(subject_kind, subject_id, permission, policy_id);

create table if not exists companyos_knowledge.external_principals (
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
);
create index if not exists knowledge_external_principals_canonical_idx
  on companyos_knowledge.external_principals(canonical_principal_id, mapping_status)
  where canonical_principal_id is not null;

alter table companyos_knowledge.sources
  add column if not exists access_policy_id text not null default 'policy:quarantine';
alter table companyos_knowledge.sources
  add column if not exists provider_acl jsonb not null default '{}'::jsonb;
alter table companyos_knowledge.source_object_versions
  add column if not exists access_policy_id text not null default 'policy:quarantine';
alter table companyos_knowledge.source_object_versions
  add column if not exists provider_acl jsonb not null default '{}'::jsonb;
alter table companyos_knowledge.source_object_versions
  add column if not exists provider_locator text;
alter table companyos_knowledge.source_object_versions
  add column if not exists byte_size bigint check (byte_size is null or byte_size >= 0);
alter table companyos_knowledge.source_object_versions
  add column if not exists mime_type text;
alter table companyos_knowledge.source_object_versions
  add column if not exists encoding text;
alter table companyos_knowledge.documents
  add column if not exists access_policy_id text not null default 'policy:company-handbook';
alter table companyos_knowledge.fragments
  add column if not exists access_policy_id text not null default 'policy:company-handbook';
alter table companyos_knowledge.review_candidates
  add column if not exists access_policy_id text not null default 'policy:quarantine';
alter table companyos_knowledge.runtime_observations
  add column if not exists access_policy_id text not null default 'policy:quarantine';
alter table companyos_knowledge.claim_evidence
  add column if not exists access_policy_id text not null default 'policy:quarantine';
alter table companyos_knowledge.claims
  add column if not exists notability numeric(5,4) not null default 0.5000 check (notability between 0 and 1);
alter table companyos_knowledge.claims add column if not exists typed_value jsonb;
alter table companyos_knowledge.claims add column if not exists ontology_mapping jsonb;
alter table companyos_knowledge.claims
  add column if not exists resolution_outcome text check (resolution_outcome in ('correct','incorrect','partial','unresolvable'));
alter table companyos_knowledge.claims add column if not exists resolution_evidence jsonb;
alter table companyos_knowledge.claims add column if not exists resolved_at timestamptz;
alter table companyos_knowledge.claims
  add column if not exists superseded_by_claim_id text references companyos_knowledge.claims(claim_id);

insert into companyos_knowledge.acl_policies
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
on conflict (policy_id) do nothing;

do $$
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
end $$;

create table if not exists companyos_knowledge.raw_assets (
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
);
create index if not exists knowledge_raw_assets_source_idx
  on companyos_knowledge.raw_assets(source_id, provider_object_id, provider_version);

create table if not exists companyos_knowledge.merge_ledger (
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
);
create index if not exists knowledge_merge_ledger_status_idx
  on companyos_knowledge.merge_ledger(status, merge_kind, created_at, merge_id);

create table if not exists companyos_knowledge.calibration_profiles (
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
);

create table if not exists companyos_knowledge.timeline_events (
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
);
create index if not exists knowledge_timeline_subject_idx
  on companyos_knowledge.timeline_events(subject_type, subject_id, observed_at, event_id);

create table if not exists companyos_knowledge.knowledge_edges (
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
);
create index if not exists knowledge_edges_from_idx
  on companyos_knowledge.knowledge_edges(from_type, from_id, edge_type, lifecycle_status, edge_id);
create index if not exists knowledge_edges_to_idx
  on companyos_knowledge.knowledge_edges(to_type, to_id, edge_type, lifecycle_status, edge_id);

create table if not exists companyos_knowledge.syntheses (
  synthesis_id text primary key,
  subject_type text not null,
  subject_id text not null,
  current_version_id text not null,
  access_policy_id text not null default 'policy:quarantine'
    references companyos_knowledge.acl_policies(policy_id),
  lifecycle_status text not null check (lifecycle_status in ('active','superseded','deleted')),
  created_at timestamptz not null default now(),
  unique (subject_type, subject_id)
);
create table if not exists companyos_knowledge.synthesis_versions (
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
);
do $$
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
end $$;
create index if not exists knowledge_synthesis_versions_created_idx
  on companyos_knowledge.synthesis_versions(synthesis_id, synthesized_at desc, synthesis_version_id);

create table if not exists companyos_knowledge.decision_receipts (
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
);
create table if not exists companyos_knowledge.promotion_candidates (
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
);
create index if not exists knowledge_promotion_candidates_queue_idx
  on companyos_knowledge.promotion_candidates(status, created_at, candidate_id);

create table if not exists companyos_knowledge.sessions (
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
);
create table if not exists companyos_knowledge.session_corpus (
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
);
create index if not exists knowledge_session_corpus_expiry_idx
  on companyos_knowledge.session_corpus(lifecycle_status, expires_at, corpus_id);
create table if not exists companyos_knowledge.session_cursors (
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
);
create index if not exists knowledge_session_cursors_consumer_idx
  on companyos_knowledge.session_cursors(consumer_id, status, updated_at, cursor_id);

create table if not exists companyos_knowledge.extraction_runs (
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
);
create index if not exists knowledge_extraction_runs_status_idx
  on companyos_knowledge.extraction_runs(status, retry_after, created_at, run_id);

create table if not exists companyos_knowledge.brain_export_ledger (
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
);
create index if not exists knowledge_brain_export_ledger_status_idx
  on companyos_knowledge.brain_export_ledger(status, started_at, export_id);

-- Company Knowledge Phase 3C: shared Source ingestion pipeline.
create table if not exists companyos_knowledge.source_events (
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
);
create index if not exists knowledge_source_events_queue_idx
  on companyos_knowledge.source_events(status, retry_after, lease_until, observed_at, event_id);
create index if not exists knowledge_source_events_object_idx
  on companyos_knowledge.source_events(source_id, provider_object_id, observed_at, event_id);

create table if not exists companyos_knowledge.source_acl_snapshots (
  source_id text not null references companyos_knowledge.sources(source_id),
  provider_object_id text not null,
  provider_access_version text not null,
  observed_at timestamptz not null,
  evidence_digest text not null,
  snapshot jsonb not null,
  recorded_at timestamptz not null default now(),
  primary key (source_id, provider_object_id, provider_access_version)
);
create index if not exists knowledge_source_acl_object_idx
  on companyos_knowledge.source_acl_snapshots(source_id, provider_object_id, observed_at desc, provider_access_version);

create table if not exists companyos_knowledge.source_pipeline_receipts (
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
);
create index if not exists knowledge_source_pipeline_receipts_source_idx
  on companyos_knowledge.source_pipeline_receipts(source_id, observed_at, receipt_id);

create table if not exists companyos_knowledge.source_watermarks (
  source_id text not null references companyos_knowledge.sources(source_id),
  stream_id text not null,
  cursor_value text,
  watermark_value text,
  completed boolean not null,
  state_digest text not null,
  updated_at timestamptz not null,
  primary key (source_id, stream_id)
);

create table if not exists companyos_knowledge.source_sync_leases (
  source_id text not null references companyos_knowledge.sources(source_id),
  stream_id text not null,
  lease_owner text not null,
  acquired_at timestamptz not null,
  lease_until timestamptz not null,
  primary key (source_id, stream_id),
  check (lease_until > acquired_at)
);
create index if not exists knowledge_source_sync_leases_due_idx
  on companyos_knowledge.source_sync_leases(lease_until, source_id, stream_id);

create table if not exists companyos_knowledge.knowledge_change_stream (
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
);
create index if not exists knowledge_change_stream_source_idx
  on companyos_knowledge.knowledge_change_stream(source_id, sequence, change_id);
create unique index if not exists knowledge_change_stream_previous_idx
  on companyos_knowledge.knowledge_change_stream(previous_digest) where previous_digest is not null;
create unique index if not exists knowledge_change_stream_genesis_idx
  on companyos_knowledge.knowledge_change_stream ((1)) where previous_digest is null;

create table if not exists companyos_knowledge.source_lifecycle_requests (
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
);
create index if not exists knowledge_source_lifecycle_due_idx
  on companyos_knowledge.source_lifecycle_requests(status, legal_hold, purge_after, request_id);

create table if not exists companyos_knowledge.session_lifecycle_receipts (
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
);
create index if not exists knowledge_session_lifecycle_receipts_session_idx
  on companyos_knowledge.session_lifecycle_receipts(session_id, occurred_at, receipt_id);

alter table companyos_knowledge.source_object_versions add column if not exists event_id text;
alter table companyos_knowledge.source_object_versions add column if not exists provider_tenant_id text;
alter table companyos_knowledge.source_object_versions add column if not exists provider_access_version text;
alter table companyos_knowledge.source_object_versions add column if not exists sanity_codes jsonb not null default '[]'::jsonb;
alter table companyos_knowledge.source_object_versions add column if not exists model_ready boolean not null default false;
alter table companyos_knowledge.source_object_versions add column if not exists payload_state text not null default 'active';
alter table companyos_knowledge.source_object_versions add column if not exists redacted_at timestamptz;
do $$
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
end $$;

create table if not exists companyos_knowledge.principal_groups (
  group_id text primary key,
  display_name text not null,
  group_status text not null check (group_status in ('active','revoked')),
  definition jsonb not null,
  created_by text not null,
  created_at timestamptz not null default now()
);
insert into companyos_knowledge.principal_groups
  (group_id, display_name, group_status, definition, created_by)
  values ('companyos:knowledge-admin', 'Company Knowledge administrators', 'active',
    '{"reserved":true,"purpose":"quarantine-administration"}'::jsonb, 'system:schema-upgrade')
  on conflict (group_id) do nothing;
create table if not exists companyos_knowledge.principal_group_members (
  membership_id text primary key,
  group_id text not null references companyos_knowledge.principal_groups(group_id),
  principal_id text not null,
  membership_status text not null check (membership_status in ('active','revoked')),
  evidence jsonb not null,
  granted_by text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (group_id, principal_id)
);
create index if not exists knowledge_principal_group_members_principal_idx
  on companyos_knowledge.principal_group_members(principal_id, membership_status, group_id);
insert into companyos_knowledge.acl_entries
  (entry_id, policy_id, subject_kind, subject_id, permission, effect, evidence)
  values ('acl:quarantine:knowledge-admin', 'policy:quarantine', 'group',
    'companyos:knowledge-admin', 'admin', 'allow',
    '{"reserved":true,"reason":"administrator-only-quarantine"}'::jsonb)
  on conflict (entry_id) do nothing;
create table if not exists companyos_knowledge.access_decision_events (
  decision_id text primary key,
  decided_at timestamptz not null,
  principal_id text not null,
  principal_type text not null check (principal_type in ('human','agent','service')),
  group_ids jsonb not null,
  permission text not null check (permission in ('read','review','write','promote','admin')),
  policy_ids jsonb not null,
  object_type text not null check (object_type in ('document','graph','review-candidate','model-context','policy')),
  object_id_hash text not null,
  outcome text not null check (outcome in ('permit','deny')),
  reason text not null,
  recorded_at timestamptz not null default now()
);
create index if not exists knowledge_access_decisions_principal_idx
  on companyos_knowledge.access_decision_events(principal_id, decided_at desc, decision_id);
create index if not exists knowledge_access_decisions_outcome_idx
  on companyos_knowledge.access_decision_events(outcome, decided_at desc, decision_id);

create table if not exists companyos_knowledge.compounding_leases (
  phase text not null,
  scope text not null check (scope in ('source','mixed','global')),
  scope_id text not null,
  lease_owner text not null,
  acquired_at timestamptz not null,
  lease_until timestamptz not null,
  primary key (phase, scope, scope_id),
  check (lease_until > acquired_at)
);
create index if not exists knowledge_compounding_leases_due_idx
  on companyos_knowledge.compounding_leases(lease_until, phase, scope, scope_id);

create table if not exists companyos_knowledge.compounding_receipts (
  idempotency_key text primary key,
  receipt_id text not null unique,
  cycle_id text not null,
  phase text not null,
  scope text not null check (scope in ('source','mixed','global')),
  scope_id text not null,
  processed integer not null check (processed >= 0),
  complete boolean not null,
  continuation text,
  evidence_digest text not null,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  receipt jsonb not null,
  recorded_at timestamptz not null default now(),
  check (completed_at >= started_at)
);
create index if not exists knowledge_compounding_receipts_cycle_idx
  on companyos_knowledge.compounding_receipts(cycle_id, phase, scope_id, completed_at, receipt_id);

create table if not exists companyos_knowledge.claim_pair_proposals (
  proposal_id text primary key,
  left_claim_id text not null references companyos_knowledge.claims(claim_id),
  right_claim_id text not null references companyos_knowledge.claims(claim_id),
  proposal_kind text not null check (proposal_kind in ('duplicate','relation','conflict')),
  judgment text not null,
  severity text,
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  rationale text not null,
  details jsonb not null,
  model_receipt_id text not null,
  prompt_identity text not null,
  access_policy_id text not null references companyos_knowledge.acl_policies(policy_id),
  status text not null default 'proposed' check (status in ('proposed','accepted','rejected','superseded')),
  created_at timestamptz not null,
  check (left_claim_id <> right_claim_id)
);
create index if not exists knowledge_claim_pair_proposals_queue_idx
  on companyos_knowledge.claim_pair_proposals(status, proposal_kind, created_at, proposal_id);

create table if not exists companyos_knowledge.claim_grading_requests (
  request_id text primary key,
  claim_id text not null references companyos_knowledge.claims(claim_id),
  outcome_evidence_ids jsonb not null,
  requested_by text not null,
  requested_at timestamptz not null,
  access_policy_id text not null references companyos_knowledge.acl_policies(policy_id),
  status text not null default 'pending' check (status in ('pending','processed','deferred','cancelled')),
  result_proposal_id text references companyos_knowledge.claim_resolution_proposals(proposal_id),
  result_receipt_id text,
  updated_at timestamptz not null default now()
);
create index if not exists knowledge_claim_grading_requests_queue_idx
  on companyos_knowledge.claim_grading_requests(status, requested_at, request_id);

create table if not exists companyos_knowledge.model_task_results (
  cache_key text primary key,
  task text not null,
  prompt_id text not null,
  prompt_version text not null,
  prompt_content_hash text not null,
  input_digest text not null,
  authorization_context_digest text not null,
  data_class text not null check (data_class in ('business','confidential','restricted','personal')),
  route text not null,
  model text not null,
  profile_version text not null,
  access_policy_id text not null references companyos_knowledge.acl_policies(policy_id),
  output jsonb not null,
  execution_receipt jsonb not null,
  created_at timestamptz not null,
  last_used_at timestamptz not null,
  hit_count bigint not null default 0 check (hit_count >= 0)
);
create index if not exists knowledge_model_task_results_policy_idx
  on companyos_knowledge.model_task_results(access_policy_id, task, last_used_at, cache_key);

create table if not exists companyos_knowledge.model_spend_reservations (
  reservation_id text primary key,
  cycle_id text not null,
  cache_key text not null,
  task text not null,
  route text not null,
  model text not null,
  access_policy_id text not null references companyos_knowledge.acl_policies(policy_id),
  estimated_cost_usd numeric(14,8) not null check (estimated_cost_usd >= 0),
  charged_cost_usd numeric(14,8) check (charged_cost_usd >= 0),
  pricing_version text not null,
  status text not null check (status in ('reserved','succeeded','failed')),
  reserved_at timestamptz not null,
  completed_at timestamptz,
  failure_digest text,
  unique (cycle_id, cache_key),
  check ((status = 'reserved' and completed_at is null)
    or (status <> 'reserved' and completed_at is not null))
);
create index if not exists knowledge_model_spend_reservations_budget_idx
  on companyos_knowledge.model_spend_reservations(reserved_at, cycle_id, status, reservation_id);

create table if not exists companyos_knowledge.model_execution_ledger (
  receipt_id text primary key,
  reservation_id text not null unique references companyos_knowledge.model_spend_reservations(reservation_id),
  cache_key text not null references companyos_knowledge.model_task_results(cache_key),
  cycle_id text not null,
  task text not null,
  prompt_id text not null,
  route text not null,
  model text not null,
  input_tokens integer not null check (input_tokens >= 0),
  output_tokens integer not null check (output_tokens >= 0),
  cost_usd numeric(14,8) not null check (cost_usd >= 0),
  pricing_version text not null,
  outcome text not null check (outcome in ('succeeded','refused','truncated','failed')),
  access_policy_id text not null references companyos_knowledge.acl_policies(policy_id),
  completed_at timestamptz not null,
  receipt jsonb not null
);
create index if not exists knowledge_model_execution_ledger_spend_idx
  on companyos_knowledge.model_execution_ledger(completed_at, cycle_id, task, route, model, receipt_id);
