// Trusted, additive statements for content-addressed model-result reuse and
// spend enforcement. Cached outputs remain policy-bound derived evidence.
export const COMPANY_KNOWLEDGE_PHASE_SIX_SCHEMA_STATEMENTS = [
  `create table if not exists companyos_knowledge.model_task_results (
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
  )`,
  `create index if not exists knowledge_model_task_results_policy_idx
    on companyos_knowledge.model_task_results(access_policy_id, task, last_used_at, cache_key)`,
  `create table if not exists companyos_knowledge.model_spend_reservations (
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
  )`,
  `create index if not exists knowledge_model_spend_reservations_budget_idx
    on companyos_knowledge.model_spend_reservations(reserved_at, cycle_id, status, reservation_id)`,
  `create table if not exists companyos_knowledge.model_execution_ledger (
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
  )`,
  `create index if not exists knowledge_model_execution_ledger_spend_idx
    on companyos_knowledge.model_execution_ledger(completed_at, cycle_id, task, route, model, receipt_id)`,
] as const;
