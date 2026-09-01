---
document_id: specification.company-records-sprint-v0.1
title: Company Records and Sprint Foundation v0.1
kind: specification
status: building
authority: normative
language: en
updated: 2026-08-31
owners:
  - oregano-maintainers
audience:
  - human
  - agent
relations:
  depends_on:
    - specification.companyos-core-v0.7
    - specification.tool-architecture
    - specification.companyos-packages-v0.1
    - architecture.boundaries
    - architecture.company-instance
---

# Company Records and Sprint Foundation v0.1

This specification defines the reusable operational-record and Sprint
foundation implemented by Oregano Core. It does not define one company's
Sprint policy, provider resources, people, calendar, channel, column mapping,
model, credentials, or rollout decision.

## 1. Boundary

**CRS-001 — Four locations.** The foundation has four distinct locations:

- Core owns validated provider-neutral contracts, deterministic record and
  Sprint behavior, durable-state interfaces, standard Tools, and maintained
  Connector implementations;
- the Sprint Blueprint owns reusable declarative Agent instructions,
  Workflows, Skills, assets, and synthetic fixtures;
- a Company Workspace owns company record-source and projection declarations,
  Sprint policy, schedule, mappings, participants, language, requested Tools,
  grants, and logical connection references; and
- a Company Instance owns exact provider installations, resources, bindings,
  secrets, database state, durable timers, effects, and receipts.

Core and Blueprint content MUST remain free of real company principals,
resource identifiers, credentials, grants, completed approvals, and rollout
state. The Blueprint MUST contain no executable runtime code.

The Workspace declaration surface is intentionally small. Reusable operational
data configuration lives under `records/sources/` and
`records/projections/`. Company-specific Sprint configuration lives at
`workflows/sprint/config.yaml` beside its owned Workflow material. A Company
Workspace has no top-level `domains/` directory: executable provider-neutral
Sprint Domain code remains in Core under `packages/domains/sprint/`.

**CRS-002 — No second authority.** Synchronized Company Records are versioned
operational evidence and rebuildable read models. They are not curated Company
Knowledge, Handbook authority, provider authority, or an authorization roster.
The external business provider remains authoritative for its own objects.

## 2. Company Records

**CRS-010 — Registered sources.** Every source declaration MUST identify one
stable source ID, record type, logical connection, exact logical resource
binding, delivery mode, object identity field, explicit field mapping, and
access scope. A reconciliation schedule is required when the source is polled.
Unknown objects, fields, and lifecycle states MUST NOT be guessed.

**CRS-011 — Immutable observations.** An accepted source event and normalized
object version are immutable and tenant-scoped. Exact event retries and exact
object-content retries are idempotent. A changed object creates a new version.
Deletion is represented as an observed version; it does not silently erase
retained evidence.

**CRS-012 — Rebuildable projections.** A projection declares its record type,
selection, exposed fields, freshness bound, read groups, and materialization
mode. Projection rows may be rebuilt from current immutable object versions.
Projection access is checked before rows are returned and emits a payload-free
access decision.

**CRS-013 — Reconciliation.** Full reconciliation requires a per-Instance,
per-source lease. It compares only a complete declared inventory, records
missing objects as provider absence, advances the watermark only after
successful completion, emits one receipt, and releases the lease. An incomplete
provider pass MUST NOT infer deletion.

**CRS-014 — Persistence.** The maintained Postgres implementation uses the
additive `companyos_records` schema in the existing Company Instance database.
It stores source events, immutable object versions, current pointers,
projection rows, access decisions, receipts, watermarks, leases, durable
timers, Connector echo receipts, and callback replay claims. Schema creation is
idempotent. It MUST NOT store provider credentials.

**CRS-015 — Authoritative provider and normal read path.** An external business
provider remains authoritative for its declared objects. A Company Instance
Connector ingests normalized immutable observations and rebuildable projections
into the records StateStore; the maintained reference stores them in
Neon/Postgres `companyos_records`. Normal Agent and Sprint Domain reads use
authorized projections through `records.query`. Direct provider reads are
reserved for discovery, synchronization, freshness recovery, reconciliation,
and required read-before-write or read-after-write checks. A stale or
conflicting projection fails visibly and MUST NOT silently replace provider
truth. An operational organizational projection may create a reviewed Handbook
proposal but MUST NOT modify `handbook/roster.md` or authorization state.

## 3. Sprint domain

**CRS-020 — Pure decision boundary.** The Sprint domain accepts one validated
declaration, prior state, one normalized event, and a controlled clock. It
returns new state, evidence, and zero or more provider-neutral intents. It MUST
NOT import a provider SDK, access the network, read environment credentials,
execute SQL, invoke a model, or perform an external effect.

**CRS-021 — Durable event truth.** Sprint events are append-only and deduplicated
by stable event identity. Participant, work-item, submission, completeness,
effort, and Rollover views are derived. A model conversation is never durable
Sprint state.

**CRS-022 — Business time.** Business-time calculation uses only the Workspace
timezone, business calendar, excluded dates, delivery window, and holiday-shift
rule. It is deterministic under a controlled clock and covered by weekend,
holiday, and daylight-saving fixtures.

**CRS-023 — Friday Close.** The close uses one frozen participant snapshot and
the committed-task set for each included participant. Approved absence is
handled only according to declared policy. Submission classification uses the
provider-accepted timestamp. A report is frozen at its configured instant;
later submissions do not rewrite it. Actual effort and Rollover eligibility use
the exact declared policy and never an inferred substitute.

**CRS-024 — Intents, not effects.** Reminder, report, reconciliation, and
Rollover outputs are stable intents with deterministic idempotency identities.
The runtime resolves and authorizes a Tool before an intent can become an
effect. A failed, stale, ambiguous, or unbound intent remains an explicit
no-effect result.

## 4. Tools and Connectors

**CRS-030 — Provider-neutral Capabilities.** Core maintains the contracts
`records.query`, `work-item.read`, `work-item.update`, `work-item.comment`, and
`communication.message.publish`. Their standard Tools expose no database or
provider client. A Company Workspace grant alone does not resolve them; the
Company Instance MUST bind an exact compatible Connector implementation.

**CRS-031 — Effect controls.** Work-item updates and comments require a claimed
idempotency identity and an exact resource binding. Updates additionally
require an expected provider version, field allowlist, and read-after-write
evidence. Internal message publication requires an exact destination binding
and a provider receipt. Company policy may raise risk but MUST NOT weaken the
Core minimum.

**CRS-032 — Maintained Monday boundary.** The maintained Monday implementation
uses an explicit API version, exact board binding, minimum permission, logical
field mapping, optimistic version check, read-after-write verification, and
durable self-echo evidence. Provider credentials are injected by the Instance
and MUST NOT enter Tool input, output, evidence, Workspace files, or logs.

**CRS-033 — Callback security.** A Monday external-Agent callback is verified
over the raw body with the documented signature and timestamp before JSON
parsing or Agent resolution. Stale, malformed, invalid, or replayed callbacks
fail closed. Replay state is durable and retains only a digest, not the
provider signature. Conversational callbacks use `AgentResolver` after
verification. Board-change events normalize directly into records and domain
processing and MUST NOT invoke a conversational Agent.

**CRS-034 — Read-only provider qualification.** The maintained first
qualification MUST bind one exact Core identity, Company Workspace, OAuth
client, app version, loopback redirect URI, API version, scope set, and explicit board set
before browser consent. It MUST use OAuth 2.1 with S256 PKCE and request exactly
`boards:read` and `me:read`. The authorization request MUST ask Monday to route
a missing installation through its administrator-controlled installation
handoff. That parameter MUST NOT be represented as automatic installation or
as authority to bypass the provider's administrator. The authorization code,
PKCE verifier, client secret, access token, and refresh token MUST remain
memory-only and MUST be discarded after one bounded metadata query. Persisted
evidence MAY contain the consenting actor and account, granted scopes,
board/group/column structure, request metadata, and a discovery digest. It
MUST NOT contain items, updates, column values, provider credentials, or a
completed provider effect. External Agent provisioning and activation require
a separate effect plan.

## 5. Blueprint and materialization

**CRS-040 — Sprint Blueprint.** `packages/blueprints/sprint-agent/` is one
locally inspectable Blueprint Package containing one Agent Component, portable
weekly, close, and reconciliation Workflows, Sprint, triage, and briefing
Skills, owned close-template assets, and synthetic fixtures. It declares
required Tools and Capabilities but assigns no authority.

**CRS-041 — Manual Workspace diff.** Blueprint plan, apply, lock, update, and
remove are not implemented. Materializing the Blueprint remains an ordinary
reviewed Workspace diff. It MUST NOT be described as installation and MUST NOT
occur until the company values have been interviewed, recorded, validated, and
reviewed.

## 6. Current qualification boundary

Repository tests prove schemas, deterministic in-memory and Postgres contracts,
controlled-clock Sprint decisions, Tool resolution inputs, signed callback
verification, replay and echo controls, Connector behavior with synthetic
responses, exact-scope OAuth 2.1 PKCE planning, bounded read-only resource
discovery, credential-free qualification receipts, and read-only Blueprint
inspection. They do not prove a real
provider installation, exact account permission, provider cost, production
message, production database migration, scheduled execution, or Company
Workspace rollout. Those claims require separate Instance consent, non-
production qualification, staged activation, and live evidence.
