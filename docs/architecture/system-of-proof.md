---
document_id: architecture.system-of-proof
title: System of Proof
kind: architecture
status: approved
authority: canonical
language: en
updated: 2026-09-02
owners:
  - oregano-maintainers
audience:
  - human
  - agent
relations:
  depends_on:
    - vision.companyos
    - architecture.company-instance
    - architecture.boundaries
    - specification.company-records-sprint-v0.1
---

# System of Proof

The System of Proof is the connected evidence chain that lets CompanyOS answer
what ran, under which reviewed rules and exact versions, who authorized it,
what the system attempted, and what the external provider reported afterward.
It implements the principle that evidence beats claims.

It is a logical architecture, not a fourth database schema, a second Company
Workspace, or a new source of business authority. The proof chain composes
reviewed Git material, one immutable deployment Artifact, evidence stored in
the three existing Company Instance schemas, and attributable external
provider receipts.

```mermaid
flowchart LR
    C["Exact Core commit"] --> A["Immutable Artifact<br/>compiled provenance"]
    W["Exact Workspace commit<br/>policy and operating intent"] --> A
    I["Instance bindings<br/>environment and resources"] --> A
    A --> S1["companyos<br/>runs, approvals, effects"]
    P["External providers"] --> S2["companyos_records<br/>observations and sync proof"]
    P --> S3["companyos_knowledge<br/>sources, evidence, decisions"]
    S1 --> Q["Explain, audit, verify"]
    S2 --> Q
    S3 --> Q
    P -->|"effect receipt or verified reread"| Q
```

## Sources of authority and evidence

The layers have different jobs and MUST NOT be collapsed:

| Layer | What it establishes | What it does not establish |
|---|---|---|
| Company Workspace Git history | Reviewed company intent, policies, Workflows, Agents, grants, and exact change history | That a deployment or provider effect occurred |
| Oregano Core and immutable Artifact provenance | Exact executable contracts, compiled material, versions, and hashes used by one Instance | Company approval or provider success |
| `companyos` | Workflow, identity, approval, handoff, idempotency, and effect-control evidence | External provider business truth by itself |
| `companyos_records` | Versioned provider observations, current pointers, authorized projections, freshness, reconciliation, synchronization receipts, and atomic Sprint event, state, decision, and intent evidence | Curated Handbook authority or a second provider authority |
| `companyos_knowledge` | Knowledge sources, versions, observations, Claims, evidence, review decisions, lifecycle state, and activation evidence | Automatic promotion into reviewed Workspace authority |
| External provider receipt or verified reread | The provider accepted or currently exposes the exact bounded effect or object version | That CompanyOS policy authorized the action |

A defensible proof normally links an authenticated principal, the exact Core,
Workspace, Artifact, policy, Agent, Tool, and model identities that applied, a
stable input or proposal digest, any attributable approval, the idempotency
claim and effect state, and the provider receipt or verified reread. Not every
row contains every fact; stable identities and digests connect the chain.

## Existing PostgreSQL schemas

The maintained StateStore uses one PostgreSQL database per Company Instance.
Neon/Postgres is the reference service. A qualified PostgreSQL-compatible
service, including Supabase Postgres, may host the same schemas without
changing their responsibilities.

### `companyos`: control and execution proof

This schema records the control path: database manifests, Workflow runs and
events, approval requests and decisions, idempotent effects and outcomes,
Conversation Assignments and transitions, published artifacts, Builder jobs,
and repository installations. Short-lived chat locks, queues, and comparable
coordination state also live here but are not durable business evidence merely
because they share the schema.

The maintained DDL is `packages/state-postgres/schema.sql`.

### `companyos_records`: operational record proof

This schema records immutable Source Events and object versions, current object
pointers, rebuildable projection rows, access decisions, synchronization
receipts and watermarks, reconciliation leases, durable timers, Connector echo
receipts, callback replay claims, and atomic Sprint event, monotonic state,
decision, and intent outcomes. A Sprint event, its resulting state and decision
evidence, and its newly created intents commit together or not at all. Provider
deletion is an observed version or absence decision; it does not silently erase
retained CompanyOS evidence.

The maintained DDL is `packages/state-postgres/records-schema.sql`.

### `companyos_knowledge`: knowledge and decision proof

This schema records Knowledge Snapshots, documents and fragments, source
receipts and versions, Runtime Observations and lifecycle decisions, Pages,
Claims and exact supporting evidence, identity and access decisions, Working
Syntheses, Decision Receipts, promotion candidates, model-execution evidence,
and rebuildable retrieval projections. These rows support explanation and
review; only the exact reviewed OKF in the Company Workspace is curated company
authority.

The maintained DDL is `packages/state-postgres/knowledge-schema.sql`.

## Retention model

Retention is a company policy expressed in its Company Workspace and enforced
for one Company Instance. Core supplies safe lifecycle mechanisms; it MUST NOT
embed a customer-specific duration.

CompanyOS distinguishes three categories:

1. **Durable proof** includes approvals, effect outcomes, provider receipts,
   immutable source versions, review decisions, and comparable evidence needed
   to explain a run later. A company may retain it indefinitely or adopt a
   governed finite policy.
2. **Rebuildable projections** include current and search-oriented read models.
   They may be rebuilt from retained authoritative inputs and are not a
   substitute for the durable proof chain.
3. **Temporary coordination state** includes locks, leases, replay claims,
   echo-suppression entries, queues, and explicitly temporary conversation or
   session state. Its mechanism-defined expiry continues to apply even when a
   company retains durable proof indefinitely.

The queued or leased status of a Sprint intent is coordination state. The
accepted Sprint event, resulting state version, deterministic intent content,
and terminal dispatch outcome remain durable proof; expiring a lease never
erases them.

`retention: retain` means that CompanyOS does not schedule an automatic purge
merely because evidence has reached an age or disappeared from its provider.
It does not turn data into immutable legal records, defeat an applicable legal
obligation, block a valid data-subject request, or override a separately
approved deletion or legal-hold decision. Such an exception must be
attributable, scoped, dependency-checked, and itself leave non-sensitive
decision evidence. Backup retention and deletion must follow the same approved
company policy and remain an Instance responsibility.

The current schemas and adapters preserve substantial evidence, but CompanyOS
does not yet claim one universal automated retention and purge engine across
all three schemas. Until that contract exists and is qualified, a Company
Instance must not describe its retention policy as fully enforced merely
because the tables exist. Current implementation claims remain in
[Current System Status](../status/current.md).

## Minimum safety rules

- Secrets and credentials never enter proof rows, Git, prompts, receipts, or
  logs; proof stores SecretRefs and non-secret provider identities instead.
- Access to proof is authorized before content is returned. Audit evidence is
  not permission to disclose the underlying payload.
- Payload-free receipts are preferred whenever counts, identities, hashes,
  timestamps, and outcome state are sufficient.
- Raw conversations and personal content are not collected merely to make a
  proof chain look complete. If a Workflow genuinely requires them, its
  collection, access, purpose, and retention require explicit company policy.
- An external provider remains authoritative for its business objects. A
  receipt proves an observed outcome; it does not replace the provider record.
- Database presence is not proof of operational enforcement. Verification must
  bind the exact Instance, versions, policy, schema manifest, and external
  receipts relevant to the claim.

## Placement rule for future evidence

Before adding a table, classify the evidence. Generic proof structure,
validation, idempotency, access, and lifecycle mechanisms belong in Core.
Company-specific retention, purposes, roles, Workflow requirements, and
allowed audiences belong in the Company Workspace. Live rows, provider
identifiers, credentials, backups, and enforcement receipts belong to the
Company Instance. A new schema is justified only when an independent data
boundary cannot be represented safely in the three existing schemas; the name
“System of Proof” alone is never sufficient reason.
