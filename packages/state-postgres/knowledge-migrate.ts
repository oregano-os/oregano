import { neon } from "@neondatabase/serverless";
import { COMPANY_BRAIN_PHASE_ONE_SCHEMA_STATEMENTS } from "./knowledge-schema-phase-one.ts";
import { COMPANY_BRAIN_PHASE_TWO_SCHEMA_STATEMENTS } from "./knowledge-schema-phase-two.ts";
import { COMPANY_KNOWLEDGE_PHASE_THREE_SCHEMA_STATEMENTS } from "./knowledge-schema-phase-three.ts";
import { COMPANY_KNOWLEDGE_PHASE_FOUR_SCHEMA_STATEMENTS } from "./knowledge-schema-phase-four.ts";
import { COMPANY_KNOWLEDGE_PHASE_FIVE_SCHEMA_STATEMENTS } from "./knowledge-schema-phase-five.ts";
import { COMPANY_KNOWLEDGE_PHASE_SIX_SCHEMA_STATEMENTS } from "./knowledge-schema-phase-six.ts";
import { COMPANY_KNOWLEDGE_PHASE_SEVEN_SCHEMA_STATEMENTS } from "./knowledge-schema-phase-seven.ts";

export interface CompanyKnowledgeSchemaFeatures { vector: boolean }

let migration: Promise<CompanyKnowledgeSchemaFeatures> | undefined;

const databaseUrl = (): string => {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is not set — Company Knowledge uses the existing Company Instance Neon database.");
  return value;
};

export function ensureCompanyKnowledgeSchema(): Promise<CompanyKnowledgeSchemaFeatures> {
  migration ??= (async () => {
    const sql = neon(databaseUrl());
    await sql`create schema if not exists companyos_knowledge`;
    await sql`create table if not exists companyos_knowledge.snapshots (
      snapshot_hash text primary key,
      status text not null check (status in ('staged','verified','active','retired')),
      workspace_commit text not null, okf_version text not null, policy_hash text not null,
      document_count integer not null, fragment_count integer not null, bundle jsonb not null,
      staged_at timestamptz not null default now(), verified_at timestamptz, activated_at timestamptz)`;
    await sql`create unique index if not exists knowledge_one_active_snapshot_idx
      on companyos_knowledge.snapshots ((status)) where status = 'active'`;
    await sql`create table if not exists companyos_knowledge.documents (
      snapshot_hash text not null references companyos_knowledge.snapshots(snapshot_hash) on delete cascade,
      path text not null, type text not null check (type in ('concept','playbook','note')),
      description text not null, title text not null,
      knowledge_status text not null default 'current' check (knowledge_status in ('current','stale','contested')),
      valid_until timestamptz, digest text not null, document jsonb not null,
      primary key (snapshot_hash, path))`;
    await sql`alter table companyos_knowledge.documents add column if not exists knowledge_status text not null default 'current'`;
    await sql`alter table companyos_knowledge.documents add column if not exists valid_until timestamptz`;
    await sql`create table if not exists companyos_knowledge.fragments (
      snapshot_hash text not null references companyos_knowledge.snapshots(snapshot_hash) on delete cascade,
      fragment_id text not null, path text not null, heading text not null,
      start_line integer not null, end_line integer not null, digest text not null, body text not null,
      search_vector tsvector generated always as (to_tsvector('simple', coalesce(heading, '') || ' ' || coalesce(body, ''))) stored,
      primary key (snapshot_hash, fragment_id),
      foreign key (snapshot_hash, path) references companyos_knowledge.documents(snapshot_hash, path) on delete cascade)`;
    await sql`create index if not exists knowledge_fragments_search_idx on companyos_knowledge.fragments using gin(search_vector)`;
    await sql`create table if not exists companyos_knowledge.graph_edges (
      snapshot_hash text not null references companyos_knowledge.snapshots(snapshot_hash) on delete cascade,
      from_path text not null, to_path text not null,
      primary key (snapshot_hash, from_path, to_path),
      foreign key (snapshot_hash, from_path) references companyos_knowledge.documents(snapshot_hash, path) on delete cascade,
      foreign key (snapshot_hash, to_path) references companyos_knowledge.documents(snapshot_hash, path) on delete cascade)`;
    await sql`create index if not exists knowledge_graph_edges_to_idx on companyos_knowledge.graph_edges(snapshot_hash, to_path, from_path)`;
    await sql`create table if not exists companyos_knowledge.index_runs (
      run_id uuid primary key default gen_random_uuid(), snapshot_hash text not null references companyos_knowledge.snapshots(snapshot_hash),
      status text not null check (status in ('started','verified','failed')), evidence jsonb,
      started_at timestamptz not null default now(), completed_at timestamptz)`;
    await sql`create table if not exists companyos_knowledge.review_candidates (
      candidate_id text primary key, source_path text not null, source_digest text not null,
      route text not null check (route in ('okf','playbook','learning')),
      status text not null check (status in ('pending','accepted','rejected','superseded','quarantined')),
      candidate jsonb not null, decision jsonb, created_at timestamptz not null default now(), decided_at timestamptz)`;
    await sql`create table if not exists companyos_knowledge.sources (
      source_id text primary key, connector_id text not null, connector_version text not null,
      requirement jsonb not null, binding jsonb not null, cursor text, cursor_complete boolean not null default false,
      status text not null default 'registered' check (status in ('registered','healthy','stale','error','revoked')),
      health jsonb, last_successful_sync timestamptz, registered_at timestamptz not null default now(), updated_at timestamptz not null default now())`;
    await sql`create table if not exists companyos_knowledge.source_receipts (
      receipt_id text primary key, source_id text not null references companyos_knowledge.sources(source_id),
      operation text not null check (operation in ('verify','enumerate','fetch','reconcile','revoke','delete')),
      observed_at timestamptz not null, receipt jsonb not null, recorded_at timestamptz not null default now())`;
    await sql`create index if not exists knowledge_source_receipts_source_idx on companyos_knowledge.source_receipts(source_id, observed_at, receipt_id)`;
    await sql`create table if not exists companyos_knowledge.source_object_versions (
      source_id text not null references companyos_knowledge.sources(source_id), provider_object_id text not null,
      provider_version text not null, content_digest text not null, envelope jsonb not null,
      retention_until timestamptz not null, first_seen_at timestamptz not null, last_seen_at timestamptz not null,
      primary key (source_id, provider_object_id, provider_version))`;
    await sql`create table if not exists companyos_knowledge.source_inventory (
      source_id text not null references companyos_knowledge.sources(source_id), provider_object_id text not null,
      current_version text not null, deletion_state text not null check (deletion_state in ('present','deleted')),
      last_seen_at timestamptz not null, deleted_at timestamptz, primary key (source_id, provider_object_id),
      foreign key (source_id, provider_object_id, current_version)
        references companyos_knowledge.source_object_versions(source_id, provider_object_id, provider_version))`;
    await sql`create table if not exists companyos_knowledge.runtime_observations (
      observation_id text primary key, subject text not null, content text not null, content_digest text not null,
      observed_at timestamptz not null, expires_at timestamptz, run_id text not null, agent_id text not null,
      evidence jsonb not null, status text not null check (status in ('active','superseded','expired','deletion-requested','deleted','legal-hold')),
      supersedes text references companyos_knowledge.runtime_observations(observation_id), personal_data boolean not null check (personal_data = false), deleted_at timestamptz)`;
    await sql`create index if not exists knowledge_observations_status_idx on companyos_knowledge.runtime_observations(status, observed_at, observation_id)`;
    await sql`create table if not exists companyos_knowledge.observation_events (
      event_id text primary key, observation_id text not null references companyos_knowledge.runtime_observations(observation_id),
      event_type text not null, actor text not null, occurred_at timestamptz not null, evidence jsonb not null)`;
    await sql`create table if not exists companyos_knowledge.observation_deletion_requests (
      request_id text primary key, observation_id text not null references companyos_knowledge.runtime_observations(observation_id),
      requested_by text not null, reason text not null, requested_at timestamptz not null, applied_at timestamptz)`;
    await sql`create table if not exists companyos_knowledge.observation_legal_holds (
      observation_id text primary key references companyos_knowledge.runtime_observations(observation_id), actor text not null,
      enabled_at timestamptz not null, released_at timestamptz)`;
    await sql`create table if not exists companyos_knowledge.page_type_registry (
      type_key text primary key, taxonomy_version text not null, display_label text not null,
      parent_key text references companyos_knowledge.page_type_registry(type_key), extraction_profile text not null,
      origin text not null check (origin in ('core','extension','legacy')),
      lifecycle_status text not null check (lifecycle_status in ('active','deprecated')),
      definition jsonb not null, registered_at timestamptz not null default now())`;
    await sql`insert into companyos_knowledge.page_type_registry
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
      on conflict (type_key) do nothing`;
    await sql`create table if not exists companyos_knowledge.page_type_aliases (
      alias text primary key, type_key text not null references companyos_knowledge.page_type_registry(type_key),
      mapping_evidence jsonb not null, registered_at timestamptz not null default now(), check (alias <> type_key))`;
    await sql`create table if not exists companyos_knowledge.pages (
      page_id text primary key, page_type_key text not null references companyos_knowledge.page_type_registry(type_key),
      source_id text not null, source_page_key text not null, current_version_id text not null,
      verification_status text not null check (verification_status in ('unverified','verified','rejected')),
      verification_evidence jsonb, access_policy_id text not null,
      lifecycle_status text not null check (lifecycle_status in ('active','superseded','forgotten','deleted')),
      created_at timestamptz not null, unique (source_id, source_page_key))`;
    await sql`create table if not exists companyos_knowledge.page_versions (
      page_version_id text primary key, page_id text not null references companyos_knowledge.pages(page_id),
      version_number integer not null check (version_number > 0), title text not null, summary text, body text not null,
      metadata jsonb not null, content_digest text not null, observed_at timestamptz not null, created_at timestamptz not null,
      source_object_id text not null, source_object_version text not null, access_policy_id text not null,
      model_provenance jsonb, unique (page_id, version_number), unique (page_id, page_version_id))`;
    await sql`do $$
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
      end $$`;
    await sql`do $$
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
      end $$`;
    await sql`create index if not exists knowledge_page_versions_observed_idx
      on companyos_knowledge.page_versions(page_id, observed_at desc, page_version_id)`;
    await sql`create table if not exists companyos_knowledge.entity_identities (
      entity_id text primary key,
      entity_kind text not null check (entity_kind in ('person','organization','project','deal','concept','other')),
      stable_key text not null, display_name text not null,
      creation_basis text not null check (creation_basis in ('provider-identifier','administrator-mapping','review-decision')),
      creation_receipt_id text not null,
      lifecycle_status text not null check (lifecycle_status in ('active','merged','deleted')),
      created_at timestamptz not null, unique (entity_kind, stable_key))`;
    await sql`create table if not exists companyos_knowledge.entity_identity_members (
      membership_id text primary key, entity_id text not null references companyos_knowledge.entity_identities(entity_id),
      page_id text not null references companyos_knowledge.pages(page_id),
      proof_basis text not null check (proof_basis in ('provider-identifier','administrator-mapping','deterministic-rule','review-decision')),
      proof_receipt_id text not null, page_access_policy_id text not null,
      status text not null check (status in ('active','revoked')), created_at timestamptz not null, unique (page_id))`;
    await sql`create index if not exists knowledge_entity_members_entity_idx
      on companyos_knowledge.entity_identity_members(entity_id, created_at, membership_id)`;
    await sql`create table if not exists companyos_knowledge.entity_identity_proposals (
      proposal_id text primary key, candidate_page_id text not null references companyos_knowledge.pages(page_id),
      target_entity_id text not null references companyos_knowledge.entity_identities(entity_id),
      method text not null check (method in ('name-similarity','embedding-similarity','model-judgment')),
      score numeric(5,4) check (score between 0 and 1), rationale text not null,
      evidence_receipt_ids jsonb not null, candidate_access_policy_id text not null,
      created_by text not null, created_at timestamptz not null, model_provenance jsonb,
      status text not null check (status in ('proposed','accepted','rejected')),
      decision_id text unique, decision jsonb, decided_at timestamptz)`;
    await sql`create index if not exists knowledge_entity_proposals_queue_idx
      on companyos_knowledge.entity_identity_proposals(status, created_at, proposal_id)`;
    await sql`create table if not exists companyos_knowledge.holders (
      holder_id text primary key,
      holder_type text not null check (holder_type in ('person','team','company','world','system','unresolved')),
      display_name text not null, identity_evidence jsonb not null, created_at timestamptz not null default now())`;
    await sql`create table if not exists companyos_knowledge.claims (
      claim_id text primary key, memory_class text not null check (memory_class in ('fact','take')),
      claim_kind text not null check (claim_kind in ('event','preference','commitment','belief','fact','take','bet','hunch')),
      claim_text text not null, owner_principal_id text, fact_scope jsonb,
      primary_holder_id text references companyos_knowledge.holders(holder_id),
      source_basis text not null check (source_basis in ('principal-memory','source-literal','fact-consolidation','model-derived','holder-accepted')),
      status text not null check (status in ('proposed','active','superseded','expired','resolved','forgotten','contested','deleted')),
      observed_at timestamptz not null, valid_from timestamptz, valid_until timestamptz,
      extraction_confidence numeric(5,4) not null check (extraction_confidence between 0 and 1),
      epistemic_weight numeric(5,4) not null check (epistemic_weight between 0 and 1),
      access_policy_id text not null, created_by text not null, model_provenance jsonb,
      unresolved_evidence_reason text, consolidation_receipt_id text, activation_receipt_id text,
      supersedes_claim_id text references companyos_knowledge.claims(claim_id), created_at timestamptz not null default now(),
      check ((memory_class = 'fact' and owner_principal_id is not null and fact_scope is not null and primary_holder_id is null)
        or (memory_class = 'take' and owner_principal_id is null and fact_scope is null and primary_holder_id is not null)),
      check (source_basis <> 'model-derived' or status = 'proposed'),
      check (valid_until is null or valid_from is null or valid_until >= valid_from))`;
    await sql`alter table companyos_knowledge.claims add column if not exists unresolved_evidence_reason text`;
    await sql`alter table companyos_knowledge.claims add column if not exists consolidation_receipt_id text`;
    await sql`alter table companyos_knowledge.claims add column if not exists activation_receipt_id text`;
    await sql`create index if not exists knowledge_claims_current_idx
      on companyos_knowledge.claims(status, memory_class, observed_at desc, claim_id)`;
    await sql`create index if not exists knowledge_claims_holder_idx
      on companyos_knowledge.claims(primary_holder_id, observed_at desc, claim_id) where primary_holder_id is not null`;
    await sql`create table if not exists companyos_knowledge.claim_evidence (
      claim_id text not null references companyos_knowledge.claims(claim_id), evidence_id text not null,
      source_id text not null, provider_object_id text not null, provider_version text not null,
      page_id text references companyos_knowledge.pages(page_id),
      page_version_id text references companyos_knowledge.page_versions(page_version_id),
      content_digest text not null, observed_at timestamptz not null, locator jsonb not null,
      primary key (claim_id, evidence_id))`;
    await sql`do $$
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
      end $$`;
    await sql`create table if not exists companyos_knowledge.claim_relations (
      claim_id text not null references companyos_knowledge.claims(claim_id),
      relation_type text not null check (relation_type in ('speaker','author','subject','approver','owner','beneficiary','affected-party')),
      entity_type text not null, entity_id text not null, evidence jsonb not null,
      primary key (claim_id, relation_type, entity_type, entity_id))`;
    await sql`create table if not exists companyos_knowledge.claim_consolidations (
      receipt_id text primary key, fact_claim_id text not null references companyos_knowledge.claims(claim_id),
      take_claim_id text not null references companyos_knowledge.claims(claim_id), rule_version text not null,
      evidence jsonb not null, consolidated_at timestamptz not null, check (fact_claim_id <> take_claim_id))`;
    await sql`create table if not exists companyos_knowledge.claim_resolution_proposals (
      proposal_id text primary key, claim_id text not null references companyos_knowledge.claims(claim_id),
      outcome text not null check (outcome in ('correct','incorrect','partial','unresolvable')),
      outcome_evidence jsonb not null, judge_receipt_id text not null, proposed_by text not null,
      proposed_at timestamptz not null,
      status text not null default 'proposed' check (status in ('proposed','accepted','rejected','superseded')),
      decision jsonb, decided_at timestamptz)`;
    for (const statement of COMPANY_BRAIN_PHASE_ONE_SCHEMA_STATEMENTS) await sql.query(statement);
    for (const statement of COMPANY_BRAIN_PHASE_TWO_SCHEMA_STATEMENTS) await sql.query(statement);
    for (const statement of COMPANY_KNOWLEDGE_PHASE_THREE_SCHEMA_STATEMENTS) await sql.query(statement);
    for (const statement of COMPANY_KNOWLEDGE_PHASE_FOUR_SCHEMA_STATEMENTS) await sql.query(statement);
    for (const statement of COMPANY_KNOWLEDGE_PHASE_FIVE_SCHEMA_STATEMENTS) await sql.query(statement);
    for (const statement of COMPANY_KNOWLEDGE_PHASE_SIX_SCHEMA_STATEMENTS) await sql.query(statement);
    for (const statement of COMPANY_KNOWLEDGE_PHASE_SEVEN_SCHEMA_STATEMENTS) await sql.query(statement);
    let vector = false;
    try {
      await sql`create extension if not exists vector`;
      await sql`create table if not exists companyos_knowledge.fragment_embeddings (
        snapshot_hash text not null references companyos_knowledge.snapshots(snapshot_hash) on delete cascade,
        fragment_id text not null, adapter_id text not null, adapter_version text not null,
        embedding vector(256) not null,
        primary key (snapshot_hash, fragment_id, adapter_id, adapter_version),
        foreign key (snapshot_hash, fragment_id) references companyos_knowledge.fragments(snapshot_hash, fragment_id) on delete cascade)`;
      await sql`create index if not exists knowledge_fragment_embeddings_hnsw_idx
        on companyos_knowledge.fragment_embeddings using hnsw (embedding vector_cosine_ops)`;
      await sql`create table if not exists companyos_knowledge.retrieval_unit_embeddings (
        projection_hash text not null,
        unit_id text not null,
        adapter_id text not null,
        adapter_version text not null,
        dimensions integer not null check (dimensions = 256),
        content_digest text not null,
        embedding vector(256) not null,
        primary key (projection_hash, unit_id, adapter_id, adapter_version),
        foreign key (projection_hash, unit_id)
          references companyos_knowledge.retrieval_units(projection_hash, unit_id) on delete cascade) `;
      await sql`create index if not exists knowledge_retrieval_unit_embeddings_hnsw_idx
        on companyos_knowledge.retrieval_unit_embeddings using hnsw (embedding vector_cosine_ops)`;
      vector = true;
    } catch {
      vector = false;
    }
    return { vector };
  })();
  return migration;
}
