---
document_id: status.current
title: Current System Status
kind: status
status: approved
authority: canonical
language: en
updated: 2026-08-27
owners:
  - oregano-maintainers
audience:
  - human
  - agent
---

# Current System Status

This page distinguishes implemented Core mechanisms, executable reference
evidence, historical prototypes, and production gaps.

## Implemented and tested

- Company Knowledge Phase 3A publishes the provider-neutral Source Connector
  `2.0.0` contract for repository, meeting, messaging, email, document,
  local-file, and Session Sources over pull, webhook, and hybrid delivery. Its
  strict validators cover Source requirements, SecretRef-only Instance
  bindings, provider scopes, content-free at-least-once Source Events, bounded
  inline or digest-bound Raw Asset envelopes, ACL evidence, receipts, exact
  implementation qualification, and unsupported-shape failure. The explicit
  repository V1 compatibility adapter preserves stable Source and Connector
  identities without rewriting durable source state. This phase defines and
  validates the contract only; registry resolution and shared durable event
  processing remain Phase 3B and 3C work.
- Company Knowledge Phase 3B adds an exact-version maintained Source Connector
  registry. It validates source kind, delivery mode, input contract,
  implementation digest, binding state, and qualification before constructing
  a Connector, emits a non-secret resolution receipt, and fails before a
  provider call for missing, incompatible, inactive, revoked, or mismatched
  V2 state. Generic source CLI code now depends on the maintained registry
  boundary rather than importing the GitHub implementation. The existing
  repository V1 implementation remains available only through its explicit
  compatibility registration; arbitrary in-process Connector loading remains
  unsupported.

- Native Company Knowledge implements OKF v0.1 validation, deterministic
  schema-2 bundles and heading-aware fragments, link graphs/backlinks/orphan
  diagnostics, bounded traversal, control-Artifact manifests, and shared
  Neon/Postgres storage in the separate `companyos_knowledge` schema. Provider
  contract 3.0.0 supports stage/verify/activate, deterministic lexical/hybrid
  search with reciprocal-rank fusion and per-document pooling, exact get,
  complete citations, regression ledgers, explicit gaps/degradation, and
  stale/contested signals. The default embedding adapter is local/no-egress;
  optional `pgvector` failure retains lexical operation.
- The maintained Knowledge Provider now combines the active Handbook snapshot
  with a deterministic production projection of retained Source evidence,
  current Pages, Claims, Syntheses, Timeline Events, and graph edges. Only rows
  belonging to a registered non-revoked Source enter the projection, so orphan
  fixtures cannot become Agent results. Authorization runs before search,
  exact get, and directional graph traversal; every result retains a stable
  path, fragment, digest, policy, and evidence status. The maintained Vercel
  Runner registers this provider through `oregano/knowledge-postgres@3.0.0`.
- Company Knowledge Phase 5 includes the read-only
  `oregano/github-repository-source@1.0.0`, SecretRef-only binding, bounded and
  cursor-idempotent repository enumeration/fetch, immutable receipts/object
  versions, safe reconciliation, health/revoke operations, and Runtime
  Observation supersede/expiry/deletion/legal-hold evidence. Source and
  observation content enter the existing maximum-three human review path and
  cannot self-publish. Phase 2 authorization now protects their later display;
  unresolved Source ACL mappings still remain quarantined.
- The additive Company Brain foundation now defines the versioned 19-type Page
  registry, immutable Page-version schema, principal-scoped Facts,
  single-Holder Takes, exact Claim evidence, participant relations,
  receipt-bound Fact consolidation, and non-auto-applicable Claim resolution
  proposals. Model-derived Takes remain proposals. Their read-only Agent
  surface now uses the qualified Phase 2 authorization boundary; no Agent write
  Capability is granted.
- The complete inactive Phase 1 storage model now adds ACL policy and external
  principal foundations, durable raw assets, merge and calibration ledgers,
  timelines, sourced and inferred knowledge edges, immutable synthesis
  versions, promotion candidates, Decision Receipts, sessions and temporary
  Session Corpus rows, keyset cursors, extraction-run receipts, and
  deterministic Brain export ledgers. Existing Sources, Source Object versions,
  and Claim evidence upgrade to `policy:quarantine`; unresolved legacy Page and
  Claim policy identities are registered as quarantined policies. These 44
  required knowledge tables remain Phase 1 storage foundations; Agent-facing
  exposure is governed by the separate Phase 2 authorization contract.
- A provider-neutral `BrainStore` now has in-memory and Postgres
  implementations for Page-type registration, atomic immutable Page-version
  writes, current-version pointers, Holders, Facts, Takes, exact Claim evidence,
  and non-auto-applicable resolution proposals. Deterministic integrity checks
  reject identity reuse with changed content, exact retries are idempotent, and
  Postgres multi-row writes use serializable transactions in the existing
  database. On 2026-08-26 the additive migration completed twice against the
  linked production Neon Instance, with `pgvector`, all expected tables and
  integrity constraints, and exactly 19 active Core Page types verified from
  the live catalog. The opt-in Page, Fact, Take, evidence, Holder, and reviewed
  Entity-identity Postgres round trips also passed. Structured extraction now
  also persists participant relations and Timeline Events idempotently instead
  of retaining them only inside the extraction-run receipt.
- Cross-source Entity identity now remains explicitly separate from
  source-specific Page identity. The BrainStore and additive Postgres schema
  support stable Entities, deterministic or administrator-proven memberships,
  fuzzy/embedding/model proposals, and attributable accept or reject
  decisions. Fuzzy and model matches never auto-link; accepted decisions bind
  one candidate Page and receipt, rejected decisions create no membership, and
  every member retains its Page access-policy identity. Entity-derived
  retrieval remains disabled until its Phase-specific read Capability is
  implemented; the shared ACL intersection engine is now available.
- Company Brain Phase 2 authorization is implemented in Core. Knowledge Bundle
  `3`, Provider/Tool contract `3.0.0`, and the Runtime carry one canonical
  roster-resolved subject with Core-derived stable groups. The In-Memory and
  Postgres providers apply explicit-deny, parent intersection, and
  narrowing-only policies before lexical/vector ranking, exact hydration,
  graph traversal, citations, review content, or model output. Restricted OKF
  documents are supported; missing/inactive identities and unknown mappings
  fail closed; unresolved objects remain administrator-only quarantine.
  Access decisions contain policy/identity metadata and hashed object IDs but
  no query, excerpt, or protected payload. Adversarial tests cover deny
  precedence, graph non-disclosure, model-context denial, policy widening, and
  quarantine administration.
- Company Brain Phase 3C shared ingestion is implemented in Core with
  provider-neutral in-memory and Postgres stores. Every Source delivery can be
  persisted and deduplicated before fetch, ACL evidence is normalized before
  model readiness, invalid or suspicious content is quarantined, provider
  deletion records absence without purging retained evidence, and explicit
  lifecycle requests provide dependency preview, a 72-hour restoration window,
  legal-hold blocking, and payload-free purge receipts. Change entries form an
  integrity-linked payload-free chain, and completed watermarks advance only
  after successful complete batches. The linked production Instance received
  and qualified the additive `1.4.0` schema on 2026-08-26.
- Company Brain Phase 3D repository ingestion is implemented in Core. The
  maintained GitHub V1 registry identity now creates a V2 Connector in explicit
  compatibility mode, while native `2.0.0` bindings require exact qualification
  and active state. Both use read-only immutable-tree enumeration, bounded blob
  fetch, durable Source Events, ACL and sanity gates, complete-inventory-only
  reconciliation, and completed watermarks. Contract tests cover retry,
  truncation, cursor tampering, tree drift, duplicate suppression, retained
  provider-deleted payloads, and same-version reappearance. A real repository
  binding and sync remain intentionally pending until an approved SecretRef and
  target repository are selected.
- Company Knowledge Phase 3E Granola ingestion is implemented in Core and live
  for the `oregano-hq-companyos` production Instance. The administrator-created
  Workspace API Key is held only in the runtime secret store; the binding is
  qualified with the exact `workspace` scope. The active provider-wide requirement imports every
  note visible to that key under the fixed company policy with `retain`
  lifecycle. The initial reconciliation on 2026-08-26 processed 21 of 21 notes,
  zero failed or quarantined, stored 1,134,874 bytes of complete note and
  transcript Raw Evidence, and advanced one completed durable watermark. All
  21 payloads fit below the inline boundary; the durable Postgres Raw Asset
  path remains active for larger future transcripts. A six-hour leased overlap
  reconciliation and extraction schedule, a nightly resumable model-maintenance
  schedule, and a signed webhook route are deployed. Webhook
  delivery remains pending until its separate provider signing SecretRef is
  installed; scheduled reconciliation is already operational.
- Company Knowledge Phase 3F implements exact local-file ingestion and the
  temporary Session Corpus lifecycle. Local ingestion reads one explicitly
  named regular UTF-8 file, never a directory or crawl root, and uses the same
  durable V2 event, ACL, sanity, receipt, Raw Evidence, and change-stream path.
  Stop-buffer transfer is idempotent and removes the buffer only after the
  Corpus write succeeds; orphan buffers are eligible after seven days and
  Corpus payloads after 30 days. A separate explicit `retain` archive produces
  durable Raw Evidence that temporary cleanup cannot remove.
- Company Knowledge Phase 4 implements CompanyOS-wide provider recipes,
  deterministic task and profile bindings, bounded Knowledge execution
  receipts, and a content-addressed Core Prompt Registry. Vercel AI Gateway,
  native Anthropic, OpenAI, and Google routes; named compatible cloud routes;
  explicit LiteLLM, Ollama, and llama-server routes; and a generic
  OpenAI-compatible escape hatch share one resolver. Named recipes retain
  provider-specific credentials, default endpoints, model namespaces, and
  capability declarations without creating separate transports. Productive
  Knowledge maintenance adds rated execution receipts and hard per-cycle and
  UTC-day spend limits for exactly priced model recipes; broader provider
  qualification and provider data-class matrices remain Instance concerns.
  Prompt Registry `2.0.0` now dispatches all 13 generative Knowledge tasks by
  exact prompt version, content hash, input schema, and output schema. Each
  task has its own user instruction and strict structured result; mismatches
  fail before provider execution. Extraction returns separate Fact and Take
  collections and validates Page types, identities, Holders, and source
  locators against the exact authorized input. Cited synthesis receives the
  normalized query and Context Receipt identity, and one offline fixture per
  task exposes precision, recall, and F1 quality gates for all 13 prompt paths.
  Deterministic classifications and provider identity links do not call a
  model; model-derived gradeable Takes and fuzzy identity links remain
  proposals. Reranking remains a separate optional capability and is not a
  generative prompt task.
- Company Knowledge Phase 5 separates processing triage, retrieval salience,
  retention, deletion, access, and authority. Authorization precedes exact,
  lexical, semantic, graph, context, delta, and citation processing. Hybrid
  results use RRF, per-Page collapse, graph augmentation, diversity, and
  explainable signals. Timeline and explanation use their own authorization
  capabilities. Optional deep query expansion and reranking are bounded and
  their execution receipts are bound into the Context Receipt. Context packs
  and at-least-once deltas are deterministic; answers accept only citations in
  the exact context receipt, and empty
  context cannot produce a substantive answer. Explicit synthesis requires a
  non-default grant. Scoped compounding distinguishes Source, mixed, and
  global idempotency and lock domains.
- Productive Company Knowledge compounding is implemented behind a protected
  Runner operation. The maintained adapter now separates six-hour source delta
  work from the nightly model-maintenance lane. The Core performs bounded,
  authorization-prepared duplicate classification, Claim-relation proposals,
  conflict proposals, immutable working-synthesis refresh, and explicit
  outcome-grading requests. Exact normalized duplicates are deterministic;
  expensive relation and synthesis work receives cheap cached triage first.
  Additive Postgres state persists leases, resumable receipts, Claim-pair
  proposals, grading requests, policy-bound model results, spend reservations,
  and rated execution ledger rows. Model output
  cannot mutate canonical Claims, accept its own proposal, or create Handbook
  authority. The live fixture-qualification operation evaluates all 13 current
  Prompt Registry tasks with precision, recall, F1, exact model route, and
  receipt identity before an operator enables the schedule. The portable
  default processes one model-backed work item per phase and persists a
  continuation after every successful invocation; long-running hosts may opt
  into a larger explicit budget. Cycle identity binds the exact Compounding
  contract, prompt/model configuration, and current authorized Knowledge
  frontier, so incomplete work resumes across time windows and changed inputs
  never reuse stale complete receipts. Unchanged prompt, schema, rule, model,
  input, evidence, authorization, data-class, and policy identities reuse the
  original validated result across cycles before any new spend reservation.
  Uncached work is bounded by configurable cycle and UTC-day budgets. Receipts include content-free phase
  totals. Working-synthesis Claim partitions are
  mutually exclusive, exact-subject-bounded, and receive at most one typed
  correction attempt. Subjects above 40 Claims use deterministic Claim-ID
  segments; every segment is independently cached and receipt-bound, and the
  last segment merges all cached components without a second synthesis model.
- The linked production Instance completed the real Granola extraction and
  compounding gates on 2026-08-27. All 21 current Source Objects have successful
  extraction receipts under pipeline `2.0.0` and Claim-extraction prompt `6`.
  Prompt qualification `eac0b9add2ae9a1f02daea0059347a66db0cef92a154aaa57cfc37bbc64fea5c`
  passed all 13 then-current fixtures, including historical Working Synthesis
  prompt `4`. Current prompt `5` subsequently completed two real bounded
  Sonnet segments with exact component receipts. Cycle
  `2026-08-27T06:00:00.000Z` completed all five productive phases, and an
  immediate retry returned the same five complete receipt identities. Failed
  historical extraction attempts and older successful derived versions remain
  retained as audit evidence. Retrieval, exact Claim reads, Timeline,
  Compounding, grading, and working syntheses expose model-derived state only
  when its successful extraction provenance is attached to the current Page
  version. The production frontier currently contains 1,079 current Claims;
  53 Claims and 10 Page versions from failed attempts remain retained but
  excluded. Candidate loading fails explicitly above its bounded 2,000-Claim
  frontier instead of declaring a truncated phase complete.
  Historical Productive Compounding contract `2.1.0` produced a content-free
  total of 353 current candidate pairs per pair phase. Contract `2.2.0` replaces
  that shared gate with exact/`0.45` duplicate, `0.20` relation, and same-kind
  `0.15` conflict gates plus durable result reuse. The maintained schedule is
  inside a bounded 02:00–05:59 UTC nightly continuation window rather than
  every 15 minutes around the clock. Deployment
  `dpl_EdrL7WjYjF3C2MgNJ6KnBKACdq3k` proved segment prompt `5`, and the final
  production cron exposes `*/15 2-5 * * *`. Controlled alignment and backfill
  runs have 89 successful rated executions totaling USD `0.51841000`, zero
  active reservations, and five failed full-Subject trials retained without a
  result or execution-ledger row. Their USD `1.07439900` failed-reservation sum
  is a conservative budget charge and upper bound, not a claim about final
  provider billing. Abandoned reservations close after ten minutes and remain
  as content-free audit evidence. The initial frontier backfill remains
  resumable operating backlog until
  every phase receipt is complete; retrieval exposes only the already-current,
  successfully proven subset while that background work advances.
- Phase 5 production integration now adapts that authorization-first retrieval
  into the existing standard `knowledge.search`, `knowledge.get`, and
  `knowledge.traverse` Tool contracts. Local conformance tests prove that a
  private record is absent from search, exact get, and graph traversal for an
  unpermitted principal while remaining available to an explicitly permitted
  principal. The production Artifact activates all three read Tools for the
  selected Oregano Agent. Its first cited Slack probe exposed that automatic
  model Tool choice could still decline an explicit Company Knowledge request
  and incorrectly state that no search Tool was available. The maintained
  Slack adapter now requires the already-granted search Tool on the first model
  step for explicit searches and high-confidence company-evidence questions,
  returns later steps to automatic selection, and distinguishes a Tool call
  from a successful validated Tool result. A second live probe proved that a
  call-only gate was insufficient: the model could still render a false Tool-
  unavailable answer after the call. The corrected response gate withholds
  substantive output after execution failure, rejects malformed search output,
  and replaces an ignored successful result with authorized cited excerpts.
  Content-free invocation metrics then proved that the repeated Slack turn was
  still reaching the obsolete `oregano-hq-builder-qualification` project rather
  than CompanyOS: the team contained two Slack connectors, and the installed
  `slack/oregano` connector remained attached to the obsolete project. The
  Maintainer-approved cutover now attaches `slack/oregano` only to
  `oregano-hq-companyos`, removes the obsolete trigger destination, leaves the
  unused replacement connector unattached, and aligns the production
  `SLACK_CONNECTOR` reference. The first CompanyOS-routed turn then failed
  closed because the Workspace still named a principal from the obsolete Slack
  tenant. The Workspace Steward explicitly approved replacement with the
  principal read from the installed Oregano Workspace; Workspace commit
  `5e6ccaea98307a8f9884ccd7af1fcdd6b8ca813b` preserves the same role and rights
  while correcting the team-bound Slack identity. Production deployment
  `dpl_5Xu3fmDJuLRpvZ6ChcwHR9RXJhLR` is ready at the canonical alias with
  Artifact `f1c4276d51c622267fa560a1c0ed92470911366857ff64a8c8e2f2c77cd4c68c`
  and the same three R0 Knowledge grants. The repeated cited Slack probe then
  passed roster admission and selected the registered search Tool, but ended
  without a Tool result at the repeatable 15-second boundary. Core now removes
  one known latency amplifier by evaluating every candidate authorization
  decision before ranking as before while persisting every immutable object-
  scoped audit decision through bounded Postgres batches instead of one Neon
  HTTP round trip per candidate. The change neither caches nor skips decisions
  and retains fail-closed audit failure. A payload-free Tool failure code now
  distinguishes timeout, input, database, Connector, isolation, and unknown
  execution classes without exposing a query, excerpt, credential, or provider
  error text. Its live probe identified the immediate cause as the isolated
  Company Tool worker's five-second default, which terminated a still-running
  authorized retrieval call. The maintained Runner now selects an explicit
  bounded 30-second Tool execution window; the generic Runtime validates but
  does not otherwise prescribe a host's optional override. Production
  deployment `dpl_DNFCv9ToKhWsBLhN181jkJf9rTVu` is ready at the canonical
  alias. The repeated Slack probe on 2026-08-27 then completed the registered
  search and returned three authorized Company Brain results from Claims and
  Working Syntheses, each with its exact Company Knowledge path and fragment
  identity. This qualifies roster admission, required Tool routing, isolated
  execution, Postgres retrieval and ACL audit, result validation, citation
  enforcement, and Slack delivery together for the current production
  Artifact.
- Company Knowledge Phase 6 implements focused, content-addressed Handbook
  promotion and Decision Receipts. Claim evidence, source and effect digests,
  conflicts, consequences, affected files, authority scope, and human
  authorization evidence bind each decision. Materialization rejects base
  drift, receipt replay, and incomplete cross-document effects. Extraction and
  synthesis still cannot publish official authority.
- Company Knowledge Phase 7 implements provider-neutral database `prepare`
  detection for `bootstrap`, `upgrade`, or `verify`, plus deterministic export
  and cutover receipts. A complete cutover requires schema, ACL, retrieval,
  Source, model, Handbook, backup, rollback, and durable-identity evidence; a
  schema-only migration is not labeled a live Brain cutover.
- Company Knowledge Phase 8 implements payload-free operation and quality
  metrics, measured SLO evaluation, deterministic alert candidates, regression
  ledgers, Connector and ACL-drift diagnostics, deterministic recovery
  qualification, and contract support windows. Production SLO compliance,
  alert delivery, and backup/restore
  evidence remain Instance-specific and cannot be inferred from repository
  tests.
- Database setup state version 4 now separates StateStore resource provisioning
  from schema preparation. New runs use the `database-prepare` phase; legacy
  pending `database-bootstrap` phases resume compatibly through the same
  idempotent preparation entrypoint. The deterministic
  `companyos-postgres@1.6.0` additive manifest preserves the immutable `1.5.0`,
  `1.4.0`, `1.3.0`, `1.2.0`, `1.1.0`, and `1.0.0` identities and
  prepares both `companyos` and `companyos_knowledge`, records an immutable
  non-secret ledger entry, verifies required tables, indexes, integrity
  constraints, the 19 Core Page types, and optional vector availability, and
  returns a bounded qualification receipt. The maintained Vercel profile wraps
  this operation with `vercel env run`; the typed runtime-host contract also has
  a non-Vercel conformance fixture. Production health now verifies the schema
  read-only. A clean local PostgreSQL 14 database produced 12 control tables,
  Phase 1 produced 44 required knowledge tables and 19 Core Page types on two
  identical local runs. Phase 2 adds three authorization relations for 47
  required Knowledge tables. Phase 3 adds the shared ingestion/lifecycle
  relations and Session lifecycle receipts for 54 required Knowledge tables.
  Phase 4 adds one durable Source reconciliation lease relation for 55 required
  Knowledge tables. Phase 5 adds four compounding lease, receipt, pair-proposal,
  and grading-request relations for 59 required Knowledge tables. Phase 6 adds
  three model-result cache, spend-reservation, and execution-ledger relations
  for 62 required Knowledge tables. On 2026-08-27 the linked production Instance
  upgraded additively to 1.6.0 and passed a separate read-only qualification
  with digest
  `b9ba518e64d39e754e917348dd67b2bad7aa200d533af8343fba0c6f3774c4b1`,
  12 Control tables, 62 required Knowledge tables plus `pgvector` for an
  observed total of 63, and 19 Core Page types. Earlier on 2026-08-27
  the linked production Instance upgraded additively to 1.5.0 and passed a
  separate read-only qualification with digest
  `bb3dcef272ce2c33ae1a479171a648ea6e79ab01b04ca37dce998a5e0e404cea`,
  12 Control tables, 59 required Knowledge tables plus `pgvector` for an
  observed total of 60, and 19 Core Page types. On 2026-08-26 the same Instance upgraded to
  `companyos-postgres@1.4.0` and passed a separate read-only qualification with
  digest `6c0b3366540c8b1c0a3d889ef8c180c32d15d4e1bb92dbbbd8b10e94ddbce16c`,
  12 Control tables, 55 required Knowledge tables plus `pgvector` for an
  observed total of 56, and 19 Core Page types. The immutable manifest ledger
  retains every predecessor through `1.3.0`. No credential value entered setup
  state, logs, receipts, or repository files.

- Real company operating truth lives in a separate Company Workspace. Oregano
  Core contains only generic mechanisms and fictional fixtures.
- Oregano Core has prepared the `0.4.0` initial-development release candidate;
  `v0.3.2` remains the latest stable release until the reviewed candidate is
  merged, tagged, and published. Every Company Workspace advances independently
  under the canonical Versioning Policy.
- `companyos build` combines clean exact Core and Workspace commits with a
  non-secret Instance declaration into one immutable content-addressed
  artifact. The artifact records both product versions, the SHA pair,
  Workspace hash, Capability
  catalog hash, resolved ToolSet hash, roster, scoped agent material, exact
  bindings, and Workbench version.
- A seed provider-neutral Capability catalog, deterministic fail-closed
  ToolSet Resolver, exact Instance binding checks, and runtime Tool-grant
  enforcement are implemented for local Company Tools.
- Company Tool contracts use real JSON Schema enforcement. Their TypeScript
  implementation is statically inspected, compiled, and executed in a
  permission-limited child process that exposes only explicitly granted
  Capability calls. Provider imports, environment access, direct networking,
  dynamic imports, and common sandbox escapes are rejected.
- Workspace and Blueprint inspection include credential-indicator scanning.
  Instance build declarations reject resolved credentials and contain only
  non-secret binding metadata.
- StateStore interfaces and the Neon/Postgres implementation cover append-only
  events, approval requests, authorization, atomic approval consumption,
  idempotent effect claims, dispatch, success, failure, and unknown outcome.
- Canonical principals are surface-neutral. Slack principals remain supported;
  explicit non-Slack principals and agent identities are compiled into the
  artifact. Agent identities cannot approve even if rights are misconfigured.
- The fictional `solstice-homes` reference Workspace and sandbox Instance run
  a property campaign end to end through the same Builder, Tool SDK, Resolver,
  Capability, Connector, approval, effect, and evidence path. Tests cover
  deterministic builds, stale input, self-approval, ungranted Tools, schema
  violations, Connector failure, and unchanged spend ceilings.
- The experimental Workbench implements Guides, Change Plans, Core and
  Workspace inspection, Workspace validation, documentation checks, local
  security checks, onboarding, Package inspection, and Instance artifact
  builds. Its repository release candidate is `0.1.0-experimental.8`; no
  public package release is claimed.
- Codex and Claude Code now share one plugin-free
  `INSTALL-COMPANYOS.md` Release runbook with `BOOTSTRAP_FOR_AGENTS.md` as a
  compatibility entrypoint. `companyos create workspace` supports interactive
  intake and a bounded agent answers-file transport, complete preview,
  confirmed atomic materialization, and a deterministic
  `authoring-only-local` bootstrap checkpoint.
- The experimental `companyos setup --profile vercel-neon-slack` state machine
  continues from that checkpoint through explicit create-or-adopt GitHub,
  Vercel, Neon Marketplace, and Slack Vercel Connect phases. It includes a
  private GitHub repository, automatic best-effort hosted protection with no
  paid-plan requirement, a separately confirmed operating-starter diff,
  required-check and Steward merge evidence, immutable Artifact injection, current
  health verification, and nonce-bound Slack plus Neon persistence proof.
  `companyos verify-live` reports only `live-starter-instance` with readiness
  `validated`.
- Setup and the maintained Runner select Gateway, native Anthropic/OpenAI/Google,
  or a named compatible cloud recipe through the same resolver. Generic
  OpenAI-compatible and local/proxy recipes remain available to explicitly
  configured Instances. Credential-required routes fail closed when their
  named Sensitive Production runtime variable is absent. Health, production
  confirmation, and the persisted model-backed Slack response bind the exact
  route and model without storing a secret value.
- The maintained setup implementation now has a private typed four-role
  provider boundary. Its GitHub, Vercel, Neon, and Slack profile records
  write-ahead intents and immutable receipts, verifies the monorepo runner
  root, refuses production-variable conflicts, and separates the fixed Slack
  Agent name `oregano` from Company Workspace identity and provider-internal
  resource names. This is an internal Workbench boundary, not a public provider
  plugin API. Transitive development dependencies used by the pinned Vercel
  CLI are constrained through Vercel-parent-scoped security releases. This
  includes a narrow, audited compatibility override for Vercel's legacy
  HTTP-client dependency without changing another provider or the production
  Runner's direct dependency contract.
- The generated starter contains one supervised `oregano` Agent, one Slack
  workflow, a non-secret Slack connection declaration, and no business Tool
  grants. Its mode-0600 setup state rejects provider credentials, database
  URLs, private keys, Artifact content, and short-lived Slack tokens.
- Contract Foundation Lite recognizes Blueprint, Tool, and Connector Packages
  and implements the manifest schema, Compatibility Registry, local read-only
  Blueprint inspection, declarative file allowlist, credential scanning,
  path hardening, and type-specific Component entrypoint checks.
- The maintained non-Eve Vercel Runner loads one integrity-checked production
  Artifact, admits only active compiled roster humans before model invocation,
  exposes only the resolved ToolSet, and reauthorizes R3/R4 approval clicks in
  Core. Vercel Connect and Chat SDK provide Slack transport; AI SDK and AI
  Gateway provide model turns; official Anthropic, OpenAI, and Google adapters
  plus the shared named and generic OpenAI-compatible adapter supply direct
  model turns when selected; Postgres provides durable chat,
  approval, and effect state.
- A private pilot has exercised the maintained Vercel Runner, Slack transport,
  immutable Artifact loading, and Postgres-backed state. Customer identifiers,
  deployment URLs, immutable revisions, and operating evidence remain in the
  responsible private Company Workspace and development records.
- `artifact.publish` has a real Postgres-backed Instance Connector and serves
  approved artifacts through a restrictive public Vercel route. This proves
  one real Connector path; it does not prove Meta, Monday, or another provider
  effect.

## Reference-only or historical

- The legacy Eve/Slack demo was an accepted walking skeleton, not a generic
  CompanyOS runtime. Its Core-resident adapter and company-specific demo Tools
  have been retired from the active repository.
- The maintained property-campaign proof uses in-process sandbox Connectors
  and fictional state. Sandbox campaign IDs, URLs, spend, conversions, and
  reports prove the control path only; they are not external provider effects.
- The repository-local Blueprint for a property campaign is inspectable and
  authority-free. Applying, locking, updating, or removing a Blueprint Package
  is not implemented; materialization remains an ordinary reviewed Workspace
  diff.

## Approved targets not yet implemented

- Meta, Monday, and other business-provider Connectors are not implemented or
  activated. Each still needs privileged isolation, provenance, SecretRefs,
  health, retry, reconciliation, read-after-write, and conformance evidence.
- Pilot evidence does not establish general production enforcement. Instance
  readiness remains `validated`, not `enforced`, until backup restoration,
  rollback, recovery, alerting, and operator runbooks are exercised and
  recorded for each exact Instance.
- Published Tool Package acquisition and activation remain unsupported even
  though the local Tool SDK, isolation, Resolver, and runtime grant boundary
  now exist.
- Blueprint plan/apply/lock/update/remove, remote Package sources, the open
  Registry, signing, publisher identity, advisories, revocation, and
  Marketplace UX remain future stages.

## Highest-priority gaps after the first live pilot

1. Exercise and record database restore, deployment rollback, recovery,
   alerting, and operator runbooks for the exact live Instance.
2. Qualify and activate exact production model task profiles, repository and
   meeting Source bindings, then run real synchronizations and ACL regressions.
   Connector implementations exist, but schema readiness supplies no Source
   SecretRef or provider-scope authority.
3. Establish an isolated non-production Instance and Connector authorization
   instead of testing future changes against production state.
4. Reconcile, validate, tag, and publish the stable immutable `v0.4.0` GitHub
   Release containing the Company Knowledge capability. There is no
   `latest-stable` branch; `releases/latest` is discovery only and installation
   pins the exact tag, commit, and Workbench version. The existing `v0.3.2`
   release remains immutable and available.
5. Re-qualify the hardened `vercel-neon-slack` setup profile through a fresh
   external end-to-end installation before the next stable release. The prior
   profile completed a real supervised installation and exposed the provider
   receipt, runner-root, Slack-authorization, naming, and health-readiness gaps
   addressed by the current Change Plan; the hardened revision still requires
   its own release qualification.
6. Publish a signed Workbench package so Workspace-only Contributors do not
   require a Core source checkout.
7. Require and qualify hosted repository protection before any future
   unattended agent receives repository write, merge, or deployment authority;
   the maintained supervised starter deliberately grants none of those
   capabilities.

Historical detail remains in archived sources as migration evidence; it does
not override this page or the canonical architecture and specifications.
