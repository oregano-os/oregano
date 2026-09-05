---
document_id: specification.company-records-sprint-v0.1
title: Company Records and Sprint Foundation v0.1
kind: specification
status: building
authority: normative
language: en
updated: 2026-09-04
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
provider pass MUST NOT infer deletion. Independent observed and missing objects
MUST use the fixed Core-owned snapshot concurrency bound. An interrupted pass
MUST publish neither its watermark nor a successful receipt. An exact retry
MUST repair missing version, current-pointer, projection, or tombstone
materialization only when the retried immutable version is still current; it
MUST NOT replace a newer current projection. The current-version check and
projection mutation MUST be one atomic StateStore operation so a concurrent
Source Event cannot enter between the check and the mutation.

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

**CRS-016 — Governed source lifecycle.** The Workbench MUST expose one
provider-neutral source lifecycle for local inspection, provider
qualification, reviewed declaration materialization, synchronization,
reconciliation, and payload-free status. A source write plan MUST bind the
exact Core identity, Workspace declaration digest, applicable projection
digests, non-secret Instance binding digest, Connector version, environment,
provider resource, SecretRefs, and database effect before any credential is
resolved or provider or database call is made. A wrong or stale confirmation
MUST produce no external call. Synchronization MUST NOT infer provider
deletion; reconciliation MAY record provider absence only from a bounded
complete inventory under the source lease. Materialization creates only the
exact reviewed Workspace file and MUST NOT commit it, activate it, or infer a
company value.

**CRS-017 — Bounded and resumable snapshots.** After a Record Source Connector
returns one bounded complete inventory, synchronization MUST process independent
objects with a fixed Core-owned concurrency bound. A runtime interruption MAY
leave immutable Source Events, object versions, current pointers, or projection
rows, but MUST NOT advance the source watermark or append a successful sync
receipt. An exact retry MUST deduplicate Source Events and MAY repair a missing
version or projection only when the retried immutable version is still the
current object version. The StateStore MUST compare and mutate atomically;
replaying an older version MUST NOT replace or remove a projection of newer
current state. Watermark and completion evidence are written only after every
inventory object succeeds.

**CRS-018 — Resumable rehearsal orchestration.** The Workbench MUST be able to
freeze one reviewed Record Source, its selected projections, non-secret
binding and qualification, exact clean Core and Workspace identities, and one
non-production Instance profile into a credential-free mode-0600 local state.
The orchestrator MUST reuse the maintained rehearsal, synchronization, Store,
receipt, and watermark contracts rather than implement another provider
pipeline. Remote planning MUST have no provider or database effect. Migration
and source synchronization MUST retain independent exact human confirmations;
a missing or stale confirmation makes no apply request. An interrupted apply
remains resumable from the last recorded effect. Completion requires
payload-free proof of an available Store, a successful zero-error receipt, a
watermark, and every selected projection. Runtime and StateStore details belong
to a replaceable Instance profile; company values and provider mappings remain
Workspace or Instance truth. Infrastructure creation, secret copying, cleanup,
schedule activation, and production activation are outside this command.

**CRS-019 — Governed production runtime.** A maintained hosted production lane
MUST be separate from rehearsal and MUST fail before database or provider access
unless the production deployment, exact Git commit, Artifact Core and Workspace
refs, Company Instance, runtime configuration, and authenticated caller agree.
Migration and initial synchronization MUST retain independent exact plan/apply
confirmation. A completed confirmation MUST reuse its exact stored receipt and
MUST NOT read the provider again. Recurring reconciliation MUST require a
separate scheduler secret and activation switch, select only a due allowlisted
source from reviewed local-time configuration, use a stable service-day run
identity and durable source lease, and infer absence only from a complete
inventory. The hosting cron is a wake-up adapter rather than schedule authority.
Production status MUST be payload-free. The runtime MUST NOT modify a provider,
send a message, grant an Agent Tool, invoke a model, or accept a conversational
Agent callback as board-change evidence. The maintained database manifest MUST
qualify the exact additive records tables and indexes before readiness is
claimed.

## 3. Sprint domain

**CRS-020 — Pure decision boundary.** The Sprint domain accepts one validated
declaration, prior state, one normalized event, and a controlled clock. It
returns new state, evidence, and zero or more provider-neutral intents. It MUST
NOT import a provider SDK, access the network, read environment credentials,
execute SQL, invoke a model, or perform an external effect.

**CRS-021 — Durable event truth.** Sprint events are append-only and deduplicated
by stable event identity. Reuse of an event identity with different content
MUST fail closed. An accepted event, its resulting monotonic state version,
decision evidence, and newly created intents MUST commit atomically or not at
all. Concurrent events use optimistic state-version control; an exact retry
returns the original durable outcome. Participant, work-item, submission,
completeness, effort, and Rollover views are derived. A model conversation is
never durable Sprint state.

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

**CRS-024 — Intents, not effects.** Close-thread reminder, chase, report,
retrospective, reconciliation, and Rollover outputs are stable intents with
deterministic idempotency identities. Friday Close messages freeze the exact
shared-channel binding; every reply also freezes the provider-returned root
thread reference. A Rollover intent freezes the expected provider version of
every work item it proposes to change.
The runtime resolves and authorizes a Tool before an intent can become an
effect. A failed, stale, ambiguous, or unbound intent remains an explicit
no-effect result. A provider effect whose complete receipt cannot be verified
MUST remain `unknown` with bounded partial evidence and MUST NOT be retried as
though no effect occurred.

**CRS-025 — Orchestration boundary.** Normalized provider events and due durable
timers MUST enter the same validated event-processing path. Due timers complete
only after their resulting Sprint outcome is durable. Intent workers claim
bounded batches with expiring leases and record explicit success, retry,
failure, or cancellation outcomes. A maintained dispatcher MUST resolve the
exact compiled Agent, Tool grant, destination or resource binding, and Tool
input, then execute through `CompanyOSRuntime`; it MUST NOT call a provider
directly or treat persisted intent state as Tool authority. Missing policy,
calendar, state identity, dispatcher, Agent, grant, destination, or resource
binding fails before an effect.

**CRS-026 — Maintained hosted profile.** Workbench MUST compile each hosted
Sprint from an exact Workspace declaration and non-secret Instance bindings.
The immutable Artifact MUST include the reviewed schedule and template
digests, logical Agent, service principal, participant identity namespace, and
destination/resource bindings. The maintained Runner MUST expose a separately
authenticated operator action and bounded timer and intent wake-up routes.
Opening MUST use fresh projections through the standard `records.query` Tool;
Slack submissions MUST enter only after provider authentication, roster
authorization, and deterministic Agent routing. Shadow mode MUST retain only
non-effect dispatch evidence. Active mode MUST use `CompanyOSRuntime`; a
Rollover without the ordinary frozen-proposal confirmation path MUST fail
closed. The initial profile uses bounded polling for Monday-backed records and
Slack for interaction. Monday board-change webhooks and Monday card chat are
deferred extensions, not initial-rollout dependencies.

**CRS-027 — Historical Sprint replay.** An Instance MAY compile one exact
`communication-message` projection for historical replay. That projection MUST
expose stable message, team, author, thread, text, and occurrence fields.
Replay MUST use an isolated definition, explicit date range, immutable input
versions, and controlled clock. Its durable timers MUST use a deterministic
replay-specific schedule namespace: an exact replay retry reuses the same timer
identities, while an independent replay of the same Sprint period cannot
conflict with them. Persisted timer payload identity MUST be compared by
canonical JSON value because PostgreSQL JSONB does not preserve object-key
order; key-order changes alone MUST NOT create a conflict, while any changed
value MUST still fail closed. It MUST resolve a provider author only through
one tenant-scoped canonical roster principal; message content and display names
MUST NOT select an Agent, establish identity, approve an action, or grant an
effect. The Sprint Domain MAY derive a typed submission and exact work-item
references from authorized projection rows. Its accepted event MUST retain the
source projection, record, and version identities. The maintained hosted mode
is proof-only and MUST refuse every compiled live communication and work-item
binding. A test publication MUST be a separate authenticated operator action.
It MUST recompute the proof-only replay, match one exact previously reviewed
output digest before the first effect, and render only a Workspace-owned
template. Dynamic provider and roster values MUST be escaped as data before
provider-markdown rendering. Its publisher Agent MUST have exactly the two
publication grants and MUST NOT be a default Agent, appear in any
conversational Agent binding, or be reachable through an Agent handoff. The Instance MUST bind one exact test channel,
one exact read-write test work-item resource, and one exact report item while
also declaring protected live provider resource ids. Workbench MUST reject
logical or physical equality between any test and protected live target.
Publication MUST cross the ordinary `communication.message.publish` and
`work-item.comment` Capability boundaries, use one deterministic effect
identity per output digest, and retain both provider receipts in System of
Proof. A retry MUST reuse prior successful effects rather than duplicate them.

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

**CRS-034 — External-Agent provider qualification.** The maintained Monday
qualification MUST bind one exact Core identity, Company Workspace, external
Agent ID, Agent-token SecretRef, `API-Version: dev`, explicit board set, and
exact expected `READ` or `READ_WRITE` resource grants before secret resolution.
It MUST accept only `external_agent_member` or
`external_agent_detached_member`, match the Agent ID from the authenticated
provider identity only within its own identifier namespace, and keep that
subject ID separate from the configured UI/callback Agent ID. Qualification
MUST pause for a second digest-bound administrator review of the exact mapping.
It MUST read only the exact selected boards and fail closed on an absent board.
A returned board proves minimum read access; an attested `READ_WRITE` board
also requires `access_level: edit` as metadata evidence but remains without a
verified write effect. Because the external Agent token cannot list `agent_knowledge`,
the confirmed board set is an administrator attestation and MUST be recorded
as such; Core MUST NOT represent it as a machine-listed complete inventory.
The qualification query MUST read only identity and selected
board/group/column metadata and MUST perform no mutation. Persisted evidence
MAY contain Agent and account identity, the digest-bound attestation, effective
selected-board access, board/group/column structure, request metadata, and a
discovery digest. It
MUST NOT contain items, updates, column values, provider credentials, or a
completed provider effect. The Agent token remains an Instance secret and is
not retained by the Workbench. The exact external Agent is the sole maintained
Monday qualification identity. `READ_WRITE` metadata qualification does not
authorize or replace a separately confirmed reversible write proof.

**CRS-035 — Record Source Connector.** A trusted Instance synchronization
worker resolves one exact versioned Record Source Connector from a non-secret
binding whose only credential reference is a SecretRef. The Connector returns
and revalidates the pinned non-secret qualification receipt before returning
one bounded complete inventory of provider observations plus payload-free
request, version, scope, count, completeness, and digest evidence. It is not an
Agent Tool, grants no Capability, performs no provider write, and MUST NOT
return or retain its credential. The maintained Monday implementation reads
one exact board through bounded cursor pagination and API version `dev`. Its
default `selected-items` mode may restrict exact groups and explicitly mapped
columns. Its explicit `complete-table` mode rejects group filters and returns
the selected board, every active group and active column, every main item,
every one-level subitem, and every returned column value as collision-free raw
record objects. A child board is readable only when its stable ID is present in
the qualified parent board's subitems-column settings; any other child board
fails closed. Raw completeness never widens a projection: Company Workspace
projections still select reviewed object kinds and canonical fields. Updates,
comments, attachment binaries, linked foreign-board contents, archived items,
deleted-item history, and multi-level subitems are separate data classes;
complete-table mode does not query them and fails closed if a deeper subitem
level is observed. Other providers require separately maintained and qualified
adapters behind the same contract.

A maintained adapter MUST normalize an empty typed identity cell to an empty
identity list while retaining the raw provider value in evidence. A Sprint
snapshot MAY preserve an absent or empty provider status as an empty canonical
status; it MUST NOT invent a company status or omit the mirrored work item.

**CRS-036 — Runtime Connector installation.** An immutable Artifact MAY carry
bounded non-secret runtime Connector instance configuration from the exact
Instance declaration. Each entry MUST pin an instance-local id, maintained
Connector id and exact version, resource or destination bindings, and only
SecretRefs for credentials. It MUST participate in Artifact hashing. A Runner
MUST reject an unsupported Connector identity or version, unresolved SecretRef,
duplicate instance id, malformed resource, and unknown configuration field.
Runtime installation MUST NOT grant a Tool, widen a Workspace Capability, or
make an undeclared resource available.

**CRS-037 — Preview Stage-0 qualification.** A maintained qualification
surface MUST be bearer protected, accept bounded exact request shapes, require
a `preview` Artifact and matching preview qualification declaration, and fail
closed in production. A reversible provider-write plan MUST freeze the exact
test resource, item, field, prior value, proposed value, expected version,
restoration value, and confirmation digest before execution. Successful
evidence MUST include read-after-write, duplicate-effect denial, self-echo
handling, restoration and final reread, plus denial of an unbound resource.
Communication qualification MUST freeze exact channel and approved-DM
destinations and content and return provider receipts. Signed callback
qualification MUST prove valid delivery, invalid-signature denial, and replay
denial. No result may contain a credential, and qualification MUST NOT imply
production activation.

**CRS-038 — Slack Record Source.** The maintained Slack adapter MUST select one
exact qualified team and allowlisted conversation, prove bot membership and
the public/private history and read scopes, and retain no credential. A
complete inventory MUST use bounded cursor pagination over history and each
declared thread, preserve the immutable raw provider payload, and normalize a
provider-neutral `communication-message` value. Limited history, incomplete
unbounded thread replies, missing cursors, conflicting versions, bounds, scope
drift, membership drift, or rate limiting MUST fail without a completeness
claim or watermark. A historical upper bound MUST exclude later live replies
from the selected inventory's completeness comparison. Qualification reads
only authenticated bot identity and exact
conversation metadata; message history is read only during a separately
planned synchronization or reconciliation. Neither path writes to Slack or
grants an Agent Capability.

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
atomic Sprint event/state/decision/intent persistence, optimistic replay,
leased intent outcomes, due-timer consumption through the same event path,
controlled-clock Sprint decisions, Tool resolution inputs, signed callback
verification, replay and echo controls, Connector behavior with synthetic
responses, hosted Artifact compilation, operator parsing and authentication,
Slack qualification and bounded threaded-history normalization, historical
proof-only replay, Slack Friday normalization after resolved identity and Agent routing, shadow
rendering without effects, exact-scope OAuth 2.1 PKCE planning, bounded read-only resource
discovery, credential-free qualification receipts, and read-only Blueprint
inspection. They do not prove a real
provider installation, exact account permission, provider cost, production
message, production database migration, scheduled execution, or Company
Workspace rollout. Those claims require separate Instance consent, non-
production qualification, staged activation, and live evidence. The Runner
implementation is inactive without a compiled Sprint binding, runtime mode,
operator/scheduler secrets, database, and explicit schedule activation.
