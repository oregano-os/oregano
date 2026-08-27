---
document_id: specification.company-knowledge-v0.2
title: Company Knowledge v0.2 Specification
kind: specification
status: approved
authority: normative
language: en
updated: 2026-08-27
owners:
  - oregano-maintainers
audience:
  - human
  - agent
relations:
  depends_on:
    - specification.company-knowledge-v0.1
    - specification.companyos-core-v0.7
    - specification.tool-architecture
    - architecture.boundaries
---

# Company Knowledge v0.2 Specification

## 1. Scope, compatibility, and implementation status

Company Knowledge v0.2 defines the target contract for the Company Brain,
Source Connector 2.0, automatic evidence processing, authorized retrieval,
cited Agent answers, working synthesis, and governed Handbook promotion. It is
an additive successor to Company Knowledge v0.1. The exact reviewed Handbook in
one Company Workspace remains the only curated company authority.

This specification is approved before all of its runtime behavior is active.
An implementation MUST advertise only the individual contracts and versions it
has qualified. The presence of a table, type, prompt, Connector installation,
or provider credential MUST NOT be reported as an active capability.

Core now implements the contract mechanisms through Phase 8, including exact
local and maintained Source ingestion, model and Prompt Registry boundaries,
authorized retrieval and answers, governed Handbook promotion, cutover gates,
and operational qualification. Production Source bindings, model task-profile
bindings, backup restoration, alert delivery, and full cutover remain
Instance-specific activation evidence and are not implied by that Core status.

The existing Source Connector `1.0.0`, Knowledge Provider and Tool contract
`3.0.0`, Runtime Observation `1.0.0`, OKF `0.1`, and historical database
manifests through `companyos-postgres@1.4.0` remain supported until their
documented replacement gates are met. The current additive schema target is
`companyos-postgres@1.5.0`. Unknown major versions fail closed.

## 2. Authority layers

CompanyOS separates four knowledge layers:

1. **Raw Evidence** is immutable, source-attributed material and provider
   lifecycle evidence. It can support extraction and review but cannot become
   company authority by itself.
2. **Company Brain** is automatic, evidence-bound working memory containing
   Pages, Claims, Holders, Timeline Events, graph edges, identity decisions,
   and working syntheses. Brain material may be current, contested, stale,
   proposed, resolved, superseded, or quarantined. It is not authoritative
   merely because it is active or model-generated.
3. **Review and decision state** records attributed proposals, conflicts,
   corrections, promotion candidates, and Decision Receipts. Review changes
   state but does not bypass normal Workspace protection.
4. **Handbook** is curated OKF in the exact reviewed Company Workspace commit.
   Only the normal proposed diff, human review, merge, build, verification, and
   activation path changes authoritative Company Knowledge.

An Agent response MAY combine authorized evidence from multiple layers, but it
MUST label the layer and authority status of every supporting item. A response
MUST NOT present Brain inference as Handbook policy.

## 3. Storage, provisioning, and projection

One operating Company Instance uses one StateStore database and one
`DATABASE_URL` SecretRef. Control state uses `companyos`; Knowledge state uses
`companyos_knowledge`. CompanyOS MUST NOT require a second database or mount an
external source as a second authority.

Provisioning creates or adopts the database resource. Connection binding makes
the secret available only inside an approved secret-bearing process. Bootstrap
prepares an empty database. Upgrade applies additive versions to an existing
database. Qualification is a separate read-only check that records a
non-secret receipt. Runtime health verifies readiness and MUST NOT perform
production DDL.

Lexical indexes, embeddings, graph projections, context packs, and cached
ranking features are rebuildable projections. Raw Evidence, Page versions,
Claim evidence, decisions, receipts, and exact Handbook versions are durable
records. Every durable object carries the source, policy, digest, version, and
time provenance required to explain it.

## 4. Page taxonomy and identity

Core taxonomy pack `1.0.0` registers exactly these base Page types:

- `person`
- `company`
- `media`
- `tweet`
- `social-digest`
- `analysis`
- `atom`
- `concept`
- `source`
- `deal`
- `email`
- `slack`
- `meeting`
- `conversation`
- `writing`
- `project`
- `note`
- `event`
- `diary`

The registry is extensible and MUST NOT be implemented as a closed database
enum. An extension records namespace, version, owner, aliases, optional parent,
and compatibility. `note` is the catch-all only when no narrower registered
type is proven.

A Page has stable source-specific identity and immutable, contiguous versions.
The current pointer may advance but prior versions are never rewritten. Exact
retries are idempotent. Reuse of an identity or version with different content
fails closed.

Source-specific Page identity and cross-source Entity identity are separate.
Deterministic provider identifiers or administrator-maintained mappings may
create direct Entity membership with a receipt. Name similarity, embeddings,
or model judgment create proposals only. One attributable acceptance decision
is required before a proposal creates membership. Entity linking never widens
the access policy of any member.

## 5. Claims, Holders, evidence, and correction

A Claim is evidence-bound structured knowledge with one of two memory classes:

- A **Fact** is active hot memory owned by one principal and explicitly scoped
  to a principal or session. Deterministic consolidation may convert supported
  Facts into a durable Take and records a consolidation receipt.
- A **Take** is durable epistemic memory with exactly one primary Holder. The
  Holder is the person, group, company, source, or unresolved identity whose
  assertion the Take represents. Speakers, authors, subjects, approvers,
  owners, beneficiaries, and affected parties are separate relations.

A source-literal Take MAY become active when it preserves an exact source
statement, exact evidence locator, resolved Holder, source and object version,
and access policy. A model-derived Take is always `proposed` at creation,
regardless of confidence. A model does not approve its own Take.

Claim identity is digest-idempotent. Evidence points to exact immutable source
versions and locators. Claim validity, temporal scope, typed value, ontology
mapping, supersession, status, and resolution are explicit fields rather than
prompt-only metadata.

Outcome grading produces a resolution proposal. Outcome evidence MUST postdate
the Claim and MUST include evidence independent from the Claim's original
source version. Grading does not auto-apply a resolution. Corrections preserve
the superseded Claim, decision, evidence, actor, and time.

## 6. Authorization

Every Source has a root access policy. Objects may preserve or narrow their
parent policy but never widen it. Derived objects use the intersection of every
supporting policy. Explicit deny wins over allow. Missing, inactive, revoked,
conflicting, or unresolved policy and principal mappings fail closed.

Provider ACLs map external identities to stable CompanyOS principals and
groups. A mapping failure routes the object to the reserved administrator-only
quarantine. A Connector handling sensitive or personal material MUST prove its
ACL mapping behavior, including negative retrieval, before activation.

Authorization runs before:

- lexical, vector, and reranking candidate generation;
- exact hydration and excerpts;
- graph and Timeline traversal;
- citation rendering;
- review display;
- context-pack construction;
- model invocation; and
- answer rendering.

An inaccessible exact identity is indistinguishable from an unknown identity.
Graph edges, counts, ranking movement, gaps, truncation, logs, metrics, and
receipts MUST NOT disclose protected content or adjacency. Access-decision
evidence records stable identity, policy, permission, outcome, reason, and a
hashed object identity, never a query, excerpt, transcript, or protected body.

## 7. Source Connector 2.0

### 7.1 Contract boundary

Source Connector `2.0.0` is provider-neutral and supports these source kinds:
`repository`, `meeting`, `messaging`, `email`, `document`, `local-file`, and
`session`. Delivery mode is `pull`, `webhook`, or `hybrid`.

A Source requirement declares:

- stable Source identity and kind;
- delivery mode and provider scope;
- data owner, data class, and personal-data posture;
- retention, legal hold, and freshness;
- allowed media types and inline and asset size limits; and
- fixed, provider-mapped, or quarantine access policy.

An Instance binding separately declares the exact Connector installation and
version, Source contract version, provider identity, required provider scopes,
SecretRefs, state, and optional qualification receipt. Requirements contain no
credential. Bindings contain SecretRefs only. Resolved values MUST NOT enter a
Workspace, Artifact, event, cursor, receipt, log, diagnostic, or persisted
binding row.

Installation, binding, qualification, activation, Tool grants, and individual
effect approval are distinct states. Installation or binding alone cannot
activate ingestion.

### 7.2 Source Events and delivery

The normalized event types are `created`, `updated`, `deleted`, and
`access-changed`. A Source Event contains the Source and tenant identities,
stable delivery identity, event type, Source Object identity, optional object
version, occurrence and observation times, locator, and optional cursor,
watermark, and access version. It contains no provider payload or content.

Events are at-least-once. The canonical event digest provides deterministic
deduplication. A webhook Connector verifies the signature over the unmodified
raw body, normalizes bounded event references, durably enqueues them, and
acknowledges without fetching or analyzing content synchronously. Pull and
hybrid delivery advance a completed cursor or watermark only after every page
and enqueue operation succeeds.

`enumerate`, `read-changes`, webhook validation, `fetch`, `read-access`,
`health`, and `revoke` return versioned, non-secret receipts. Unknown event,
kind, delivery mode, MIME type, ACL mode, contract version, or provider scope
fails closed.

### 7.3 Source Objects, content, and Raw Assets

Provider event identity, Source Object identity, provider object version,
content digest, cursor, locator, Raw Asset identity, and access version are
separate fields. One fetched envelope carries exactly one of:

- bounded inline textual content whose byte count and digest are verified; or
- a Raw Asset reference whose asset identity, media type, byte count, content
  digest, and storage key match the envelope.

Large and binary content uses a qualified Raw Asset adapter. The adapter is not
an authority and cannot return content until the caller passes the same access
policy evaluation as the envelope. Storage keys and receipts contain no signed
download URL or credential.

### 7.4 V1 compatibility

Repository Source Connector `1.0.0` remains an explicit compatibility input.
Its requirement and binding normalize to a pull-mode repository V2 profile,
preserving Source ID, provider object path, provider version, content digest,
retention, cursor semantics, and Connector identity. V1 business-only content
continues through quarantine until its reviewed policy is established.

Compatibility is an adapter, not silent reinterpretation. It emits a versioned
receipt and never rewrites existing envelopes, history, or receipts. An
unsupported V1 shape or version fails closed.

## 8. Connector registry and binding resolution

Core maintains a static registry of maintained Source Connector descriptors and
factories. A descriptor declares exact Connector and Source contract versions,
supported source kinds, supported delivery modes, and an implementation digest.
The Instance binding selects one exact installed implementation.

Resolution rejects duplicate descriptors, ambiguous versions, missing
implementations, unsupported kinds or modes, incompatible contract versions,
revoked bindings, inactive bindings for ingestion, missing qualification, or a
qualification digest that does not match the implementation. No provider call
occurs after a failed resolution.

Generic source commands and ingestion orchestration depend only on the registry
and Source Connector contract. They MUST NOT import, construct, or branch on a
provider implementation. The maintained static registry preserves a future
Connector Package seam but v0.2 does not allow arbitrary in-process module
loading.

## 9. Shared ingestion pipeline

Every delivery mode follows one pipeline before Page, Claim, graph, synthesis,
or Handbook logic:

1. validate and persist the Source Event;
2. deduplicate the stable delivery identity;
3. fetch or record provider deletion;
4. verify Source, object version, size, encoding, MIME type, digest, and Raw
   Asset integrity;
5. fetch and normalize access evidence;
6. establish the Source root and object policy or quarantine;
7. run corruption, credential, repetition, content-policy, and prompt-injection
   sanity checks;
8. persist immutable Raw Evidence and receipts;
9. append an integrity-protected change-stream entry; and
10. enqueue bounded extraction work without advancing a partial watermark.

Retries are idempotent. One provider object version maps to one immutable
durable version. A complete fresh inventory may mark absent objects as provider
deleted. A partial, resumed, changed, or bounded inventory cannot reconcile
deletion. Processing failures keep a retryable state and do not discard
evidence or falsely acknowledge completion.

## 10. Retention and lifecycle

Durable Company Brain evidence is retained unless an explicit governed
retention or deletion decision applies. Provider deletion records absence; it
does not by itself erase retained evidence. `retain` has no automatic purge
deadline. Finite retention is explicit and legal hold independently blocks
purge.

Deletion is one authorized soft-delete decision with dependency preview,
restoration during a 72-hour window, scheduled purge, and a receipt. Purge
removes or redacts the authorized payload while preserving the minimum
non-content evidence needed to prove the lifecycle. Legal hold blocks purge and
does not substitute for permanent retention.

Temporary data has a separate lifecycle:

- a successful Agent stop buffer is removed immediately after idempotent
  transfer;
- an orphan stop buffer expires after seven days; and
- Session Corpus working data expires after 30 days unless an explicit durable
  conversation archive was created.

These temporary cleanup rules do not delete durable Raw Evidence, Pages,
Claims, Timeline Events, syntheses, Handbook content, decisions, or configured
conversation archives.

## 11. Maintained Source profiles

The GitHub repository Connector is the first V2 migration and preserves the V1
read-only, immutable-tree, bounded-fetch, retry, cursor, reconciliation,
receipt, and SecretRef behavior.

The maintained V1 registry identity creates a V2 implementation in explicit
compatibility mode and keeps its quarantine-only policy. The native `2.0.0`
identity requires exact implementation qualification and active Instance
state. Both identities use the same durable event and Raw Evidence pipeline.
Repeated inventories skip unchanged versions, complete inventories alone emit
provider-deletion events, and reappearance of the same provider version restores
inventory presence without rewriting immutable Raw Evidence.

The maintained Granola Connector is a hybrid `meeting` source. It verifies an
explicit provider-wide scope or exact configured folder scope and binds the
declared workspace identity to a separate attributable administrator
qualification; validates Standard Webhooks signatures; accepts supported note
generation, edit, and access events; fetches notes and complete paginated
transcripts; records participants and speaker locators; and reconciles with a
leased six-hour schedule, a 24-hour overlap, resumable cursors, and provider
page size no greater than 30. Webhook and reconciliation delivery of the same
revision produce one Source Object version.

The public provider API does not independently return a workspace identifier or
per-note principal ACL entries. The maintained Connector MUST NOT invent that
evidence: it accepts only a reviewed fixed CompanyOS root policy or quarantine,
and live activation additionally requires an administrator receipt for the
bound workspace. Loss of provider visibility stops fetch and later complete
reconciliation may mark absence without purging retained evidence. The
implementation follows the provider's published [API](https://docs.granola.ai/introduction),
[webhook](https://docs.granola.ai/webhooks), and
[transcript pagination](https://docs.granola.ai/api-reference/get-transcript)
contracts. A transcript above the inline boundary fails closed until the
Instance has a qualified durable Raw Asset adapter. The maintained Postgres
adapter stores such payloads in the existing Company Instance database with
digest, size, media-type, policy, and lifecycle verification. `retain` maps to
permanent retention; provider deletion records absence but does not purge Raw
Evidence or Raw Assets.

Local ingestion reads only the exact authorized files or bounded input. It does
not crawl a filesystem implicitly. Session capture uses the same event and Raw
Evidence boundary while preserving the temporary lifecycle in Section 10.

## 12. Model execution and Prompt Registry

Core owns one provider-recipe registry and provider-neutral task profiles for
`agent`, `utility`, `reasoning`, `deep`, `subagent`, `embedding`, and optional
`reranker` work. A recipe defines the route, transport, credential environment
reference and requirement, default and optional overridden base URL, model
namespace, capabilities, and advisory defaults needed to construct one
provider adapter. Native recipes use official adapters. Named compatible
recipes share one OpenAI-compatible transport while retaining distinct routes,
credentials, endpoints, and model namespaces. An Instance may bind an
exact task, a profile, or one default to a recipe and model. Exact task binding
wins over profile binding, which wins over the configured default.

Explicit Instance configuration wins over legacy environment selection and
key-aware defaults. Without explicit configuration, the resolver uses the
documented deterministic key priority and then the maintained Gateway default.
It never performs silent cross-provider failover during a request. Core logic
does not depend on Vercel or one model provider.

Provider recipes reference runtime environment variable names but contain no
credential values. Knowledge authorization and evidence validation occur
before model invocation as defined in Section 6; the recipe layer does not add
a second data-class policy engine, formal model-approval workflow, or hard
cost-budget service. Setup MAY execute an explicit bounded smoke test for the
selected recipe and model, but a smoke test is technical readiness evidence,
not company authority or an activation approval.

Every model-backed Knowledge task has one Prompt Registry entry containing:

- stable task and prompt version;
- input and output schema versions;
- system and task instruction digest;
- allowed model profile;
- bounded input and output behavior;
- optional timeout and retry settings;
- permitted read and write authority;
- failure and abstention behavior;
- regression fixtures; and
- replacement and compatibility metadata.

The current Prompt Registry `2.0.0` dispatches each generative task by the
exact prompt ID, prompt version, prompt content hash, input schema ID, and
output schema ID. A mismatch fails before provider execution. Structured task
input is validated against the task-specific input schema and is rendered
separately from numbered, untrusted evidence blocks. Claim extraction returns
separate Fact and Take collections. Explicit cited synthesis receives the
normalized user query and exact Context Receipt identity as structured task
input. Reranking is not a Prompt Registry task; it remains an optional,
dedicated capability adapter.

Each Knowledge execution receipt records the task, prompt, input and output
schemas, model route, exact model, token use, authorized structured-input and
evidence digest, time, and outcome. It is
ordinary non-secret execution evidence, not a separate immutable audit system
or model-activation prerequisite. It contains no protected prompt body, source
payload, or credential reference value.

Deterministic type rules, stable identity, exact references, exact duplicates,
ACL evaluation, lexical ranking, graph traversal, and schema validation run
before a model fallback. A model may classify, extract, propose links, judge a
bounded conflict, grade an outcome, or synthesize. It cannot grant access,
alter source evidence, approve its own proposal, publish Handbook authority, or
bypass an output validator.

Every current Prompt Registry entry has an offline synthetic fixture. Fixture
evaluation records deterministic precision, recall, and F1 over task-specific
semantic signals before a changed prompt or model is qualified for production.

## 13. Extraction and graph construction

An extraction run consumes exact authorized Raw Evidence versions and produces
validated Page, Claim, Timeline, participant, and edge proposals. The run is
idempotent by Source Object version, extraction contract, prompt version, model
route, and policy identity.

Evidence above 50,000 characters is split only at line boundaries. Model
locators are one-based inside the bounded chunk, validate against that chunk,
and are restored deterministically to source-global line positions before any
derived object becomes readable. A semantic locator or identity validation
failure receives at most one typed correction attempt. All outputs for the run
validate before the successful run receipt is recorded.

A model-derived Page version, Claim, Timeline Event, or working input is
readable or compoundable only when its model provenance references a successful
extraction run. Failed-run artifacts remain audit and recovery evidence; they
are never treated as active knowledge and their age does not trigger deletion.

The initial prompt set covers:

- processing triage;
- Page type classification;
- Claim, Holder, participant, and Timeline extraction;
- bounded semantic duplicate and Entity identity proposals;
- inferred-link proposals;
- conflict judgment;
- outcome grading; and
- working synthesis.

Exact Markdown references, provider object references, mentions, and other
deterministic links are written separately as sourced edges on every Page
version. A model-derived edge is `inferred`, carries prompt and run provenance,
and cannot replace a sourced edge. Unsupported or invalid model output is
retryable or rejected; it never becomes partially active.

## 14. Salience, deduplication, and consolidation

Processing triage and retrieval salience are separate:

- processing triage decides which bounded extraction work should run and may
  use a model under a Prompt Registry contract; and
- retrieval salience is deterministic from evidence density, recency,
  stability, authority layer, contradiction, notability, and query relevance.

Exact duplicate detection runs first. Semantic duplicate detection may produce
a candidate after a measured threshold. Material Claim merges, cross-source
Entity membership, and conflicts remain proposals unless a deterministic proof
path exists. New evidence may reopen a prior resolution or synthesis.

Compounding cycles declare `source`, `mixed`, or `global` scope. Global work
runs once per global watermark and MUST NOT multiply by Source count. Every
phase is leased, resumable, cursor-based, and receipt-producing. Retry reuses
the same idempotency identity.

The maintained productive cycle executes semantic duplicate classification,
Claim-relation proposals, conflict proposals, immutable working-synthesis
versions, and explicitly requested outcome grading. Authorization completes
before candidate Claims or evidence blocks are assembled. Candidate pairs are
bounded, deterministically ordered, policy-contained, and subject-contained.
The model cannot merge Claims, accept a relation, resolve a conflict, change a
canonical grade, widen access, delete evidence, or publish Handbook authority.
Duplicate, relation, conflict, and grade results enter reviewable proposal
state; a working synthesis creates a new cited version and preserves all prior
versions.

The portable phase budget defaults to one model-backed work item per phase and
persists a continuation after each invocation. Runtime adapters for
long-running hosts MAY select a larger explicit bounded budget. Working
synthesis lists only exact supplied Claim identities, uses mutually exclusive
supporting, contested, and superseded partitions, and receives at most one
typed correction attempt. An outer `claim:` evidence identity may normalize to
its suffix only when that suffix exactly matches an authorized Claim identity.

Outcome grading MUST begin with a durable explicit request naming the exact
Claim and outcome-evidence identities. Only independent evidence observed
after the Claim is eligible. Missing, same-source, pre-dating, or unauthorized
evidence defers the request without invoking the grading model.

## 15. Retrieval, Timeline, graph, and deltas

Authorized retrieval may search Raw Evidence, Pages, Claims, Takes, Timeline
Events, working syntheses, and the active Handbook. Every result labels its
object kind, authority layer, state, freshness, policy identity, source, exact
locator, and citation.

The baseline cascade is:

1. exact identity and direct references;
2. pre-authorized lexical candidates;
3. pre-authorized semantic candidates when the embedding policy permits;
4. deterministic reciprocal-rank fusion and per-parent pooling;
5. deterministic salience and state adjustment; and
6. optional measured reranking over the already authorized bounded set.

Embedding or reranker failure retains lexical retrieval and reports explicit
degradation. Query expansion and reranking remain disabled until regression
evidence demonstrates an improvement without authorization leakage.

Exact get, Timeline traversal, and graph traversal are bounded and deterministic.
Entity-derived views intersect every member policy. Delta reads use a stable
change-stream cursor and return only objects authorized at read time. A revoked
or narrowed object cannot reappear from an older cursor or cached context.

## 16. Knowledge Answer Contract

An Agent with Knowledge read grants uses the compiled `knowledge.answer@1`
contract. Ordinary interactive answers do not require a separate synthesis
model call. Core builds one internal, run-scoped, authorized context pack from
the exact retrieval result and provides it to the Agent model.

The model returns a structured Knowledge Answer Envelope containing:

- answer sections;
- claims supported by context item identities;
- citations;
- authority-layer and freshness labels;
- conflicts, gaps, and uncertainty;
- retrieval and model degradations; and
- abstention when evidence is insufficient.

Core validates every cited identity and generative claim against the exact
authorized context receipt before rendering. Unknown, unauthorized, stale
context identities, invented citations, unsupported claims, and invalid output
fail closed or render an explicit bounded gap. The run-scoped context receipt
records subject, policy-set digest, retrieval contract, query digest, context
identities and digests, snapshot identity, prompt and model route, and time. It
contains no protected excerpt.

Explicit `knowledge.synthesize` is reserved for deliberately granted,
non-interactive or background synthesis. A Working Synthesis is immutable by
version, cites exact supporting evidence, carries the intersected access
policy, and remains Brain material. It never becomes Handbook authority
without Section 17.

## 17. Handbook promotion

Promotion starts from one evidence-bound Claim or Working Synthesis and creates
a bounded candidate containing the target OKF identity, focused diff, evidence
set, conflicts, policy impact, and proposer. A human may accept, reject, or
request more evidence.

Acceptance creates a Decision Receipt but does not write directly to the active
Handbook. It authorizes the normal Company Workspace change path: proposed
files, review, protected merge, deterministic bundle build, verification, and
explicit activation. The Decision Receipt binds the decision, actor, time,
candidate digest, evidence digests, target paths, resulting Workspace commit,
bundle hash, and activation receipt.

Company policies, goals, people decisions, and other official truths belong in
the Handbook only when their normal governance allows the reviewing principal
to approve them. A Knowledge review role does not replace an approval role for
money, people, policy, or another protected domain.

## 18. Observability, recovery, and release gates

Operations record SLO evidence for event lag, queue age, retries, extraction
success, ACL quarantine, retrieval latency, citation validity, model cost,
prompt regressions, compounding lag, and promotion state. Metrics and logs are
payload-free. Cost evidence is grouped by task, prompt, model route, and Source
without exposing protected content.

Every supported Instance has documented and exercised backup, restore,
deployment rollback, schema rollback, Connector revocation, watermark recovery,
index rebuild, Handbook snapshot rollback, and incident procedures. Durable
Brain export is deterministic and records an integrity-protected ledger.

Production activation requires:

- a qualified schema and Raw Asset adapter;
- an isolated non-production qualification environment;
- exact Connector installation, binding, scopes, SecretRefs, qualification,
  and activation receipts;
- positive and negative ACL tests;
- backfill reconciliation and idempotency evidence;
- retrieval, citation, prompt, and model-routing regression ledgers;
- successful backup and restore evidence; and
- explicit operator approval for the final cutover.

No release may claim complete Company Knowledge v0.2 support until every
contract above has an active compatibility entry, conformance tests, operator
documentation, migration, rollback, and recorded qualification evidence.
