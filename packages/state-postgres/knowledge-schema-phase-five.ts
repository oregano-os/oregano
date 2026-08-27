// Trusted, additive statements for persisted Knowledge compounding. These
// tables contain bounded identities, proposals, and receipts; source payloads
// remain in their existing evidence tables.
export const COMPANY_KNOWLEDGE_PHASE_FIVE_SCHEMA_STATEMENTS = [
  `create table if not exists companyos_knowledge.compounding_leases (
    phase text not null,
    scope text not null check (scope in ('source','mixed','global')),
    scope_id text not null,
    lease_owner text not null,
    acquired_at timestamptz not null,
    lease_until timestamptz not null,
    primary key (phase, scope, scope_id),
    check (lease_until > acquired_at)
  )`,
  `create index if not exists knowledge_compounding_leases_due_idx
    on companyos_knowledge.compounding_leases(lease_until, phase, scope, scope_id)`,
  `create table if not exists companyos_knowledge.compounding_receipts (
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
  )`,
  `create index if not exists knowledge_compounding_receipts_cycle_idx
    on companyos_knowledge.compounding_receipts(cycle_id, phase, scope_id, completed_at, receipt_id)`,
  `create table if not exists companyos_knowledge.claim_pair_proposals (
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
  )`,
  `create index if not exists knowledge_claim_pair_proposals_queue_idx
    on companyos_knowledge.claim_pair_proposals(status, proposal_kind, created_at, proposal_id)`,
  `create table if not exists companyos_knowledge.claim_grading_requests (
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
  )`,
  `create index if not exists knowledge_claim_grading_requests_queue_idx
    on companyos_knowledge.claim_grading_requests(status, requested_at, request_id)`,
] as const;
