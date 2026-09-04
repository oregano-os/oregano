---
document_id: architecture.company-instance
title: Company Instance
kind: architecture
status: approved
authority: canonical
language: en
updated: 2026-09-03
owners:
  - oregano-maintainers
audience:
  - human
  - agent
relations:
  depends_on:
    - architecture.oregano-core
    - architecture.company-workspace
---

# Company Instance

A Company Instance is one deployed pairing of an exact Oregano Core version
and an exact Company Workspace version, connected to environment-specific
infrastructure, configuration, secrets, integrations, and operational state.
The environment is part of the identity, for example `acme-production` or
`acme-staging`.

```mermaid
flowchart LR
    C["Oregano Core<br/>release version + exact commit"] --> B["Validate and build"]
    W["Company Workspace<br/>release version + exact commit"] --> B
    B --> A["Immutable runtime artifact"]
    D["Non-secret Instance declaration<br/>exact Connector bindings"] --> B
    A --> R["Runner Adapter<br/>deployment-specific"]
    E["Runtime secret store<br/>resolved credentials"] --> R
    R --> N["StateStore<br/>reference: Neon/Postgres"]
    R --> K["Bound Connectors<br/>communication and business providers"]
```

An Instance may additionally opt into the proposal-only Builder. These
bindings are separate even when one maintained deployment hosts them:

```mermaid
flowchart TB
    A["Immutable Artifact<br/>Agents + Agent Bindings"] --> R["Runner Adapter<br/>conversation transport"]
    A --> BS["BuilderService<br/>provider-neutral control"]
    I["Non-secret Instance configuration"] --> ER["BuilderExecutionAdapter<br/>maintained: Vercel Sandbox"]
    I --> CP["Coding profile<br/>ACP v1: Claude Code or Codex"]
    I --> RS["RepositorySourceAdapter"]
    I --> PP["ProposalPublisher"]
    S["Instance secret store"] --> R
    S --> ER
    S --> RS
    S --> PP
    BS --> ER
    ER --> CP
    BS --> RS
    BS --> PP
```

Changing the runtime host does not select a repository provider or coding
agent. Changing Claude Code to Codex does not change the normal Runner. The
Workspace declares company behavior and repository identity; the Instance
binds qualified implementations, repository installations, and secrets.

The optional proposal target branch is compiled into the Artifact, copied into
each immutable job, shown during confirmation, and checked with the exact base
commit. Without it, the provider-verified default branch is used. A hosted
provider may privately compose a separate trusted Git worker when the normal
runtime lacks Git; that worker receives short-lived repository authority but
never runs the coding agent. The coding snapshot remains credential-free.

Vercel is the maintained reference runtime host, not the Instance itself.
Neon/Postgres is the maintained reference durable StateStore. Both are
replaceable adapters or services.

The Builder produces the immutable artifact. The maintained Vercel Runner
loads one integrity-checked production Artifact from the Instance secret
store, verifies Slack identities against its compiled roster before model
invocation, exposes only its resolved ToolSet, and persists Chat SDK plus
CompanyOS control state in the Instance Postgres schema. The first real
Connector publishes exact R3-approved text or HTML artifacts through Postgres
and the Runner's public artifact route. Paid-provider Connectors remain
unavailable until their own binding and rollout evidence exist.

The build-time relationship is local file composition, not a runtime API
between repositories. `companyos build` reads both clean checkouts, compiles
only scoped Workspace material and resolved Tools, combines them with the
non-secret Instance declaration, and writes one artifact. Runtime code consumes
that artifact; it does not reach back into either Git repository.

## Runtime Connector instances

Capability bindings answer which versioned Connector may implement a
provider-neutral Capability. Runtime Connector instances answer how that
implementation is installed for one exact environment. The non-secret
Instance declaration may therefore contain a bounded `connectors` list. Each
entry pins an instance-local identifier, maintained Connector identity and
version, exact resource or destination bindings, and SecretRefs such as
`env:MONDAY_API_TOKEN`. The resulting Artifact contains those non-secret values
and includes them in its content hash. Resolved credentials never enter the
declaration or Artifact.

The maintained Vercel Runner constructs only explicitly supported Connector
identities from that frozen list. The Monday work-item Connector resolves one
token SecretRef and exposes only named boards, permissions, and logical field
mappings. The Slack communication Connector exposes only named channel or DM
destinations. The Company Records Connector resolves one environment-specific
configuration SecretRef, verifies that its Instance, Core, and Workspace
identities match the Artifact, registers the reviewed projections, and reads
their rows from the Instance Postgres store. A Workspace grant does not add a
resource, destination, or credential; a configured Connector instance does not
add a Tool grant. Both the ToolSet and Instance binding must agree before a call
can reach a provider.

Slack presentation is an independent Instance concern. A Company Instance may
set `COMPANYOS_SLACK_AGENT_VIEW=true` only after its existing Slack app has the
Agent experience enabled and its installation has granted `chat:write`. The
maintained Runner then presents the same external Oregano identity through
Slack Agent View and uses Slack Agent Sessions to request one best-effort native
`Working` status after the sender has passed the roster check, the message has
passed the duplicate guard, and the deterministic CompanyOS Agent has been
resolved. For a DM subscribed before Agent View was enabled, the Agent Session
status and reply target the accepted inbound root message; durable conversation
and Agent assignment identities remain unchanged. The status clears when the
response is posted. If the app subscribes to Slack's
`agent_session_stopped` event, the native stop control aborts the active model
turn. A short-lived, exact session-to-conversation mapping preserves that
behavior for pre-Agent-View DMs across serverless invocations. Stopping a turn
does not undo a Tool effect that already completed. New sessions receive a
deterministic title from the first line of the accepted root message; no model
call or additional data access is involved, and users remain free to rename,
pin, or archive the session in Slack. Ordinary conversational answers without
granted Company business Tools use Slack's native streaming API so text appears
while the model is generating it. For Company business-Tool-bearing,
required-grounding, Builder, approval, and effect-bearing turns, the Runner
keeps provisional model prose private, presents Tool execution as live native
task progress without Tool inputs or outputs, and streams the exact validated
final CompanyOS presentation afterwards. An explicit pending approval or
Builder confirmation leaves the Agent Session suspended; an ordinary completed
turn returns it to active. Setup verification remains one exact, buffered proof
response. This is
presentation only: it cannot select an Agent, grant a Tool, change an approval,
or prove an effect. The setting defaults to disabled so another Company
Instance is never migrated implicitly.

Suggested prompts, active-view context, Slack MCP, feedback controls,
model-generated session titles, and rich work objects are not part of this
minimal presentation mode. Those
features require separate reviewed contracts rather than prompt or provider
configuration being treated as authorization.

For rollout qualification, the Runner may expose a bearer-protected Stage-0
surface in a `preview` deployment. It binds one test Artifact and a separate
compressed, non-secret qualification declaration. A Monday write is first
frozen as a digest-bound plan, then uses optimistic versioning, read-after-
write, duplicate and self-echo controls, restores the prior value, and rereads
it. Slack qualification similarly freezes exact test-channel and approved-DM
content and returns provider receipts. Unknown boards or destinations fail
before a provider call. Callback qualification proves valid signature,
invalid-signature denial, and replay denial. This harness cannot run with a
production Artifact and is evidence for the named test resources only; it is
not production activation.

## Reference deployment and replacement boundary

The maintained reference deployment uses a company-controlled Vercel
account/team/project and a company-controlled Neon/Postgres project. This makes
the onboarding path concrete and testable; it does not make either provider a
CompanyOS architectural dependency.

Workbench setup code reaches providers through a private typed boundary with
four roles: source host, runtime host, state service, and communication
provider. Model execution uses the separate Core recipe registry because it is
consumed by the Runner rather than by installation resource orchestration. The maintained
`vercel-neon-slack` profile binds the four setup roles to GitHub, Vercel,
Neon/Postgres, and Slack and supports Gateway, native Anthropic/OpenAI/Google,
and named compatible cloud execution. The boundary exists to keep provider
SDK behavior, eventual-consistency handling, and resource receipts out of Core
runtime semantics. It is deliberately not a public plugin registry: a new
Hetzner, Docker, Railway, Supabase, or communication binding is introduced as a
separately qualified adapter and profile without changing the provider-neutral
Instance identity, Artifact, Tool, evidence, or readiness contracts.

A replacement runtime host must preserve environment isolation, scoped
deployment identity, secret injection, immutable deployment provenance,
observable health, and rollback. A replacement StateStore must preserve the
specified transactional, idempotency, evidence, retention, backup, and recovery
contracts. Provider account IDs, project IDs, tokens, and secrets belong to the
Instance configuration or CI secret store, never the Company Workspace.

Runtime secrets live in the target environment's secret store. Deployment
credentials live in CI secrets. The Workspace declares required logical
connections, allowed scopes, and secret references but never contains values.
Local development uses an ignored `.env.local` populated from an approved
secret source.

The maintained GitHub repository binding uses one service-owned GitHub App per
service environment. Each company installs that same App and selects its
repositories; customers do not create an App or copy a long-lived token.
Verified installation and repository identities are durable Instance state.
Separate short-lived, repository-scoped credentials are minted for exact
source acquisition and checked proposal publication and never enter Builder
jobs or coding-agent processes.

The isolated coding snapshot pins the ACP SDK and Claude Code/Codex adapters.
General provider keys remain ordinary Instance secrets named
`ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, not Builder-specific configuration.

Database setup distinguishes resource provisioning from schema preparation.
The State Service adapter first creates or explicitly adopts one database
resource. The runtime-host adapter then starts the provider-neutral
`companyos database prepare` operation in a secret-bound process. Prepare
detects whether the database is empty, behind the current manifest, or already
current and selects `bootstrap`, `upgrade`, or read-only `verify`
accordingly. Bootstrap is the empty-database primitive; preparation creates or
upgrades both maintained schemas and records an immutable version-manifest
ledger entry. `companyos database verify` performs the corresponding explicit
read-only catalog qualification. Setup state retains only the selected
operation, previous manifest versions, resource identity, manifest identity
and digest, feature evidence, counts, and qualification time. It never
retains `DATABASE_URL`. The maintained Vercel adapter uses `vercel env run` as
its secret transport, while another qualified runtime adapter may provide an
equivalent process without changing the database manifest.

Company Record Source delivery uses the same replacement boundary. The
provider-neutral Workbench orchestrator freezes declarations, bindings,
qualification evidence, exact identities, independent confirmation hashes, and
payload-free completion evidence. Its first narrow `vercel-neon` rehearsal
profile knows how to reach the protected Vercel Preview endpoint backed by an
isolated Neon/Postgres branch. It does not know the business provider or
company mapping; those resolve through the maintained Record Source Connector
and the exact Workspace/Instance material. A future runtime or StateStore adds
another qualified profile behind this contract instead of another Record
Source lifecycle. The profile starts after infrastructure and Preview-only
Sensitive values exist and never creates, deletes, or activates them.

Production health is read-only with respect to schema. It verifies the exact
recorded manifest and required schema objects and cannot create or alter tables
as a side effect of a readiness request.

The current additive database manifest is `companyos-postgres@1.9.0`. It
retains the immutable `1.8.0`, `1.7.0`, `1.6.0`, `1.5.0`, `1.4.0`, `1.3.0`, `1.2.0`, `1.1.0`, and `1.0.0` ledger identities,
contains 67 required `companyos_knowledge` tables, and contains 14 required
`companyos_records` tables for provider-neutral Record Source and Sprint state. Phase 3 adds durable Source
Events, provider ACL snapshots, bounded pipeline receipts, completed
watermarks, an integrity-linked Knowledge change stream, and governed source
lifecycle requests. Phase 4 adds a durable lease per Source reconciliation
stream so overlapping schedules cannot process the same partition concurrently.
Phase 5 adds durable compounding leases and receipts, review-only Claim-pair
proposals, and explicit grading requests. Phase 6 adds policy-bound model-task
results, atomic spend reservations, and a rated execution ledger. Phase 7 adds
rebuildable Retrieval V3 projection runs and Units plus payload-free
KnowledgeBench, shadow-comparison, and productization receipts. When `pgvector`
is available, the two optional vector tables retain Handbook-fragment and
Retrieval-Unit embeddings; neither is durable company authority.
Phase 8 adds provider-neutral Record Source state. Phase 9 adds atomic Sprint
event, monotonic state, decision, and intent persistence plus a bounded leased
intent queue. Installing or qualifying these relations does not start a Sprint,
schedule a timer, dispatch a message, or enable a provider effect.
The reusable activation path qualifies a fully isolated non-production
Instance. Oregano HQ also has one explicit internal-dogfood production-canary
path: a Neon point-in-time branch rehearses the additive migration, production
V3 is built verified but inactive, shadow execution continues serving V2, and
an exact Agent allowlist plus projection hash gates canary service. This path
does not require duplicate Slack, Granola, model, or Vercel bindings, does not
permit external-user traffic, and does not weaken the generic isolation
contract. Invalid mode, projection, allowlist, or candidate execution falls
back to V2. Database projection activation separately requires a persisted
qualification receipt.
Runtime readiness is a separate gate: the Core-resolved
subject and groups must pass policy intersection before retrieval, graph
traversal, review hydration, citations, or model context. Unknown mappings and
quarantine fail closed.

Every release records at least the Instance ID, environment, Core version and
commit, Workspace version and commit, deployment ID, specification version,
Workbench version, governance hash, resolved toolset hash, and build timestamp.
A rollback points to an existing immutable artifact; it does not rebuild old
sources with new dependencies.

The reference Runner receives its immutable Artifact as a gzip-compressed
deployment environment value. It recomputes the content hash before accepting
traffic and refuses an Artifact whose declared environment is not
`production`. The value is generated from clean exact checkouts and is never a
source of editable operating truth.

## Maintained supervised starter

The experimental `vercel-neon-slack` setup profile is the first bounded
deployment path for a new company. It starts from the release-matched Codex or
Claude Code runbook, creates or adopts one explicitly named private GitHub
repository, Vercel project, Neon Marketplace resource, and Slack Vercel Connect
resource, and converts the local baseline through a separately confirmed
operating Workspace change. The change contains one supervised `oregano`
Agent, one Slack workflow, a non-secret connection declaration, and an empty
business ToolSet.

Provider browser authentication and consent remain human actions. The setup
state contains versioned write-ahead intents, immutable provider receipts,
identifiers, hashes, phase status, and non-secret evidence only. A provider
mutation is preceded by an intent and followed immediately by its receipt, so
resume can reconcile an interrupted operation by immutable identity instead of
creating a duplicate from a name-only search. Database URLs, provider
credentials, private keys, immutable Artifact content, and short-lived Slack
user credentials are excluded. The Slack credential used to resolve the
consenting human's canonical team and user IDs exists only in memory and is
discarded after the identity call.

The maintained Vercel project is configured with `packages/runner-vercel` as
its root, and setup refuses to overwrite a conflicting adopted root or
production environment value. The Slack binding uses the fixed Connector UID
`slack/oregano` and visible Agent name `Oregano`; provider-internal resource
names may remain company-specific but do not become the Agent identity.

Model execution resolves through the Core recipe registry. The maintained
setup binds Gateway, native Anthropic/OpenAI/Google, or a named compatible
cloud recipe. The registry also supports explicitly configured LiteLLM,
Ollama, llama-server, and generic OpenAI-compatible endpoints; those endpoints
must be reachable from the selected runtime and are not assumed to exist on a
Vercel deployment. Gateway uses the Vercel deployment identity. Native routes
use official provider adapters; named compatible routes reuse one shared
OpenAI-compatible transport with per-provider credentials and endpoints.
Vercel is only the runtime host and secret store in this profile. Provider
API-key values exist only as Sensitive Production runtime variables. Setup
records the non-secret reference, presence, and Sensitive classification,
never the key. Health, production confirmation, and response evidence bind the
route and exact model.

`COMPANYOS_MODEL_CONFIG_BASE64` may bind exact tasks, profiles, and a default.
Those bindings override the simple `COMPANYOS_MODEL_ROUTE` and
`COMPANYOS_MODEL` pair. Without either form, key-aware resolution uses the
documented Anthropic-then-OpenAI priority before the Gateway default. No
resolved request silently fails over across providers.

`COMPANYOS_KNOWLEDGE_MODEL_CONFIG_BASE64` accepts the same provider-neutral
shape and overrides the shared bindings only for registered Knowledge prompts.
This permits retained evidence to use a direct provider without changing the
interactive Agent. The maintained setup preset pins utility, reasoning, and
deep Knowledge tasks to direct Anthropic Haiku 4.5, Sonnet 4.6, and Opus
4.7. Embeddings and cross-encoder reranking remain separately configured
capabilities.

The path creates an immutable Artifact only from clean exact Core and Workspace
commits, deploys only after an exact candidate confirmation, verifies current
health, and requires one nonce-bound Slack input plus a real selected-model call
that returns the exact reply `Setup-Test <nonce> successful.`. Both entries and
non-secret model response evidence are persisted in the same Neon conversation. Live
verification ties that proof to the immutable provider and deployment receipts
and fails closed on unresolved setup intents. Its completion scope is
`live-starter-instance` with derived readiness `validated`. This is not a
general deployment or promotion orchestrator and does not prove `enforced`
readiness, unattended eligibility, arbitrary Tool grants, or future provider
effects.

## Event-driven runtime and Gateway boundary

The maintained Sprint Agent V1 topology uses event-driven Instance endpoints,
asynchronous processing, durable StateStore state, and executable provider
adapters. It does not require a long-running Instance Gateway. Existing
boundaries provide the required responsibilities:

```mermaid
flowchart LR
    P["Provider event or schedule"] --> A["Thin Instance adapter<br/>verify and normalize"]
    A --> E["Provider-neutral event"]
    E --> Q["Asynchronous processing"]
    Q --> S["Core Sprint module"]
    S --> C["StateStore, ToolSet,<br/>approval, effect, and evidence controls"]
    C --> O["Thin Instance adapter<br/>provider effect"]
```

The provider adapters own protocol verification, acknowledgement, and mapping,
but remain thin. Provider SDKs MUST NOT be imported by the provider-neutral
module. Idempotency, ordering, evidence, retry, and reconciliation MUST NOT
exist only in an endpoint process. Durable authority remains in StateStore and
Core controls; a queue is an execution mechanism, not an authority boundary.
Webhook and scheduled execution enter the same provider-neutral module path.

The maintained records foundation uses an additive `companyos_records` schema
inside the existing Company Instance database. It is isolated from the
`companyos` and `companyos_knowledge` schemas and contains immutable source
events and object versions, current pointers, rebuildable projection rows,
access decisions, synchronization receipts and watermarks, leases, durable
timers, Connector echo receipts, and callback replay claims. The schema is
prepared idempotently when the records implementation is activated; Core
release alone does not migrate a real Instance. Synchronized values remain
operational evidence and do not become Handbook or provider authority.

The maintained Monday adapter is Core-owned privileged Connector code, while
the board account, external Agent registration, permissions, board grants,
callback route, signing material, exact resource bindings, and activation
receipts are Instance state. Conversational callbacks are signature- and
replay-verified before `AgentResolver` selects the compiled Agent. A separately
qualified board-change subscription would bypass the chat prompt and enter the
records and Sprint path; a conversational external-Agent callback MUST NOT be
treated as that subscription. An
outbound Sprint message similarly resolves the provider-neutral
`communication.message.publish` Capability to an exact destination binding;
the Sprint Blueprint does not know a channel ID.

A Sprint Instance may instead declare its compiled execution as `shadow-only`.
That mode retains exact destination metadata for deterministic rendering and
proof but requires no provider-effect Tool grant or Capability binding. The
hosted Runner rejects an `active` environment for that Artifact before it can
construct an active dispatcher. This is stronger than relying only on a runtime
branch after an effect-capable ToolSet has already been granted.

The first maintained external-Agent runtime ingress implements Monday's exact
signed synchronous callback and SSE/JSON acknowledgement formats. It binds an
Instance-injected account id, external Agent id, and signing secret, retains
only a digest for replay prevention, and rejects a wrong Agent identity before
dispatch. Monday's current pre-release trigger envelope authenticates the
external Agent callback but does not identify the human who initiated chat,
mention, or assignment. That provider fact is insufficient to authorize a
human principal. Ordinary interactive traffic therefore fails closed before
Company Workspace material, model invocation, Tool resolution, or effect
execution. A deterministic setup proof remains available to qualify delivery;
mention and assignment receive protocol acknowledgement only. Company data or
Tools require a later provider identity fact or separately approved
authorization design. Board grants and outbound Agent-token actions remain
distinct Instance effects.

The maintained Monday qualification uses that same external Agent rather than
a second provider identity. `companyos records source qualify --provider
monday` binds one clean Core checkout, exact Company Workspace, external Agent
ID, `API-Version: dev`, administrator-attested complete resource-grant set, and
explicit board IDs before resolving the Instance SecretRef. It accepts only
`external_agent_member` or `external_agent_detached_member`, derives the Agent
subject ID from its provider identity, and records it separately from the
configured UI/callback Agent ID because monday uses different identifier
namespaces. A second digest-bound administrator review confirms that exact
mapping. Qualification reads only the explicitly selected boards. Successful
return proves at least read access; `access_level: edit` is required as metadata
evidence for an attested `READ_WRITE` board but does not prove a completed write
effect. Monday does not expose `agent_knowledge` to the external Agent token, so
the receipt distinguishes the administrator's complete-set attestation from
machine-proven effective selected-board access. Only Agent and
account identity, attestation evidence, effective access, board/group/column
structure, request evidence, and a discovery digest enter the mode-0600
Instance qualification receipt. The Agent token remains in the protected
Instance secret surface and is not retained by the Workbench. Qualification
creates no Agent, grant, callback, board change, or write. A later reversible,
separately confirmed effect is still required to prove an operational write.
The external Agent is the sole maintained Monday qualification identity.

After qualification, Company Records uses a separate non-secret Instance
binding. It selects one exact Record Source Connector version, Instance and
source identity, logical resource binding, provider configuration, and one
SecretRef. It also pins the non-secret qualification receipt and its digest so
resource and scope evidence cannot be substituted at apply time. The
credential value and `DATABASE_URL` remain in the Instance runtime secret
surface. `companyos records source materialize` may turn an
explicitly authored source draft into one reviewable Workspace file only when
the named board and mapped columns exist in the non-secret qualification
receipt. It never invents a mapping or commits the file.

`companyos records source sync` and `reconcile` share the same provider-neutral
plan/apply boundary. The plan resolves no credential and calls neither the
provider nor the database. Apply first verifies the exact plan hash, then the
trusted synchronization worker resolves the Connector and SecretRefs. `sync`
appends observations and projections without inferring deletion. `reconcile`
may record provider-absence tombstones only after one bounded complete
inventory under the durable source lease. Both advance the watermark only
after successful completion and store a receipt; neither grants an Agent a
Tool or performs a provider write. `status` is payload-free and read-only and
does not create the records schema when it is absent.

When secrets can be resolved only inside a hosted Instance, the maintained
Vercel Runner may expose the same operation through a temporary preview-only
rehearsal lane. The lane accepts runtime-injected declarations, qualification
evidence, bindings, exact Core and Workspace refs, and source confirmations;
none are compiled into Core. It requires a constant-time bearer secret and an
exact `VERCEL_GIT_COMMIT_SHA`, separates additive schema migration approval
from provider synchronization approval, and returns payload-free receipts. It
cannot run in production and cannot reconcile absence, activate a schedule or
webhook, invoke a model or Tool, or write to a provider. Preview deployment,
database branching, secrets, protection, cleanup, and retained evidence remain
Instance responsibilities.

The maintained Vercel Runner also exposes a separate production-only Company
Records lane. `POST /api/records/operations` is authenticated by an
Instance-owned operator bearer and supports payload-free planning, exact
confirmation of the additive database manifest and initial synchronization,
full reconciliation, and status. It requires `VERCEL_ENV=production`, the
exact deployed Git commit, and exact Core, Workspace, and Instance identities
from the production Artifact. `COMPANYOS_RECORDS_ENABLED` is the mutation kill
switch. An exact completed confirmation reuses its stored receipt instead of
reading the provider again.

`GET /api/records/reconcile` is a distinct `CRON_SECRET`-authenticated scheduler
surface. The hosting cron is only a 15-minute wake-up adapter. Reviewed Instance
configuration supplies each source's IANA time zone, local service time,
weekdays, and bounded retry window. Core runs only a due configured source,
uses a stable service-day run identity and the durable source lease, and reuses
an existing completion receipt. `COMPANYOS_RECORDS_SCHEDULER_ENABLED` activates
or disables recurring work independently from operator preparation. A complete
inventory is mandatory before absence can become a retained tombstone. Neither
production route modifies a provider, sends a message, invokes a model, grants
an Agent Tool, or turns a conversational callback into a board event.

The maintained Company Instance database manifest includes Record Source
relations from version `1.8.0` and Sprint orchestration relations from version
`1.9.0`. Production migration remains an
explicit exact-plan Instance effect; deploying Core alone does not apply it.
Database qualification and `/api/health` then prove the exact records table and
index set along with the control and knowledge schemas.

The maintained Vercel Runner hosts the reusable Sprint orchestration library.
An authenticated operator action may inspect or open one compiled Sprint from
fresh authorized Company Records projections. Separate `CRON_SECRET`-protected
timer and intent routes wake bounded durable workers; the hosting cron contains
no company cadence. Authenticated Slack messages first pass roster
authorization and deterministic `AgentResolver` routing, then an exact Friday
template may normalize into a Sprint event. Message content identifies the
action only; it grants no authority and does not select the Agent.

Friday Close is one ordered shared-channel thread. The reminder publication
creates the provider thread reference, and the Runner persists a Chat SDK
subscription before treating that root publication as complete. Participant
submissions are accepted only in that exact thread. The chase, completeness
report, and retrospective are replies to the same reference, and each
successful provider receipt is normalized back into the durable Sprint event
stream before the next step may become eligible. Direct-message bindings
remain available for separately declared one-to-one Sprint interactions; they
are not the Friday reminder path.

Monday handoff, weekday movement digest, and configured readiness checkpoints
are additional compiled weekly triggers. Immediately before processing due
weekly timers, the Runner resolves a twice-stabilized current work-item
projection and appends its exact source version to the Sprint event stream.
The Sprint's participant scope stays frozen; only work facts refresh. An
unchanged source version is replay-safe and creates neither duplicate decisions
nor duplicate effects.
At the readiness checkpoint, the runtime may set or invalidate only the exact
Instance-bound secondary readiness field with the observed provider version;
it never changes the authoritative provider group.

Workbench compiles the reviewed Sprint declaration, immutable schedule
manifest, calendar, Workspace-owned templates, logical Agent, service
principal, participant identity namespace, and exact destination/resource
bindings into the Artifact. The maintained dispatcher then enters the ordinary
`CompanyOSRuntime` Tool boundary; it does not bypass Agent, ToolSet,
Capability, authorization, idempotency, effect, or evidence controls. In
`shadow` mode rendered content is represented only by digests and no provider
effect occurs. In `active` mode messages may use an already authorized Tool. A
briefing update may use the narrow subject-confirmation path only when the
confirming active human is the exact proposal owner and the Tool risk is below
R3. Rollover is a separate frozen R3 batch: automatic processing records only
the proposal, ordinary approval authorizes the exact set, all items are
preflighted before the first write, and partial dispatch is recorded as an
unknown outcome rather than retried.
Missing or stale projections, schedule coverage, identity mappings, bindings,
grants, or dispatchers fail before an effect.

The initial hosted rollout refreshes Monday-backed projections by bounded
polling and treats Slack as the interactive surface. Monday board-change
webhooks and Monday card chat are not initial-rollout requirements and require
later qualification before activation.

A shared Runtime Kernel is considered only after a second independent module
demonstrates repeated ingress and dispatch logic that cannot be kept coherent
through the existing contracts. An Instance Gateway is considered only when
implementation evidence shows at least one of these needs:

- persistent channel or socket connections;
- central lifecycle and routing for multiple channels or agents;
- live Workbench or control-client streaming;
- remote execution nodes;
- central adapter start, stop, and health supervision; or
- failure of the event-driven deployment topology to meet documented
  operational requirements.

Crossing either promotion gate requires a separate approved Core Change Plan.
Anticipated ecosystem growth by itself is not sufficient evidence.

## Derived readiness

Instance readiness belongs to one exact Core, Workspace, and environment
pairing. It is derived rather than written into `company.md`:

| Readiness | Meaning |
|---|---|
| `declared` | Required Workspace and Instance contracts exist and identify their intended dependencies. |
| `validated` | Deterministic validation succeeds for the exact version pair and environment configuration. |
| `enforced` | The deployed runtime proves that required controls, resolved Tools, approvals, effect handling, evidence, and rollback operate as declared. |

Workbench validation can establish structural evidence and report missing
external checks. Only deployment and runtime evidence can establish
`enforced`. The same Instance may run supervised and unattended workflows;
readiness for unattended execution is evaluated against the stricter workflow
and effect requirements instead of inferred from a global profile.

## Knowledge state in the Company Instance database

Company Knowledge V1 does not create a second database. The existing
`DATABASE_URL` contains `companyos` for control state and
`companyos_knowledge` for snapshots, documents, fragments, lexical/graph and
optional vector projections, index receipts, review candidates, source
bindings/receipts/object versions/inventory, and Runtime Observation lifecycle
evidence. Its inactive Brain foundation additionally owns versioned Pages,
Claims, Holders, entity identity, ACL records, raw assets, timelines, sourced
and inferred edges, syntheses, promotion and decision evidence, sessions,
extraction runs, cursors, calibration, merge, and export ledgers. Every query
qualifies its schema. Source bindings persist SecretRefs, never resolved
credentials.

A bundle is staged idempotently by hash, verified against stored counts, and
only then activated. Exactly one verified snapshot is active. Documents,
fragments, graph edges, lexical indexes, and embeddings are rebuildable
projections; review decisions, source receipts and versions, observation
events, deletion requests, legal holds, and activation receipts are durable
Instance evidence. Rollback explicitly reactivates a prior verified snapshot.
`pgvector` creation is optional and its absence keeps lexical retrieval active
with a recorded degradation.
