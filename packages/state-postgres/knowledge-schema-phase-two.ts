// Trusted, additive PostgreSQL statements for Company Brain Phase 2
// authorization. No statement contains runtime input.
export const COMPANY_BRAIN_PHASE_TWO_SCHEMA_STATEMENTS = [
  `create table if not exists companyos_knowledge.principal_groups (
    group_id text primary key,
    display_name text not null,
    group_status text not null check (group_status in ('active','revoked')),
    definition jsonb not null,
    created_by text not null,
    created_at timestamptz not null default now()
  )`,
  `insert into companyos_knowledge.principal_groups
    (group_id, display_name, group_status, definition, created_by)
    values ('companyos:knowledge-admin', 'Company Knowledge administrators', 'active',
      '{"reserved":true,"purpose":"quarantine-administration"}'::jsonb, 'system:schema-upgrade')
    on conflict (group_id) do nothing`,
  `create table if not exists companyos_knowledge.principal_group_members (
    membership_id text primary key,
    group_id text not null references companyos_knowledge.principal_groups(group_id),
    principal_id text not null,
    membership_status text not null check (membership_status in ('active','revoked')),
    evidence jsonb not null,
    granted_by text not null,
    created_at timestamptz not null default now(),
    revoked_at timestamptz,
    unique (group_id, principal_id)
  )`,
  `create index if not exists knowledge_principal_group_members_principal_idx
    on companyos_knowledge.principal_group_members(principal_id, membership_status, group_id)`,
  `insert into companyos_knowledge.acl_entries
    (entry_id, policy_id, subject_kind, subject_id, permission, effect, evidence)
    values ('acl:quarantine:knowledge-admin', 'policy:quarantine', 'group',
      'companyos:knowledge-admin', 'admin', 'allow',
      '{"reserved":true,"reason":"administrator-only-quarantine"}'::jsonb)
    on conflict (entry_id) do nothing`,
  `create table if not exists companyos_knowledge.access_decision_events (
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
  )`,
  `create index if not exists knowledge_access_decisions_principal_idx
    on companyos_knowledge.access_decision_events(principal_id, decided_at desc, decision_id)`,
  `create index if not exists knowledge_access_decisions_outcome_idx
    on companyos_knowledge.access_decision_events(outcome, decided_at desc, decision_id)`,
] as const;
