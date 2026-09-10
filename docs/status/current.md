---
document_id: status.current
title: Current System Status
kind: status
status: approved
authority: canonical
language: en
updated: 2026-09-10
owners:
  - oregano-maintainers
audience:
  - human
  - agent
---

# Current System Status

Builder Workspace releases preserve deployment-local runtime settings and reject
promotion if the staged Instance loses its Builder configuration. Builder status
messages retain earlier conversation content instead of replacing result text.


Core 0.10.0 and Workbench 0.1.0-experimental.20 require CLI and hosted Builder builds to read the tracked `.companyos/instance.yaml`
from the exact checked Workspace commit. External YAML overrides and the hosted
YAML environment copy are removed; hosted compilation retains the running
Artifact configuration-digest authority check. Setup writes the declaration
before its initial commit. Only current schema-5 fresh setup sessions resume;
the old explicit installer and schemas 1–4 are retired. This is implemented
source behavior, not evidence of a live deployment. See
[the reference](../reference/instance-configuration.md).

This page distinguishes implemented Core mechanisms, executable reference
evidence, historical prototypes, and production gaps.

## Implemented and tested

- Core 0.11.1 corrects Builder intake after clarification. Typed model output
  replaces free-text JSON parsing. Invalid output and execution failures are
  retried once and then reported as unavailable, never as a normal question.
  Current-message and literal-quote checks still gate development. Retained
  intake receipts distinguish questions from failures without storing message
  text. A protected hosted qualification exercises the configured model on
  synthetic clarification, explicit-start and negative cases without creating
  jobs. Source checks do not prove a company deployment or human acceptance;
  adoption must pass this hosted gate. No provider permission or DDL changes.

- Core 0.11.0 and Workbench 0.1.0-experimental.21 replace the 0.9.0 Finish/Restart workflow with one
  four-action result card: **Go Live**, **Discard Build**, **Open Test Channel** and
  **Request Changes**. Current-message intent separates questions from coding.
  Users can start new builds while earlier drafts remain open and create fresh
  test-channel threads directly, with selection per Instance/user and pinned
  existing conversations. Seven-day configurable inactivity pauses tests without
  deleting history. Trusted discard closes an exact unmerged proposal; uncertain
  closure blocks publication and remains retryable. Shared Core routing and
  presentation accept a synthetic non-Slack test surface; maintained deployed
  adapters remain Slack/Vercel and the same Claude Code/Codex ACP profiles.
  The hosted integration is the maintained Slack webhook/action route, Builder
  worker and functional-test controller. PR 112 passed CI, including 72 mandatory
  Postgres proofs; the updated source has synthetic multi-user and alternative
  communication-adapter coverage. Exact hosted model/provider qualification
  remains an Instance adoption gate; this release does not claim a new customer
  deployment or human acceptance. No DDL or provider permission change is needed.
  Preserve test histories and decision evidence and stop tests/publication before
  rolling back to 0.10.0. The historical 0.9.0 limits below describe that release.

- Core 0.9.0 and Workbench 0.1.0-experimental.19 release the reviewed Builder
  experience from PR 108: a retained request card, confirmed
  coding-start progress and one result card with **Request changes** and **Go live**.
  The Agent recommends and explains a supported test without a mandatory menu.
  Interactive Agent tests without Tools reuse the existing app and exact candidate,
  with separate multi-turn history, requester-only finish/restart controls, twenty
  replies maximum and 24-hour open-session expiry. Restarting preserves the code
  candidate while invalidating earlier acceptance evidence. The updated code has
  synthetic lifecycle coverage; adoption and real provider/human proofs of this
  revision remain separate. Simulation, full workflow dialogs, general Preview
  provisioning and bounded live trials remain deferred.
  Hosted entrypoints are the maintained Slack webhook/action route and Builder
  worker, wired to the same functional-test controller and release coordinator.
  PR 108 passed 1,079 general tests and 70 mandatory Postgres proofs without
  database skips; synthetic Chat tests exercise request, follow-up, finish,
  restart, feedback and stale acceptance. Real hosted proofs of this new revision
  remain an Instance adoption gate and are not claimed by this release note.
  Upgrade from 0.8.1 requires matching Core/Workbench pins and a newly qualified
  image/deployment, with no DDL, provider grants or business-file migration.
  Before rollback, stop or resolve interactive sessions and preserve their
  evidence; legacy automatic tests remain readable.

- Core 0.8.0 adds a bounded connected Builder functional-test profile. It compiles
  the exact unmerged proposal, executes a read-only Agent reply or an immediate
  operator workflow, and retains exact resource scope, execution and delivery
  evidence before presenting merge/live acceptance. Feedback invalidates the old
  result; acceptance and feedback use a durable atomic revision. The same test
  digest is checked again before merge. Test workflow state, dispatch fences and
  timers have separate storage namespaces while retaining exact Artifact identity.
  The employee uses the existing provider app and designated test resources.
  Timed workflows, intermediate decisions, conversational Tools, general resource
  remapping, live trials and migrations remain outside this initial test profile.
  Synthetic compiler/engine/Chat tests and actual Postgres isolation tests do not
  establish a customer's two requested human-feedback-to-live proofs.

- Standard setup now requires an explicit choice of OpenAI or Anthropic and
  binds its direct recipe, maintained model and Sensitive Production key
  destination to the single resource/cost review. Other models/providers require
  a request. Gateway is not selected automatically; existing installed sessions
  retain their original binding. The provider-compatibility repairs are included.
  The new choice is covered by synthetic lifecycles; fresh live qualification of
  this revision is still outstanding.

- The setup adapter corrects the `identity.basic` endpoint and personal CLI
  token-subject mismatch. It validates connector metadata for the Slack Messages
  link and isolates provider-generated OIDC/skill files from immutable source.
  Synthetic regressions cover mismatched identities, secret reduction, cleanup
  on failure and resumed setup without duplicate deployment. These checks do
  not establish fresh external candidate qualification. A further regression
  checks production aliases and exact deployment IDs while refusing login
  redirects; deployment protection remains enabled. Slack creation now enables
  incoming triggers explicitly; both the first-message gate and final verification
  check forwarding plus the exact production attachment and webhook destination.
  Regressions reject disabled forwarding and wrong project, route or environment.
  Missing replies on retry now expose exact Slack URL-verification and Connect
  delivery recovery; explicit subscriptions without `message.im` are refused.
  Provider synchronization and URL challenges do not qualify a model reply.

- The repository qualification correction fixes the repository-scoped release client to allow GitHub's
  exact `base...head` comparison while rejecting literal or encoded path
  traversal. The hosted trusted Git fixture uses the current Change Plan and
  Workspace document contracts, explicitly governed paths and an executable scope test.
  It is tested through actual Workspace validation and final release classification.

- Core 0.7.0 adds explicit human-confirmed Builder merges for unprotected
  repositories. A non-forcing fast-forward adopts only the exact single-parent
  checked candidate; concurrent divergent changes stop rather than entering an
  unchecked merge. Existing protected merges remain supported. Strategy and
  checks are bound to confirmation, and showing the result grants no authority.
  Lost responses reconcile from immutable branch/commit evidence. The coding
  process still has no repository or release credential; production adoption
  uses the same trusted compiler, staged health and explicit promotion path.
  This capability does not prevent manual changes to an unprotected Git branch.

- The Core 0.6.0 Builder release adds scoped definition discovery and
  reads, a versioned before/after brief, unresolved-decision admission checks,
  original-message continuation through an allowlisted Builder handoff, and
  automatic isolated job submission after clarification. Workspace Builder
  presence now declares intent; Instance execution bindings remain separate
  and `enabled: true` is no longer required. The generator supplies process
  context for new Workspaces; existing read scope is not broadened.
- Builder diff inspection now includes uncommitted and mixed changes, including
  staged, new, renamed and deleted paths. Valid v3 evidence plans no longer
  cause automatic security classification solely through `.companyos/**`;
  actual governance and explicit protected-path rules remain protected.
- The Builder release path now has maintained GitHub/Vercel adapters and default
  Runner wiring behind explicit company policy and Instance bindings. It checks
  exact candidate/base/tree, producer-pinned protected CI, current human authority,
  offline Artifact compilation, staged production health, domain promotion and
  exact live health. Exact Knowledge snapshots and retained Records/Workflow
  bindings follow the new pairing; changed provider or knowledge access policy
  needs renewed Instance qualification. Lost provider create responses retain an intent rather than
  repeating deployment. Postgres restart, lease expiry and concurrent revision
  races pass in an isolated database. A shared image recipe packages pinned coding
  profiles, CLI and Guides for separate coding and trusted executions. Actual
  company provider access and request-to-live qualification are still required;
  this source status does not claim a customer deployment. General simulations,
  live-trial execution, optional Preview orchestration, arbitrary migrations and
  split-actor acceptance/deployment remain outside the initial automatic profile.
- The Core 0.6.1 hosting correction separates remote proposal validation from
  local Workbench metadata imports. Scheduled production workers verify that
  the production domain serves their exact deployment before executing; staged
  and superseded deployments cannot advance jobs or scheduled business effects.
  A cold-start regression imports every maintained scheduled route without local
  checkout metadata and verifies refusal before effects. Shared-image model
  qualification accepts the same snapshot setting as normal Builder execution.
- Authenticated Records operators receive bounded, credential-redacted error
  diagnostics alongside the existing error code and digest. Public responses
  and runtime logs retain their existing content-free behavior. Diagnostic text
  is provider evidence, never an instruction or permission to retry effects.
- Core 0.6.2 retains complete deployment Artifacts in the existing Instance
  Artifact store. Production builds carry an exact hash instead of a large
  environment payload. Awaited startup verifies the retained content before
  requests, with no schema preparation, floating latest version, or fallback.
  Legacy inline configuration remains supported. This removes the hosting
  environment size limit from company context without introducing another app.
- Manual hosted openings accept an optional bounded `triggerVariant` index.
  It selects only parameters from an existing matching trigger in the retained
  Workspace calendar. Tests exercise both branches through the request parser
  and actual engine, changed-input retries, unauthorized callers, invalid
  selectors, preserved real opening times and delayed business-day delivery.
  No arbitrary parameters, clock override or business-specific host is exposed;
  actual provider and human acceptance remain separate.

- Ordinary publication fixtures verify the exact Agent, Tool, Instance, run,
  step and effect identity at the provider boundary. A pending handoff retains
  its original templates, destination, schedule and journal provenance after a
  separately compiled Workspace revision; a newly opened run uses the revision.
  Close publications preserve their received root thread and distinct effect
  identities across retries. Providers in these cases remain synthetic.

- Ordinary worker fixtures cover a Close worker arriving after both deadlines:
  it retains the original chase/report cutoffs and shared-thread order across
  reconstructed engine calls, with no duplicate publication on retry. Idle
  hosted workers create no run or provider effect, and step workers leave
  non-enabled workflows untouched. Provider completeness inputs in these
  cases are explicitly synthetic and do not prove historical source coverage.
  The generic operator rejects the retired replay/simulation action names;
  an accepted ordinary opening executes the compiled workflow directly. The
  separate legacy routes still await the final removal gate.

- Hosted workflow and real Postgres engine cases now reside in fictional
  fixture assets behind unchanged CI entrypoints. Their authentication,
  decision, timer, concurrency and recovery assertions remain intact; database
  execution is still mandatory and rejects skips. An ordinary handoff case
  verifies that participant and item labels cannot inject Slack mentions or
  links through the Workspace rendering Tool before governed publication.
  This is synthetic regression evidence, not real-provider acceptance.

- Completed workflow evidence has a read-only operator `verify` action and
  `companyos verify-live --scope workflow`. The verifier checks the pinned
  execution journal, waits, human decisions, source completeness claims,
  ordinary effects and consumed batch approvals. Live verification compares
  exact deployment and expected approver identities and rejects synthetic
  evidence. Real source qualification, human acceptance, restart/rollback
  rehearsals, final removal and pilot evidence remain separate requirements.

- Public fixture tests run 28 computation cases through the maintained Company
  Tool inspector and isolation: 17 contract cases and 11 frozen synthetic
  outputs checked against the legacy close/rollover/readiness oracle. These
  cover selected computation semantics, not complete engine parity, live source
  coverage or human acceptance. The separate legacy executor remains pending
  the full migration gates.
  Two additional actual-engine regressions exposed and fixed stale work facts
  in the fictional close: workflow version 6 keeps participants frozen while
  reading current work status, membership and provider versions at each chase
  and report. Closed work produces no rollover decision, and late-processed
  timely replies retain the original report cutoff. The engine required no
  business-specific change.

- Generic hosted workers now expose `/api/workflows/timers`, `steps`, `records` and
  `operator`, with explicit Artifact/Instance activation, separate operator and
  scheduler credentials, durable pagination and no inferred business periods.
  Slack routing rereads exact provider replies, uses individual DM roots,
  checks current human/account identities and retains historical Artifacts and
  Records configuration. Synthetic host tests exercise a full Friday decision
  and one batch; actual installation qualification, source cutoff coverage and
  real test-Instance acceptance remain pending. See the
  [workflow operations guide](../operations/workflow-engine.md).
  The opt-in Records worker synchronizes exact current and retained source
  generations through the existing service, with current allowlists, active
  historical execution checks and durable bounded continuation. It creates no
  implicit provider cutoff evidence or production activation.

- The generic durable interpreter now runs the four fictional Workspace graphs
  through actual Company Tools and CompanyOSRuntime. It persists scalar/keyed
  progress, restores waits, freezes exact decision notices, authenticates bound
  responses and recovers completed effects. Memory and mandatory Postgres
  acceptance cover restart, cancellation and unknown-outcome refusal. Provider
  responses and human decisions in those tests are synthetic. Hosted endpoints and recipient checks have synthetic coverage;
  qualified source coverage, actual provider acceptance and legacy removal remain
  pending; no production activation or technical release is implied.

- Generic workflow persistence retains historical Artifacts, immutable openings,
  step/decision state and exact conversation bindings in the existing control
  schema. Optimistic commits, events and assignments are atomic. Dispatch and
  cancellation share an execution lock, with current lease/time checks.
  Additive database manifest `2.0.0` preserves the old `1.9.0` identity.
  Memory and required Postgres tests cover these boundaries. Hosted assignment/decision delivery now has synthetic integration coverage;
  actual provider and human acceptance remain pending. No production database has been migrated by this development work.

- Generic workflow calendars evaluate holiday-shifted triggers, opaque variant
  parameters, business-day approval/wait deadlines and delivery windows.
  Tests cover daylight saving, long weekends, absent calendar years, shifted
  occurrence ordering and canonical timer identity. Legacy calendar consumers
  reuse the extracted primitives. The interpreter supports exact scheduled openings; hosted schedule
  dispatch and activation remain pending. Calendar evaluation alone sends nothing.

- Compiled workflow Artifacts now use the Runtime Tool guard: host-owned
  context, exact run/step/Tool/input/binding/risk checks, current human decisions,
  exact recipient mappings and keyed effect identities. Restart tests use the
  actual Runtime effect claim without provider deduplication. Incomplete and
  unknown receipts preserve evidence and suppress another send. Hosted assignment and provider recipient qualification remain pending; this
  does not activate schedules or replace real human acceptance. See the
  [workflow guard contract](../specifications/workflow-execution-v1-draft.md#implemented-runtime-guard).

- JSON Record mappings can declare a bounded, self-contained `value_schema`.
  Ingestion enforces it before consuming an event identity; compiler consumers
  can use the actual structured contract. Slack Record Source `0.1.4` also
  emits the exact publication `thread_reference` for receipt-bound queries.
  Source coverage remains a separate, unfinished integration requirement.

- The governed `oregano:directory/members` standard Tool reads bounded facts
  from the frozen Artifact roster through an explicit Instance read-group
  policy. It uses normal grants, Capability bindings and authenticated runtime
  subjects; it exposes no approval rights and computes no company membership
  policy. Compiler-to-runtime sandbox tests prove access denial, immutability
  and installation/grant separation. See the
  [directory contract](../specifications/company-record-normalization-v1.md#read-only-directory-tool).

- Maintained Slack and Monday Record Source adapters emit exact qualified
  principals for roster resolution. Slack preserves fractional creation/edit
  timestamps and separates original author, current content author and bots.
  Monday keeps people and team assignments distinct under the qualified account.
  Provider-bound tests exercise real adapter reads and Record normalization;
  qualified time coverage and full workflow acceptance remain pending. See the
  [provider evidence contract](../specifications/company-record-normalization-v1.md#maintained-provider-evidence).

- Exact parent-scoped overrides pin transitive `fast-uri` to `3.1.6`, correcting the vulnerable
  `3.1.5` URI normalization used through AJV. This addresses the published
  [malformed IPv6](https://github.com/advisories/GHSA-f65p-4m7j-42xc) and
  [encoded scheme](https://github.com/advisories/GHSA-jqff-g426-hqxp) advisories
  and the related hostname-normalization alerts. The Builder SDK HTTP
  dependencies also use `qs 6.16.0` for the audit-reported denial-of-service
  corrections. Lockfile tests verify actual parent resolutions and absence of
  reviewed vulnerable versions; schema and runtime regression suites remain
  the compatibility gate. No exploit is claimed.

- [Typed Record normalization](../specifications/company-record-normalization-v1.md)
  checks declared scalar, array and nested values and executes bounded
  Workspace-declared sectioned-text parsing on the maintained ingestion path.
  Malformed answers and extra references remain evidence. Parser output cannot
  replace provider identity or time, and invalid input does not consume an
  event identity. Optional identity fields now resolve exact qualified principals
  against a frozen reviewed roster; ambiguous ownership fails, unresolved
  identities remain explicit and directory changes invalidate earlier source
  completeness. CLI and hosted Records bind the directory in operation
  confirmation evidence. Provider principal emission, roster/role aggregation,
  qualified provider cutoff coverage and full workflow execution remain
  pending integrations.

- The [Records workflow query contract](../specifications/company-records-query-v1.md)
  adds declared generic filters, bounded immutable reads, typed standard Tool
  outputs and explicit complete-source evidence. Required Postgres tests cover
  real SQL snapshots and restart. Provider adapters still need qualified time
  coverage before they can satisfy a `require_synced_through` request. The
  [workflow execution specification](../specifications/workflow-execution-v1-draft.md)
  records the target boundary; its durable engine and migration remain
  pending.

- The required [Postgres integration gate](../testing/postgres.md) provisions
  an isolated CI database and exercises the maintained HTTP driver and real
  stores without optional repository secrets. Missing or skipped required
  database tests fail PR and release acceptance. The initial run exposed and
  corrected absent Brain model provenance being stored as JSON null but
  queried as SQL NULL; source facts now round-trip and legacy null rows remain
  readable and idempotent. Actual model-derived claims retain their extraction
  and current-evidence checks.

- Company Records v0.1 implements validated generic source and projection
  declarations, immutable deduplicated source events and object versions,
  current pointers, access-scoped rebuildable projections, freshness,
  watermarks, per-source reconciliation leases, receipts, in-memory and
  additive Postgres stores, and the standard `records.query` Tool. The
  isolated `companyos_records` schema also contains durable timers, Connector
  echo receipts, and digest-only callback replay claims. No real Company
  Instance database has been migrated by this Core change.
- The generic Record Source registry now also has a maintained read-only Slack
  adapter for explicitly allowlisted public or private conversations. It
  verifies one exact team, channel, membership, kind, and required read scopes;
  reads bounded complete history plus thread replies; normalizes provider
  messages to `communication-message`; retains immutable raw versions; and
  fails closed on limited history, incomplete unbounded threads, pagination
  bounds, qualification drift, or rate limiting. A historical upper bound does
  not treat later live replies as missing. Protected Preview qualification reads
  only bot identity and selected-channel metadata and returns a content-free
  receipt without retaining the token. No real Slack history read, database
  write, schedule, or production activation is claimed by this Core change.
- Projection writes and removals now compare the expected immutable object
  version and mutate the projection atomically in the StateStore. A concurrent
  webhook, synchronization, or reconciliation pass therefore cannot let an
  older observation overwrite or remove a newer current projection.
- Initial Record Source snapshots process independent objects with a fixed
  Core-owned concurrency bound. An interrupted pass remains visibly incomplete:
  it publishes no watermark or successful receipt. An exact retry deduplicates
  Source Events and repairs only the matching current version and projection,
  so an older replay cannot replace newer projected state.
- Complete-inventory reconciliation now uses that same fixed Core-owned
  concurrency bound for observed objects and provider-absence checks. Exact
  retries repair interrupted current projections and tombstone removal only
  when the immutable version is still current. That check and mutation are
  atomic; watermarks and successful receipts remain completion-only. This
  provider-neutral correction addresses
  a separately governed production qualification in which a complete inventory
  of more than one thousand objects exceeded a five-minute hosted invocation
  while the bounded initial snapshot had completed successfully. The failed
  deployment was not promoted.
- The experimental `companyos records` Workbench surface now inspects sources
  and projections locally; qualifies the exact external Monday Agent identity
  and complete resource-grant set;
  materializes only an explicitly authored, qualification-checked Workspace
  declaration; and plans and confirms secret-bound synchronization or full
  reconciliation into the existing Company Instance database. Its generic
  Record Source Connector registry has one maintained read-only Monday
  adapter with exact board and optional group scope, explicit mapped columns,
  required pre-release API version `dev`, bounded complete pagination,
  payload-free evidence,
  and no retained credential. `status` reads counts, watermark time, and the
  latest receipt without record payloads and without creating a schema.
  Synthetic tests prove the lifecycle; no real provider read, database write,
  schedule, webhook, or production activation is claimed by this Core change.
- The maintained Vercel Runner now has an optional fail-closed Company Records
  rehearsal endpoint for protected Preview deployments. It independently
  plans and confirms a metadata-only Monday external-Agent qualification, the
  additive records migration, and one initial source synchronization. Hosted
  qualification keeps a non-exportable Sensitive provider token inside the
  deployment, returns only non-secret identity and selected-board metadata,
  and still requires a separate human identity-mapping confirmation. The lane
  reuses the maintained Connector and records store, reports payload-free
  status, and rejects production or a mismatched Git commit.
  Runtime configuration and credentials stay Instance-injected and the lane
  cannot reconcile, schedule, receive webhooks, write to a provider, or grant
  Agent Tools. No real Preview, database branch, migration, or provider read is
  claimed by this Core change.
- The experimental `companyos records source connect --profile vercel-neon`
  command replaces one-off hosted-rehearsal scripts with credential-free
  mode-0600 state. It freezes one exact clean Workspace/Core/source/binding
  selection, obtains migration and synchronization plans without effects,
  requires their independent exact confirmations, persists the migration
  boundary before synchronization, and completes only with payload-free
  watermark, zero-error receipt, and declared-projection evidence. Its first
  Instance profile reaches an already prepared protected Vercel Preview backed
  by an isolated Neon/Postgres branch; it does not create infrastructure,
  retain secrets, clean up provider resources, or activate production.
- The maintained Vercel Runner now has a separate fail-closed Company Records
  production lane. An operator endpoint plans and exactly confirms the additive
  database manifest, initial synchronization, or reconciliation and reuses a
  stored receipt for an already completed confirmation. A separately
  authenticated cron endpoint evaluates reviewed company-local schedules and
  performs only due complete-inventory reconciliation under the existing lease.
  Exact production deployment, Artifact, Core, Workspace, and Instance identity
  must agree; mutations and the scheduler have independent kill switches. The
  database manifest is now `1.9.0` and qualifies `companyos_records` alongside
  the existing schemas. Synthetic tests do not claim a real production
  migration, provider read, schedule activation, provider event, provider
  write, or message.
- Workspace inspection now rejects projection and selection paths that are not
  materialized by the exact selected Record Source set, preventing a declared
  field from silently remaining empty at runtime.
- The provider-neutral Sprint domain implements validated policy, append-only
  event reduction, controlled-clock business-time and holiday calculation,
  frozen-participant Friday completeness, actual-effort and open-work read
  models, deterministic shared-thread reminder/chase/report/retro/Rollover
  intents, and durable timer
  interfaces with in-memory and Postgres implementations. The reusable
  orchestration library now atomically persists one normalized event, its
  monotonic resulting state, decision evidence, and intents; consumes due
  timers through the same event path; leases bounded intent work; and enters
  provider execution only through an exact `CompanyOSRuntime`-backed adapter.
  Workbench now compiles reviewed Sprint policy, schedule and template digests,
  participant identity namespace, logical Agent and service principal, and
  exact destination/resource bindings into the immutable Artifact. The
  maintained Vercel Runner hosts authenticated inspect/open actions, bounded
  timer and intent workers, fresh projection resolution through
  `records.query`, Slack Friday-update normalization after roster and Agent
  resolution, a generic template renderer, and `disabled`, `shadow`, and
  `active` modes. The hosted Friday path creates one shared Close thread,
  accepts submissions only in that exact thread, and orders chase, report,
  retro, then Rollover preparation using provider-delivery events. Timer kinds
  are isolated per Sprint definition. Shadow mode stores digest evidence
  without effects; active messages still cross the standard Tool boundary. An
  explicit `shadow-only` Instance runtime can compile exact destination
  metadata without granting provider-effect Tools, and the hosted Runner
  rejects active startup for that Artifact.
  The authenticated Stage-0 Preview surface can invoke those same hosted
  workers at one exact controlled timestamp, allowing schedule, leasing, and
  duplicate behavior to be qualified without waiting for wall-clock time; the
  action is unavailable outside Vercel Preview.
  Weekly Monday handoff, weekday movement digest, configured readiness
  questions, derived reversible readiness-field maintenance, and structured
  `NEXT WEEK` carry-forward use the same hosted
  timer and intent path. Before each due weekly timer, the Runner resolves one
  twice-stabilized current work-item projection while retaining the Sprint's
  frozen participant scope. The immutable source version identifies an exact
  replay, while the resulting refresh event uses the hosted refresh clock so
  a valid source observation from before Sprint opening cannot regress durable
  event chronology. Replaying the same source version is a no-op.
  Briefing updates use an exact active-human subject confirmation and the
  dedicated confirmed-update Tool. Rollover remains proposal-only until one
  frozen batch passes the ordinary R3 approval path; the maintained batch Tool
  preflights every item before the first write and treats a partial provider
  dispatch as an unknown outcome rather than retrying it. The initial profile
  uses Monday polling and Slack interaction; Monday board-change webhooks and
  card chat remain deferred. No real Company Instance runtime, schedule,
  message, work-item effect, or production activation is claimed. Public
  fixtures are synthetic and contain no company people, resources, policy, or
  credentials.
- The hosted Sprint surface now makes the reviewed weekly and Friday Close
  paths executable in controlled tests. This is implementation evidence, not
  Company rollout evidence: the final candidate still requires full Stage-0
  qualification with exact test bindings, and each Company must then complete
  Shadow, Pilot, and Team-rhythm gates over the periods declared by its rollout
  policy before production completion may be claimed.
- The hosted Sprint operator can now run a proof-only historical replay when
  an Instance compiles one exact `communication-message` projection. The
  Sprint Domain recognizes template-shaped Friday submissions, resolves the
  author only through a tenant-scoped roster principal, links exact card URLs
  only to already authorized work-item records, and stores source-version
  lineage on durable Sprint events. The replay uses an isolated definition,
  controlled clock, and deterministic replay-specific timer namespace, so an
  exact retry is idempotent and independent replays of one historical period
  cannot conflict in a shared Instance timer store. It reports
  current-snapshot limitations and refuses every
  compiled live Slack and work-item binding. A separately authenticated,
  digest-bound `publish-replay` action can render one Workspace-owned report
  and deliver it through an exact test Slack channel plus an exact test-board
  report item. Workbench rejects a conversational publisher Agent and rejects
  any logical or physical test/live target equality. Both effects use the
  ordinary CompanyOS Capability, idempotency, receipt, and System-of-Proof
  boundaries; a changed digest fails before the first provider effect.
- The authenticated Sprint operator also has a proof-only `simulate` action.
  It freezes the same current Company Records projections, derives an isolated
  definition and timer namespace, and runs the real hosted weekly and Friday
  lifecycle with a controlled clock while forcibly remaining in Shadow mode.
  Its content-free report covers Monday handoff, weekday digest, readiness,
  Friday Close, Retro, and an optional Rollover proposal, including durable
  event, intent, timer, binding-readiness, and source-version evidence. The
  catalog explicitly marks Triage, Briefing, inactivity nudging, and blocker
  follow-up unavailable until their durable conversational runtime exists.
  Simulation cannot accept a destination, Tool, grant, template, arbitrary
  event, or provider payload and cannot call Slack or a work-item provider.
  A separate digest-bound `publish-simulation` action may publish one stored
  Monday hand-off intent through the actual compiled Sprint Agent and exact
  test-only Slack binding. It reruns the scenario, rejects changed output,
  derives the Workspace template and content from durable state, and records
  the ordinary provider receipt. Workbench rejects a live-channel alias and
  requires the runtime itself to remain `shadow-only`. The Slack adapter hides
  that operator-only publication grant from conversational model turns. A
  companion `publish-friday-close-simulation` action accepts no intent id and
  publishes only the fixed succeeded reminder, chase, and report sequence from
  the reviewed scenario. The real reminder receipt becomes the one Slack
  thread reference for both replies, and deterministic per-message effect
  identities make partial retries non-duplicating. Content and destination
  still come only from the compiled Workspace and Instance; Retro and live
  targets remain ineligible.
- Weekly Sprint declarations now compile independently. Monday hand-off can be
  enabled without also enabling daily digest and readiness; readiness retains
  its stricter planning, template, Tool, and direct-destination prerequisites.
- Core now maintains `records.query`, `work-item.read`, `work-item.update`,
  `work-item.batch-update`, `work-item.comment`, and
  `communication.message.publish` Capability contracts
  plus standard Tools. Artifact building makes those Tools available for
  normal ToolSet resolution; a Workspace grant still fails unless its Instance
  binds a compatible Connector.
- Immutable Artifacts may now freeze optional non-secret runtime Connector
  instance configuration separately from Capability bindings. The maintained
  Vercel Runner constructs exact-version Monday work-item and Slack
  communication Connectors plus the Postgres Company Records query Connector
  only from those entries. It verifies the Records configuration against the
  Artifact identity, resolves Monday credentials
  only through an environment SecretRef, and restricts provider calls to exact
  board/field or channel/DM bindings. The protected Preview-only Stage-0 surface
  adds digest-bound reversible Monday and exact Slack delivery qualification,
  including read-after-write, duplicate, echo, restoration, unbound-resource,
  provider-receipt, signature, and replay evidence. Repository tests prove the
  generic contracts. One supervised non-production Instance additionally
  produced real Slack `app_mention` and `message.im` deliveries with HTTP 200,
  exact `sprint` and `oregano` routing, visible single responses under provider
  retries, exact outbound channel and direct-message receipts, and one
  reversible Monday test-board write with read-after-write and restoration.
  This is Instance qualification evidence, not Core authority or production
  activation.
- The maintained Monday work-item adapter uses explicit API versioning, exact
  resource and field bindings, minimum permissions, optimistic version checks,
  read-after-write evidence, durable echo suppression, raw-body callback
  signature and timestamp validation, durable replay prevention, and
  `AgentResolver` for verified conversations. Synthetic Connector tests do not
  claim a real external Agent registration, account permission, cost, provider
  conformance, or production activation.
- Monday Record Source inventory normalizes both populated and empty People
  cells to stable provider-id lists while retaining the raw provider value as
  evidence. Hosted Sprint snapshots preserve mirrored work items with an empty
  provider status as an empty canonical status; they do not invent a status or
  drop the item.
- The maintained Vercel Runner now has an optional fail-closed Monday
  external-Agent ingress. It verifies the raw callback body, timestamp,
  signature, configured Agent identity, and digest-only durable replay claim
  before `AgentResolver`; normalizes current pre-release trigger aliases; and
  returns Monday-compatible SSE or JSON. Because the provider envelope does
  not identify the triggering human, only deterministic setup probes can
  produce visible chat content. Ordinary chat opens no Workspace material,
  model, or Tool, while mention and assignment are acknowledgement-only. This
  A real provider chat probe reached the configured public Company Instance on
  2026-09-02 and returned HTTP 404 because that Instance still ran Core v0.5.2,
  which predates this ingress. Signature, wrong-signature, and replay behavior
  passed through the protected candidate handler. A successful real callback
  remains an explicit post-deployment smoke test; no board trigger, Agent-token
  action, or production verification is claimed.
- `companyos records source qualify --provider monday` is the only maintained
  Monday qualification path. It accepts only the Instance-owned external
  Agent token, verifies the exact Agent identity parsed from `me`, requires
  the complete Agent knowledge-grant set to match the confirmed read and
  read-write board plan, and reads metadata for only those boards. It stores a
  mode-0600 non-secret receipt containing Agent, account, grant,
  board/group/column, API, request, and digest evidence. It retains no token
  and performs no provider write. When the token is non-exportable, the same
  command can use the maintained `vercel-neon` profile: it obtains and
  separately confirms an exact metadata-read plan, executes the read inside a
  protected Preview, validates the returned evidence locally, and retains the
  same final human identity-mapping gate. This external Agent is the sole
  maintained Monday qualification identity.
- The repository-local `oregano/sprint-agent` Blueprint contains one logical
  Agent Component, portable weekly, Friday Close, and reconciliation
  Workflows, Sprint, triage, and briefing Skills, owned Friday templates, and
  adversarial synthetic fixtures. Local Package inspection proves that it is
  declarative and authority-free; Workspace materialization remains an
  ordinary reviewed diff because Blueprint apply and lock are not implemented.
  Its first published Workspace surface keeps shared operational declarations
  under `records/sources/` and `records/projections/`, places company Sprint
  policy at `workflows/sprint/config.yaml`, and introduces no top-level
  Workspace `domains/` directory. Executable Sprint Domain code remains in Core.

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
- Company Knowledge productization implements the seven-phase Core path and an
  explicit Oregano HQ internal production-canary control plane. Retrieval Projection V3 deterministically
  normalizes Handbook fragments, Brain fragments, Claims, Source Objects,
  Timeline Events, and Working Syntheses into policy-carrying Retrieval Units.
  The Phase 7 `companyos-postgres@1.7.0` path can stage, hash- and count-verify,
  retire, and independently activate derived projections and optional 256-
  dimension embeddings. Exact, lexical, semantic, graph-neighbor, and Current
  Brief reads pass only pre-authorized policy identities into SQL. Embedding
  absence or failure retains lexical retrieval with an explicit degradation.
  KnowledgeBench measures Recall at K, reciprocal rank, authority labels,
  citation membership, ACL leakage, and degradation and persists payload-free
  V2-versus-V3 shadow evidence. Context receipts bind the active projection and
  authorized policy-set digest; the V3 Answer Envelope rejects unsupported
  claims and citations. Current Brief, Open Loops, and Meeting Prep are cited
  synthesized read models and never Handbook authority. The Knowledge Doctor
  blocks readiness on missing rollout-lane qualification, schema, projection,
  benchmark, shadow, ACL, citation, Source, restore, or rollback evidence. The
  generic isolated non-production contract remains strict. Oregano HQ may
  instead use a branch-rehearsed internal-only canary with exact Agent allowlist
  and projection hash. Runtime modes default to V2, shadow V3 while serving V2,
  or serve V3 canary with automatic V2 fallback. Database activation requires
  a persisted exact qualification receipt. On 2026-08-30 the linked Oregano HQ
  production Instance rehearsed the additive migration on a point-in-time Neon
  branch, qualified and activated one 1,419-unit projection, passed the
  payload-free benchmark, shadow, ACL, citation, fallback, and database gates,
  and deployed V3 canary for the exact internal `oregano` Agent. Live evidence
  recorded five authorized results, zero unresolved-subject results, and no V2
  fallback. The Doctor has no failed check; stale Source synchronization and
  the absence of a first Current Brief remain explicit warnings. Other Company
  Instances remain on V2 unless independently qualified.
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
  continuous model polling. Deployment
  `dpl_EdrL7WjYjF3C2MgNJ6KnBKACdq3k` proved segment prompt `5`. The maintained
  Vercel manifest now declares the conservative hourly expression
  `0 2-5 * * *`; an external production deployment must apply and verify that
  scheduler change. Operators shorten it first to 30 and then to 15 minutes
  only when incomplete continuations, a growing frontier, or maintenance-lag
  freshness warnings persist across two consecutive nightly windows, and
  restore hourly operation after two complete windows without backlog growth.
  Controlled alignment and backfill
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
  Artifact. A later broad CompanyOS question exposed a separate answer-quality
  defect: the required search still ran under the ordinary `agent.chat` Nano
  binding without the compiled Knowledge answer rules, so an uncited or thin
  model response was replaced by the safe ranked-excerpt fallback. Core now
  keeps normal conversation on the Agent profile but routes required Company
  Knowledge turns through the Knowledge-only `knowledge.cited-synthesis` deep
  binding in the same Tool loop. Its turn contract requires a direct synthesis,
  bounded traversal and full-item reads for broad cross-source questions, exact
  inline citations, and explicit authority, conflict, gap, freshness, and
  scope language. The existing validated-result gate and extractive fallback
  remain fail-closed. Health reports the non-secret ordinary Agent and required
  Knowledge-answer model selections separately so an operator can verify the
  live route without reading model configuration or credentials.
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
- Historical setup state version 4 introduced separate StateStore resource
  provisioning and schema preparation. Current schema-5 fresh runs retain the
  `database-prepare` phase; setup states 1–4 no longer resume. The following
  database-manifest and qualification evidence remains historical. The deterministic
  `companyos-postgres@1.9.0` additive manifest preserves the immutable `1.8.0`,
  `1.7.0`, `1.6.0`, `1.5.0`, `1.4.0`, `1.3.0`, `1.2.0`, `1.1.0`, and `1.0.0` identities and
  prepares `companyos`, `companyos_knowledge`, and `companyos_records`, records an immutable
  non-secret ledger entry, verifies required tables, indexes, integrity
  constraints, the 19 Core Page types, and optional vector availability, and
  returns a bounded qualification receipt. The records schema contains 14
  required Record Source and Sprint tables. The maintained Vercel profile wraps
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
  for 62 required Knowledge tables. Phase 7 adds five rebuildable Retrieval V3,
  benchmark, shadow-comparison, and productization-receipt relations for 67
  required Knowledge tables. With `pgvector`, Handbook fragments and Retrieval
  Units use two optional embedding tables for an expected total of 69 Knowledge
  tables. On 2026-08-30 the linked production Instance upgraded additively to
  manifest `1.7.0` and passed separate branch and production qualifications
  with digest
  `7114b3061ff5b277a931f33e08f1f6f803f2fbdd98539ffad9d487498e461167`,
  12 Control tables, 67 required Knowledge tables plus two `pgvector` tables
  for an observed total of 69, and 19 Core Page types. On 2026-08-27 the linked
  production Instance upgraded additively to 1.6.0 and passed a separate read-only qualification
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
- Historical release preparation: Oregano Core source was versioned `0.5.14` as the prepared patch candidate
  that extends the isolated Sprint scenario runner with a digest-bound, fixed,
  single-thread Friday Close test sequence. `v0.5.13` is the latest published
  release; `v0.5.14` becomes release authority only
  after its exact immutable tag and protected release commit pass the release
  workflow. The
  current release line covers the experimental Sprint and Company Records
  lifecycle, declarative Sprint
  Agent Blueprint, governed Agent handoffs, Monday qualification, fail-closed
  external-Agent ingress, resumable source connection, and separately guarded
  production records operator and scheduler runtime, including reuse of an
  existing app-scoped Slack Vercel Connect installation for a governed Slack
  Record Source, plus isolated durable timer identities for independent
  historical Sprint replays, plus proof-only full-week Sprint simulation using
  the compiled Agent, templates, schedules, records, and durable evidence.
  Existing consumers may remain on `v0.5.13` until they adopt the new exact Core
  authority, and publishing the Core does not activate a Company Workspace or
  Company Instance.
- Deterministic Agent Bindings and `AgentResolver` select normal Company Agents,
  including `builder`, from exact trusted surface identities. The Builder is
  opt-in: an Instance without both its non-secret Builder declaration and exact
  Agent Binding continues normal Agent and Knowledge operation. Its scheduled
  worker exits successfully without constructing a repository provider,
  Sandbox, or coding runtime.
- The v0.5.4 release candidate implements governed semantic Agent handoff and
  durable Conversation Assignment. Exact bindings remain stronger
  than assignments, and assignments remain stronger than the explicit
  default. Core authorization intersects the compiled direction, purpose,
  surface, active roster role or group, authenticated principal, Artifact, and
  current assignment. The Postgres adapter stores current assignments and
  append-only idempotent transition receipts without raw message bodies; the
  Runner exposes one bounded control Tool and changes routing on the next turn
  without copying ToolSets. Return and expiry are implemented and covered by
  neutral fixtures. Expiry may use the existing bounded fixed TTL or the first
  instant of the next local calendar day in an explicit IANA timezone; the
  latter still persists one absolute expiry and grants no additional authority.
  Production remains unproved: no private Company Instance migration, live
  deployment, live handoff, or live return evidence exists. Publishing Core
  v0.5.4 supplies this reusable behavior but does not deploy it to a Company
  Instance.
- Sprint close read models now distinguish unavailable effort from zero and
  calculate only the explicitly declared actual-hours or planned-effort basis.
  An absent required observation makes the derived participant and total metric
  unavailable instead of silently substituting zero or another metric.
- The experimental Builder control path persists immutable proposal jobs,
  supports leases, cancellation, recovery, and terminal Slack-card delivery,
  and separates exact repository source, credential-free coding, independent
  diff/Workbench validation, and trusted draft publication. The Runner retains
  only thin Tool, presentation, and action hooks; Builder chat behavior lives in
  a separate integration module.
- The maintained isolated worker pins ACP v1 plus Claude Code and Codex
  profiles. The maintained repository provider uses a service-owned GitHub App
  and separate trusted Git worker. Bounded Stage-0 evidence includes both model
  profiles, token and reported-cost status, deliberate ACP-process crash
  recovery, a mixed tracked/new-file digest match, one Slack-to-draft round
  trip, and idempotent draft publication. None of this grants merge or deploy
  authority, and no customer Instance is activated by the Core release.
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
  dynamic imports, and common sandbox escapes are rejected. The static
  inspector tokenizes template literals with substitutions correctly since
  2026-09-05; before that fix a valid Tool using `${}` was rejected as
  missing its default export, and a forbidden identifier placed after such a
  literal escaped static inspection (the isolated runner still denied it at
  execution). Parser-confirmed regular-expression spans also keep regexp
  backticks from hiding subsequent code; division and type-only imports remain
  inspected. These cases are covered by regression tests. The JavaScript
  parser is pinned to the existing lockfile version.
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
  builds. Its repository release candidate is `0.1.0-experimental.21`; no
  public package release is claimed.
- Newly generated Change Plans use version 3. They carry no status and no
  approvals: the pull request that carries a plan is its approval and its
  merge through the required check is the implementation record. A Core
  behavior or security plan records the Core, Package or Blueprint,
  Workspace, and Instance responsibility split, lists only the governed
  mechanisms it extends (every other mechanism is reused by definition),
  names new Core mechanisms, preserves company-neutral Core and synthetic
  public fixtures, and explains Core reusability. Inspection now fails closed
  when a changed file is missing from `files_expected`, when a catch-all glob
  is used, when a listed test file does not exist, or when a `proposal: true`
  plan travels with implementation files. Historical version 1 plans dated on
  or before 2026-08-31 and version 2 plans dated on or before 2026-09-05
  remain valid evidence and are not rewritten.
- Codex and Claude Code now share one plugin-free
  `INSTALL-COMPANYOS.md` Release runbook with `BOOTSTRAP_FOR_AGENTS.md` as a
  compatibility entrypoint. `companyos create workspace` supports interactive
  intake and a bounded agent answers-file transport, complete preview,
  confirmed atomic materialization, and a deterministic
  `authoring-only-local` bootstrap checkpoint.
- Standard `companyos setup` owns the fresh private GitHub, Vercel, Neon and
  Slack installation under one scoped initial decision. It writes the canonical
  Instance declaration into the checked initial operating Workspace commit and
  verifies live health plus the ordinary first Slack exchange. Only schema-5
  fresh sessions resume; the explicit installer and state schemas 1–4 are
  retired before provider work. Existing installations follow governed upgrades.
- The maintained setup now requires Vercel Pro or Enterprise. It detects the
  selected team's plan before hosted resource creation, rechecks on resume
  and before deployment, and verifies the current plan in `verify-live`.
  Hobby receives a billing link and can resume after a human upgrade; missing
  plan access receives a separate diagnostic. No cron-frequency question or
  automatic billing change is introduced. Synthetic provider tests cover the
  prerequisite and resume behavior; fresh external setup qualification remains
  outstanding.
- The [five-minute standard setup](../plans/2026-09-08-five-minute-setup.md)
  is implemented: CLI-owned account/default discovery,
  one initial decision including deployment, direct operating initialization,
  checked first commit, private resumable state and an ordinary first Slack
  exchange with model/persistence evidence. Release CI builds checksummed platform payloads;
  client setup and initial CI use bundled tools. Model metadata comes from one
  registry. Local and simulated tests establish these contracts; fresh cold live
  qualification remains outstanding. A five-minute claim
  requires five qualifying cold runs per harness and advertised platform.
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

- Retrieval V3 remains an Oregano HQ internal canary, not the reusable default.
  The refreshed production projection passes all twelve relevance cases with
  `1.0` recall, `0.91666667` mean reciprocal rank, complete authority and
  citation accuracy, zero authorization leakage, and no degradation. The
  stricter exact-sub-unit diagnostic remains `10/12`: both misses are
  synthesized Timeline Events for which a higher-ranked unit from the same
  parent event is returned. The Oregano HQ meeting Source is healthy with a
  recorded successful-sync timestamp. Fourteen Current Briefs are current;
  six of ten strategy-matching Pages have a current Strategy Brief. This is
  Instance evidence, not reusable-default qualification. A separate isolated
  non-production Instance and independent receipts remain mandatory before
  using this rollout pattern for another company.
- Meta and other business-provider Connectors are not implemented or
  activated. The maintained Monday and Slack adapters are implemented and
  synthetically tested; each exact Company Instance still requires external
  registration, non-production binding and qualification, staged activation,
  and production evidence. Every real provider still needs exact installation authority,
  secrets, resource grants, health, retry, reconciliation, cost review, staged
  rollout, and live conformance evidence.
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
3. Decide whether the four strategy-matching Oregano HQ Pages without a Current
   Brief have enough distinct Claims to justify synthesis, and improve the
   strict exact-sub-unit Timeline diagnostic only if a product use case requires
   that granularity. Establish a fully isolated non-production Instance before
   broadening changes beyond internal dogfood or using the pattern for another
   company.
4. Re-qualify the hardened `vercel-neon-slack` setup profile through a fresh
   external end-to-end installation before recommending that starter broadly
   or expanding its activation claims. The prior profile completed a real
   supervised installation and exposed the provider receipt, runner-root,
   Slack-authorization, naming, and health-readiness gaps addressed by its
   Change Plan; the hardened revision still requires its own independent
  setup-profile qualification. The opt-in v0.5.1 Company Brain release does
   not change or qualify that setup profile.
5. Publish a signed Workbench package so Workspace-only Contributors do not
   require a Core source checkout.
6. Require and qualify hosted repository protection before any future
   unattended agent receives repository write, merge, or deployment authority;
   the maintained supervised starter deliberately grants none of those
   capabilities.
7. Operate and review 10–20 representative proposal-only Builder jobs across
   content, behavior, expected failure, cancellation, and recovery cases before
   considering broader pilot guidance. This is supervised operational evidence,
   not a threshold for auto-merge or deployment authority.

Historical detail remains in archived sources as migration evidence; it does
not override this page or the canonical architecture and specifications.

Record cutoff filters and completeness proofs preserve up to nine fractional
digits across timezone offsets and memory/Postgres stores. Invalid calendar
dates fail. Provider-qualified time coverage remains a separate pending gate.

Executable workflow authoring validation is implemented. The compact steps,
generic literal config and schedule schemas are checked by `companyos validate`,
including typed references, owner grants, Capability risk minima, markers and
forward control flow. The fictional Lindenhof Workspace and mutation tests
provide authoring evidence. The generic Artifact compiler now also embeds all four workflows, resolved
Tool contracts, templates, literal config, calendars and required output paths.
The complete Friday manifest has a checked-in expectation. The runtime guard and durable interpreter now execute these manifests. Provider
completeness and hosted acceptance remain pending.


Workflow Artifact compilation now uses the same captured Workspace bytes as
validation and Agent Tool loading. Tests prove immutable source/contract
binding and canonical manifest identities, including changed Tool source and
Instance bindings. No generic workflow activation or provider execution is
claimed by this compiler gate.


Builder proposal inspection now rejects root `state/` changes across the
complete base diff, including local worker commits, deletions and renames.
The actual Workbench validator is covered by negative fixtures. This protects
proposal acceptance; it does not change database permissions or activate an
updated hosted Builder profile.


Approval expiry and consumption are now enforced at the atomic store boundary.
New requests receive a finite deadline; retained unbounded requests cannot
create effects. Expired or superseded requests, mismatched run/step/input and
rejected decisions produce no partial claim. Real Postgres counterexamples
cover these refusals and ambiguous creation timestamps. Workflow business-day deadlines are integrated with the durable interpreter;
real hosted acceptance remains pending.


Generic R4 approval now requires a recorded active human requester and a
different active human approver with distinct stable roster IDs. The Runtime
writes request evidence before exposing the request; the approval path reads
that exact evidence and rejects missing, remapped or self-requested approval,
including alternate principals for the same person. Ambiguous principal
mappings and unknown identity kinds cannot approve. Workflow assignment and role-specific decision integration now have synthetic
host coverage; real human acceptance remains pending.

Blocked workflow effects now have a current-human authenticated, paginated
operator review report over retained effect receipts. The maintained batch
adapter exposes verified, uncertain and unattempted entries. Registry validation
rejects partial success-shaped results and incomplete item coverage as unknown;
operator review never retries or reconciles an effect. Synthetic actual-adapter
and engine tests cover this boundary. Automatic business-owner notification,
qualified recovery, live test acceptance and legacy removal remain outstanding.

Slack source inventory now rejects repeated channel or thread continuations
before repeating a request and refuses foreign or invalid reply roots. Focused
synthetic adapter tests cover both traversal scopes and thread identity. This
hardening does not establish older-root coverage or historical cutoff proof.

The fictional Workspace now retains numeric and unavailable effort calculations
in its isolated Company Tool, with schema-checked unknown values and explicit
basis selection. Friday version 7 passes configuration through the ordinary
engine and uses returned evidence text. The default remains unavailable; no
actual company source mapping or provider collection is activated. These cases
extend computation parity, not the full legacy removal or live acceptance gate.

Maintained work-item effects now verify exact item identity in preflight,
mutation acknowledgements and readback. Single update/comment receipt loss
preserves an unknown outcome, and complete batch preflight rejects unmapped
fields before writing. Synthetic adapter and ordinary-engine regressions cover
these cases. Current write-credential qualification and real provider acceptance
remain separate outstanding checks.

Additional ordinary-engine fixture cases exercise the close cohort, approved
absence, all-open rollover, late workers, empty commitments, current Monday
grouping and one focused readiness question per owner. Their independently
specified expectations live under fictional fixture assets and import no old
executor. Provider responses, coverage and human decisions are synthetic inputs;
these cases do not replace real Instance acceptance or complete assertion parity.

Company-example engine and calendar cases now live under the fictional fixture
directory, with thin test entrypoints. Additional actual-engine cases cover a
holiday-shifted close with persisted same-day waits and business-day expiry,
a summer opening at the declared local wall time,
six independent weekly openings without duplicate evidence or publications,
and separate timer identities for two operator runs of the same period. These
are synthetic lifecycle proofs, not another scenario executor or publisher.

Reply-receipt conformance exposed an assignment early return that skipped
destination and thread checks for messages in an existing thread. The engine
now checks both identities before that return. A wrong destination, changed
thread or absent reply-thread receipt blocks the step and its dependants while
preserving the original effect. Synthetic adapter regressions fail before the
fix and verify that ordinary resume does not resend or advance to a report,
retro or batch; matching receipts still progress.

The maintained Monday adapter now accepts distinct values in the exact approved
batch array. A new actual-adapter traversal exposed and removes its extra
identical-values restriction, which blocked mixed readiness label changes after
approval. Complete preflight, mapped fields, expected versions, partial receipts
and ordinary runtime idempotency remain enforced. The reference compiler golden
reflects the corrected standard Tool description; contract shapes and bindings
are unchanged. Live write-credential qualification remains outstanding.

The maintained hosted Monday factory now requires a pinned non-secret provider
identity and installs same-client qualification before every invocation. Current
account/member/Agent mismatch, unavailable resources, revoked access and invalid
field mappings fail before work-item access. Qualification metadata survives
success and uncertain outcomes. Six synthetic tests exercise the actual hosted
factory and client. Actual test credentials still require their real resource
qualification; no live provider acceptance or production change is claimed.

Workflow calendar discovery now scopes executable validation to declared
opening/wait triggers and explicit calendar paths. Five synthetic regressions
cover prose-only Workspaces, unrelated Records scheduling metadata, explicit
and wait-selected calendars, missing declarations and ambiguous/unreadable
candidates. Other scheduling metadata no longer changes compiled manifests or
acquires executable calendar fields. This correction enables migration
preflight; it does not activate an operating workflow.

Stopped approval-bound effects now have a separate automatic R2 review-notice
path through the ordinary engine and publication Tool. Frozen per-item pages
target the actual human approver's retained decision conversation, with current
role qualification, publication receipts and cancellation fences. The business
cursor stays stopped. An uncertain notice is itself retained for operator
review. Synthetic memory/provider and mandatory Postgres regressions cover
multi-page delivery, crash recovery, revoked authority, changed input, expired
business approval and cancellation. Actual provider delivery acceptance remains
required before release or activation.

The Records source connection planner now accepts the two documented non-secret
Slack credential provider selectors at their exact Instance configuration path.
Previously its credential-key heuristic rejected that supported setting before
connection planning. Inline credentials, arbitrary or nested selectors and
selectors on another Connector still fail inspection. Actual credential exchange,
provider qualification and source synchronization remain separate unchanged
operations; passing the binding check grants no provider access.
The existing credential-resolver regressions now have a default testkit
entrypoint so the ordinary PR check runs them as well.

## Complete current Records scans

Records supports an explicit `require_scan_started_after` query alongside the
existing historical completeness requirement. Successful scans retain exact
immutable membership; current reads exclude absent old rows and partial later
ingestion without deleting audit history. Maintained Slack/Monday Connectors
record their actual read intervals. Memory and mandatory Postgres tests prove
empty/edit/absence/failure/restart behavior. Workflow authoring, compilation, trusted Tool input and retained-run live
verification now support explicit current-scan requirements and preserve the
original logical deadline for delayed workers. Real engine tests cover complete
execution and rejected stale/missing/contradictory scan evidence. Operating
Workspace adoption remains pending; no real-provider workflow acceptance or
production activation is claimed.

The maintained Monday Record Source supports optional Instance schema mappings
for logical columns and physical groups. One reviewed source can normalize
equivalent boards with different generated IDs. Qualification and fresh metadata
checks enforce exact IDs and types; raw provider evidence remains unchanged and
root mappings cannot leak into child or metadata rows. Fictional adapter tests
cover equivalent normalization and rejected invalid or stale mappings. Actual
company schema preparation and end-to-end test-Instance acceptance remain open.

The maintained workflow evidence verifier accepts an explicit bounded required
control set, recorded in its digest, with all four controls still the default.
Every executed step remains checked. The live CLI now validates current-scan
interval and membership receipts as well as historical source completeness.
Subset receipts establish only their declared scope; real-provider, human,
recovery, full-candidate and pilot acceptance remain separate requirements.

Ordinary workflow conformance also exercises competing workers in memory and
Postgres, preserving every completed step and one publication across store
reconstruction. Persisted wait cases cover duplicate scheduling/completion,
expired claims and explicit delayed retry. A missing report receipt blocks the
dependent retro and decision even after operator resume; changing the synthetic
provider cannot replace the retained receipt or authorize a second send. These
are synthetic-provider regressions, not live acceptance or legacy-removal proof.

Declaration conformance now also runs ordinary workflows built from validated
Record sources, projections and company-owned literal parameters. Counterexamples
reject protected materialization targets, unresolved projections, invalid
referenced calendars, undeclared calendar credential fields and dynamic or unsafe
configuration. Retained runs preserve their original compiled inputs. These
tests preserve generic authoring boundaries without a separate business executor.

The fictional close-classification Company Tool also preserves observed open-item
titles and HTTPS links in its presentation. Optional display data never changes
the exact versioned decision payload. Ordinary-engine cases check participant
labels, retained source-row provenance, closed-item exclusion, escaped labels,
thread linkage and repeat execution; malformed links fail Tool validation.
This presentation remains Workspace policy, not runtime business logic.

The ordinary engine also consumes the maintained Company Records Connector in
conformance tests. Bound source generations, exact roster principals, sectioned
text parsing, current-scan membership, query authorization and source-version
provenance are exercised together. Identical display names never substitute for
identity evidence. Unmapped role identities and missing reader groups block before
the first operating message. A report retains its accepted source snapshot after
later source changes. Provider inventories and publication boundaries in these
tests are synthetic; live qualification and human acceptance remain outstanding.

Dispatch conformance now starts from ordinary engine-created runs and actual
persisted worker claims. The maintained context reader and Runtime reject changes
to run, step, Agent, human, Tool, destination or message content before a provider
call or effect claim. A reconstructed worker recovers the successful receipt once;
replaced leases and changed Artifact bytes cannot authorize another dispatch.
An unavailable exact Connector retains its failed effect and requires explicit
reconciliation even after configuration recovery. These synthetic-provider tests
do not replace live recovery or qualified target-isolation acceptance.

Additional ordinary-workflow conformance rejects missing operator credentials,
undeclared opening-clock overrides, changed timer claims and conflicting stored
timer identities. Foreign Instance and timer-kind rows remain untouched. Invalid
message variables and unresolved configuration cannot replace a compiled run;
the original Agent instructions and Skill material remain recoverable after a
later Workspace build. These cases use isolated synthetic stores and providers.

The fictional message source and projection now retain their already parsed
next-period goal and measurable outcome alongside task links. This prevents
normalization from discarding bounded planning fields without adding business
logic to Core. Ordinary Records conformance also checks distinct qualified
owners despite identical titles, unassigned cards, blank statuses and unknown
effort. These examples do not change live source scope or workflow activation.

Hosted Record Source setup now retains the locally validated roster snapshot
in its generated runtime configuration and confirmation. Exact single-source
`source_ids` projections are accepted alongside legacy source selection; a
multi-source view is not narrowed implicitly. Synthetic end-to-end setup cases
prove hosted principal resolution, changed-roster confirmation invalidation,
preserved old mappings and compatibility for sources without identity resolution.

## Unpublished installer test path

The working source supports local candidate bundles with exact commit/platform
and checksum verification, pinned resume, a labeled setup review, and initial
GitHub checks using the exact pushed source without a release lookup. Candidate
timing cannot qualify the stable release installer. No live provider run or real
database integration result is claimed by this implementation.

The candidate integration branch includes Core `0.7.0` from `main`.
It preserves the newer Builder release and Workflow behavior, resolves the setup
conflicts, and automatically gives each candidate a separate Slack connector.
The maintained database suite passed all 67 tests on disposable local PostgreSQL
15.18 with zero skips. This is real database evidence, not a live Slack/Vercel
setup or timing claim. See the
[setup integration review](../plans/2026-09-08-setup-integration-review.md).

Slack Record Source `0.1.4` accepts the provider's legacy system bot identity
`B01` while preserving bot authorship and rejecting malformed identifiers.
A synthetic inventory regression covers successful system-message ingestion
and prevents its attribution to an authenticated human.

## Hosted readiness correction

Core 0.8.1 resolves hosted Connector dependencies from enabled workflow owners
and their retained Tool grants. An unrelated Company Records Connector no longer
blocks a comment-only workflow. Workflows that use Records still require an
immutable, correctly paired configuration snapshot. The installer also resolves
the pinned pnpm package behind the shell shims used by CI. Neither correction
changes provider authority or replaces actual functional acceptance evidence.
