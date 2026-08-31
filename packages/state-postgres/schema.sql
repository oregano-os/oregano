-- Oregano StateStore v3 — one isolated schema per CompanyOS Instance database.
-- HONEST LABELING: In Stage 1 the StateStore ADAPTER enforces
-- append-only and the status transitions — not yet separate DB roles/
-- triggers/RLS (required for enforced unattended execution).
-- TRANSACTION RULE (non-negotiable): consumeApproval and claimEffect
-- run in ONE transaction — otherwise a crash window exists between
-- a consumed approval and a claimed effect.
-- TRANSITION RULE: status changes always as conditional UPDATE:
--   UPDATE effects SET status='dispatched'
--   WHERE idempotency_key=$1 AND status='claimed' RETURNING *;
-- (A CHECK allows values but enforces no ordering.)

create schema if not exists companyos;

-- Immutable entries identify each database bootstrap or upgrade manifest that
-- was accepted for this Company Instance. Secrets and connection values never
-- enter this ledger.
create table if not exists companyos.schema_manifests (
  manifest_id       text not null,
  manifest_version  text not null,
  manifest_digest   text not null,
  features          jsonb not null,
  applied_at        timestamptz not null default now(),
  primary key (manifest_id, manifest_version)
);

create table if not exists companyos.workflow_runs (
  run_id                 text primary key,
  workflow               text not null,
  workflow_version       text not null,      -- CORE git SHA (real, no placeholder)
  company_commit         text,               -- COMPANY repo git SHA (§10a provenance pair)
  company_snapshot_hash  text not null,      -- immutable Company Workspace content hash
  agent_definition_hash  text not null,      -- compiled instructions and scoped-material hash
  agent_adapter          text not null,
  adapter_version        text,               -- version of the selected Runner Adapter
  agent_deployment       text,               -- which deployment (Vercel deployment id)
  status                 text not null default 'running'
                         check (status in ('running','waiting','done','cancelled','failed')),
  started_at             timestamptz not null default now()
);

create table if not exists companyos.events (
  event_id            uuid primary key default gen_random_uuid(),
  run_id              text not null references companyos.workflow_runs(run_id),
  step_id             text not null,
  ts                  timestamptz not null default now(),
  actor               text not null,          -- agent | human:<role>
  subject_principal   text,                   -- slack:<team-id>:<user-id>
  event               text not null,
  status              text check (status in ('succeeded','failed','effect-unknown')),
  caused_by_event_id  uuid,
  tool_version        text,
  idempotency_key     text,
  evidence            jsonb,
  payload             jsonb
);

-- Request and decision separated: the request exists BEFORE the click.
create table if not exists companyos.approval_requests (
  request_id   uuid primary key default gen_random_uuid(),
  run_id       text not null references companyos.workflow_runs(run_id),
  step_id      text not null,
  action       text not null,                 -- exactly ONE action per request
  input_hash   text not null,
  connection   text,
  max_spend    numeric,
  expires_at   timestamptz,
  created_at   timestamptz not null default now()
);

create table if not exists companyos.approvals (
  approval_id        uuid primary key default gen_random_uuid(),
  request_id         uuid not null references companyos.approval_requests(request_id),
  subject_principal  text not null,           -- who decided
  role               text not null,
  decision           text not null check (decision in ('approved','rejected')),
  decided_at         timestamptz not null default now(),
  consumed_at        timestamptz              -- consumeApproval:
                                              -- UPDATE ... WHERE approval_id=$1
                                              --   AND consumed_at IS NULL RETURNING *;
);

create table if not exists companyos.effects (
  idempotency_key  text primary key,          -- claimEffect: INSERT = atomarer Claim
  run_id           text not null references companyos.workflow_runs(run_id),
  step_id          text not null,
  approval_id      uuid references companyos.approvals(approval_id)
                   unique,                     -- one approval = exactly one effect,
                                               -- enforced by the DB, not just the CTE
  input_hash       text,
  status           text not null default 'claimed'
                   check (status in ('claimed','dispatched','succeeded','failed','unknown')),
  claimed_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  evidence         jsonb
);

create table if not exists companyos.chat_values (
  key text primary key,
  value jsonb not null,
  expires_at timestamptz
);

create table if not exists companyos.chat_subscriptions (
  thread_id text primary key,
  subscribed_at timestamptz not null default now()
);

create table if not exists companyos.chat_locks (
  thread_id text primary key,
  token text not null,
  expires_at timestamptz not null
);

create table if not exists companyos.chat_lists (
  sequence bigserial primary key,
  key text not null,
  value jsonb not null,
  expires_at timestamptz
);
create index if not exists chat_lists_key_sequence_idx
  on companyos.chat_lists(key, sequence);

create table if not exists companyos.chat_queue (
  sequence bigserial primary key,
  thread_id text not null,
  entry jsonb not null,
  expires_at timestamptz not null
);
create index if not exists chat_queue_thread_sequence_idx
  on companyos.chat_queue(thread_id, sequence);

create table if not exists companyos.published_artifacts (
  artifact_id text primary key,
  content text not null,
  content_type text not null,
  digest text not null,
  run_id text not null references companyos.workflow_runs(run_id),
  published_at timestamptz not null default now()
);

create table if not exists companyos.builder_jobs (
  job_id                text primary key,
  request_id            text not null unique,
  fingerprint           text not null,
  input                 jsonb not null,
  state                 text not null
                        check (state in ('queued','preparing_source','executing','validating','publishing','published','failed','cancelled')),
  attempts              integer not null default 0,
  lease_owner           text,
  lease_token           text,
  lease_expires_at      timestamptz,
  cancel_requested_at   timestamptz,
  execution_handle      jsonb,
  evidence              jsonb,
  terminal_reason       text,
  notification_state    text check (notification_state in ('pending','delivered')),
  notification_attempts integer not null default 0,
  notification_next_attempt_at timestamptz,
  notification_lease_owner text,
  notification_lease_token text,
  notification_lease_expires_at timestamptz,
  notification_delivered_at timestamptz,
  notification_last_error text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists builder_jobs_claim_idx
  on companyos.builder_jobs(state, lease_expires_at, created_at);
create index if not exists builder_notifications_claim_idx
  on companyos.builder_jobs(notification_state, notification_next_attempt_at, notification_lease_expires_at)
  where notification_state = 'pending';

create table if not exists companyos.repository_installations (
  binding_id             text primary key,
  instance_id            text not null,
  provider_id            text not null,
  service_environment    text not null,
  installation_id        text not null,
  provider_repository_id text not null,
  repository_id          text not null,
  owner_name             text not null,
  repository_name        text not null,
  default_branch         text not null,
  status                 text not null check (status in ('active','suspended','revoked')),
  verified_at            timestamptz not null,
  updated_at             timestamptz not null,
  provider_receipt       jsonb not null,
  unique (instance_id, provider_id, service_environment, provider_repository_id)
);
