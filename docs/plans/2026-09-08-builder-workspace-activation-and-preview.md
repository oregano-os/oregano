---
document_id: plan.builder-workspace-activation-and-preview
title: Workspace-Declared Builder Activation, Configurable Review, and Preview Testing
kind: plan
status: draft
authority: informative
language: en
updated: 2026-09-09
owners:
  - oregano-maintainers
audience:
  - human
  - agent
relations:
  depends_on:
    - specification.builder-governance
    - architecture.company-instance
    - architecture.validation-inspection
    - governance.roles
    - guide.operate-builder
---

# Workspace-Declared Builder Activation, Configurable Review, and Preview Testing

## 1. Scope and decision status

This is an implementation proposal, not an implemented contract or an Instance
activation. It describes one company-independent Core feature. Private company
adoption is separate and must not introduce company IDs, channels, policies,
repository names, credentials, or operating data into Core.

The product direction established for this proposal is:

- A valid Builder definition in a Company Workspace declares desired activation.
  There is no additional user-maintained Instance enable switch.
- A Company Workspace can require Steward acceptance or delegate acceptance of
  a member's own changes. Core enforces the declared authority and scope.
- Coding-agent and hosting profiles are replaceable behind maintained contracts.
  The initial private pilot selects Claude Code without making it a Core default
  for every company.
- Explain the complete conversation, authoring, testing, acceptance, and release
  path. Prefer automatic defaults over repeated technical questions.
- Reuse existing company app installations and connections for test destinations.
  A second test app, separate provider account, and dedicated test channel are
  not prerequisites. The Builder recommends a supported test and explains its
  scope; the human can adjust it in conversation without a required choice menu.
- Materialize and verify all required Preview configuration and access through
  maintained setup adapters. Manual production-to-preview environment copying
  is not an acceptable onboarding or per-change workflow.

Recommended defaults and future field names in this document remain proposals.
In particular, no actual customer review policy, data-copy permission, test
channel, budget, or production deployment authority is selected by this document.

The [accepted experience and test direction](../specifications/builder-governance.md#accepted-builder-experience-and-test-direction-2026-09-09)
refines this plan as of 2026-09-09: Build request terminology, evidenced progress,
one result card, and Agent-recommended testing. The interactive Agent conversation without Tools and the guided cards are now
implemented in the follow-up Core change. Simulation remains deferred. Adoption
of that code and provider/human verification are separate from the design record.

## 2. Existing implementation and gaps

Inspection baseline: Core commit `95f1ddcdfaa385561111cab9dfa8b4c7e6861cbc`.
Provider documentation was checked on 2026-09-08.

| Surface | Existing behavior | Required extension |
|---|---|---|
| Workspace loading | Generated Workspaces contain a Builder placeholder; loading depends on `instance.builder.enabled`. | Make the versioned Workspace definition express intent; stop generating inactive placeholders; report operational readiness independently. |
| Instance configuration | A present Builder block accepts only `enabled: true`. | Remove the redundant boolean through an explicit compatibility migration. Keep execution and repository bindings as provisioning data. |
| Conversation | Exact routing and governed handoff exist, but handoff applies on the next turn and histories are stored per Agent. | Preserve one user conversation and pass an authorized structured brief without asking the user to repeat it. |
| Coding | An asynchronous durable job runs Claude Code or Codex through ACP in a Vercel Sandbox. | Add the pinned Workbench and Guides, typed brief, diagnostics, bounded repair attempts, and resumable user-directed revisions. |
| Result validation | Independent diff inspection plus `inspect`, `validate`, and `security`. | Correct working-tree inspection, classify effects consistently, and add relevant behavioral evidence. |
| Publication | A trusted process creates the commit and draft PR without exposing Git credentials to the coding process. | Keep this boundary; attach human-readable consequences and exact test evidence. |
| Acceptance | Steward governance with optional independent review; no generic chat acceptance-and-release path. | Add configurable eligible acceptors and scoped requester acceptance, enforced in both chat and Git. |
| Test execution | Scenario/replay and protected Preview rehearsal exist for specific maintained modules. | Extend those mechanisms with a Builder candidate and test-session contract; do not claim a generic preview service already exists. |
| Preview access | Environment SecretRefs and Vercel Connect resolution exist; bindings and artifacts are environment-specific. | Resolve a candidate's dependency manifest, attach existing eligible connections to the execution environment, and verify real target access before declaring the preview ready. |
| Database | Core owns versioned Postgres manifests and prepare/verify operations. | Rehearse supported migrations on isolated state; separately design any company-owned schema extension before accepting arbitrary SQL. |

Known correctness issues to fix first:

1. `packages/cli/src/inspection.mjs` compares `base...HEAD` even when a Builder
   result is still an uncommitted working-tree patch. Tracked modifications can
   disappear from classification; intent-to-add also changes new-file discovery.
   Use the exact materialized candidate consistently across validation and
   publication. Regression cases must cover tracked, staged, new, deleted,
   renamed, mixed, and unchanged paths.
2. A required `.companyos/changes/` plan can raise a behavior-only proposal to
   security merely because `.companyos/**` is classified as security. Exempt
   evidentiary plan content from that automatic escalation while retaining
   validation and protection of actual governance or approval evidence.
3. Existing review documentation contradicts the default single-Steward mode.
   Update all affected contracts together; do not infer a second reviewer from
   the word security.

## 3. Responsibility and reuse

| Boundary | Responsibility |
|---|---|
| Core | Activation semantics, schema validation, authority resolution, chat handoff, durable Builder jobs, coding profile registry, Workbench access, candidate validation, preview lifecycle, receipts, and release orchestration. |
| Package or Blueprint | Existing reviewed capabilities and declarative templates that a Builder can reuse. No arbitrary provider SDK or privileged runtime is introduced by a Workspace file. |
| Workspace | Builder instructions, goals, relevant context, acceptance policy, eligible members/groups, bounded process authority, logical test preferences, and allowed capabilities. |
| Instance | Verified repository and provider connections, coding profile binding, deployment target, secret references, state resources, exact test destinations, budgets, and lifecycle limits. |

Reuse AgentResolver for initial trusted routing and extend governed Agent
Handoff for context transfer. Reuse roster identity, ToolSet resolution,
capability authorization, approval/effect receipts, and durable idempotency.
Retain the existing Builder execution, ACP profile, source, validation, and
publisher boundaries. ModelRecipe resolution remains the mechanism for normal
chat and runtime models; a coding-agent process profile is a distinct binding,
not a reason to create another general model router.

Extend the existing runtime-host/state-service setup adapters, connection
resolvers, and rehearsal patterns for temporary test resources. Reuse scenario execution and
fake business time where available; register module-specific test support
instead of inventing a second workflow engine. Extend existing timers/leases
for cleanup and test-session expiry.

## 4. Desired activation and readiness

Under the new versioned Workspace contract, a valid `agents/builder/` definition
means the company wants Builder available. Removing that definition removes
the desired capability. It does not delete historical jobs or evidence.

Do not add a replacement `builder.enable` flag in another file. The Instance
contains only the connections and execution choices required to satisfy the
definition. Missing prerequisites are reported as specific readiness gaps,
such as repository connection, runtime image, or model access. Conversation
and explanation should remain available when coding cannot yet start.

Readiness distinguishes structural validity, conversation availability,
proposal execution, optional preview capabilities, and production adoption.
A missing live test connector must not disable simple proposal authoring.
An operational emergency suspension may stop new jobs through audited Instance
operations; it is not a second desired-activation configuration.

Migration must be deliberate because old generators created inactive Builder
placeholders. Migrate known active installations without reauthorizing existing
scope. During adoption, inspect legacy inactive placeholders and either retain them
as intended Builder definitions or remove/archive them. Compiling a definition
must not grant coding execution, add a handoff route, broaden its read scope,
or divert the existing normal chat. Missing Instance bindings keep execution
unavailable. Do not add another per-request activation confirmation. Existing jobs retain their
original immutable configuration. A pre-1.0 contract change requiring this
migration belongs in a minor release, with the exact version chosen at release.

## 5. Company-configurable acceptance

Store the policy in the existing `.companyos/governance.yaml` authority surface,
with schema and deterministic resolution implemented in Core. Avoid duplicating
the policy in Agent prompts or Instance variables.

Two independent concerns must be represented:

1. **Eligible acceptor:** the assigned Steward or the authenticated requester
   within a company-delegated member/group and change scope.
2. **Independence:** whether a distinct authorized person is additionally
   required. Preserve existing `steward`/`independent-review` compatibility;
   do not misuse that existing field to mean every member has authority.

Product-facing presets can be Steward acceptance and member self-acceptance,
with scoped overrides. A company may delegate ordinary content and process
changes to all active members or a smaller group. The Core must not hardcode
one company's choice. Recommended initial policy delegates bounded content and
behavior changes while keeping authority/configuration changes with their
existing authorized administrators.

Self-acceptance is an explicit human acceptance of the exact tested candidate,
not automatic acceptance of arbitrary model output. Request, acceptance,
repository merge, production release, and business effects retain separately
checkable authority. One user and one combined UI action may cover acceptance
and release when that user already has both authorities and sees the exact
candidate, target, and migration consequences.

The normal employee path has one final acceptance action. If the user has
release authority and the recorded deployment intent is immediate, that action
starts merge, deployment, and verification without another confirmation. The
requester does not need direct GitHub access or to operate a deployment console.
When another person has the required authority, route the existing result to
that person in the same workflow rather than restarting the request.

Core invariants remain: authenticated actor, scoped authority, no self-grant,
exact-result evidence, credential isolation, and checked publication. Evaluate
changes to the acceptance policy or membership under the previously accepted
policy, never under permissions introduced by the proposed patch. Resolve the
strictest applicable scope across the actual diff and effects. Revalidate
identity and current authorization immediately before acceptance and release;
revocation or relevant policy changes invalidate stale receipts.

Git enforcement must implement this same policy. A chat button alone cannot
override CODEOWNERS, branch rules, or missing repository protections. Do not
give every requester direct write credentials. Add a separate trusted merge
executor with minimal permissions only when the acceptance path is implemented;
the coding process and draft publisher do not acquire merge authority.

## 6. Conversation and execution sequence

The employee-facing minimum is request, checked result, and one authorized
accept-and-apply action. The draft PR is review evidence behind that experience;
a proposal-only milestone is not the complete employee product. Preview is
conditional. The internal sequence is:

| Step | User experience | Actual execution |
|---|---|---|
| 1. Understand | Describe a desired change in the normal company chat. | Existing Runner authenticates the member and reads authorized Workspace context. No coding process yet. |
| 2. Specify | Answer only material questions not resolved by documentation; receive a concise goal and success criteria. | Core creates a typed brief with scope, non-goals, decisions, context references, exact versions, and test intent. |
| 3. Start | An explicit request to build within an authorized scope starts work; ambiguous intent uses one consolidated confirmation. | Core records one idempotent durable job and reserves a bounded execution budget. |
| 4. Develop | A single status message reports work and meaningful blockers. | The selected coding agent runs in an isolated coding Sandbox against an exact credential-free Workspace copy, using pinned CLI, Guides, and tests. This is where files are changed. |
| 5. Verify | Receive results or a substantive decision request, not routine command approvals. | Trusted validation inspects the actual result; correctable failures return structured diagnostics to a bounded new attempt. |
| 6. Try when needed | Use simulation, existing test resources, or an authorized bounded live trial. | The test controller chooses the smallest supported execution environment and resolves actual access; Preview and isolated database resources are conditional. |
| 7. Revise | Ask for a change in the same conversation. | Record a new candidate revision and rerun affected checks; previous acceptance and preview evidence cannot authorize changed output. |
| 8. Accept | Accept it yourself or send it to the required Steward according to policy. | Deterministic authorization binds the human decision to the current candidate and test evidence. |
| 9. Adopt | The recorded immediate/later intent applies; an authorized final acceptance can start deployment without a second dialog. | Trusted release execution applies the reviewed migration if any, builds the production artifact, verifies health, and records the exact active pairing. |

Use concise job status and a terminal result in the original conversation.
Existing confirmed jobs may continue to update their original action card; new
requests require no mandatory start card. Avoid raw stream dumps, repeating
confirmations, or requiring a second chat.
Expose cancellation and genuine failures. A model-process crash does not resume
an ambiguous half-executed turn: preserve evidence and use an explicit new
attempt under the existing authorized job scope and remaining budget where the
new contract allows it. Infrastructure recovery is not permission to duplicate
the logical request, publication, test message, or release.

### Versioned brief, free-form conversation

Use one small versioned Core schema for the build brief. The user writes normal
language; the chat agent fills the schema from the conversation, Workspace
documentation, and existing defaults. The following is illustrative proposed
syntax, not an implemented command or schema:

```yaml
version: 1
goal: Send the weekly summary after collecting the final responses.
acceptance_criteria:
  - Missing responses trigger the configured reminder before the summary.
  - The summary includes all available responses exactly once.
constraints:
  - Preserve the current participant scope.
context_refs:
  - workflows/weekly-summary.md
test:
  preference: auto
  instructions: Simulate one missing response and one late response.
  target_refs: []
deployment:
  intent: after_acceptance
```

Keep goal, acceptance criteria, constraints/non-goals, context references, test
intent, and deployment intent as the stable machine fields. Test preferences
are `auto`, `simulate`, `test-resources`, or `live-trial`; target references are
logical company bindings, not unverified provider addresses. Optional
provider-specific settings belong behind the selected adapter contract rather
than in every brief. Descriptive fields remain free-form.

Core adds authenticated requester identity, policy scope, exact provenance,
candidate identity, resolved dependencies, and execution limits in a separate
trusted envelope. Text supplied by the user, a skill, or the coding agent does
not populate trusted authority. A requested test must be resolved to a concrete
environment, data scope, destination, and permitted effect before execution.

Provide one Core-owned versioned Workbench Guide or Skill describing how a chat
agent prepares this brief: read first, fill known fields, propose appropriate
tests, record deployment intent, and ask only for missing material decisions.
Company Skills may add process-specific test cases and defaults. They must not
duplicate schema or authorization logic. All interfaces consume the same schema
and diagnostics; the brief can be inspected on request without becoming a form
that every employee must fill or approve field by field.

## 7. Development and test environments

Vercel Sandbox and Vercel Preview serve different purposes. Sandbox hosts the
coding agent and local checks. Preview hosts the built candidate so humans and
integration tests can interact with it. A Neon branch supplies isolated durable
state for that preview when needed. None is a second company repository.

The optional hosted reference profile uses Vercel Sandbox + Vercel Preview + Neon/Postgres.
The neutral contract records the candidate, runtime, state, resource bindings,
effect mode, data policy, expiry, budget, and results. Other qualified providers
can implement the same contract without company-specific Core forks.

Static/local validation, exact diff inspection and relevant checks remain the
baseline. Additional testing is resolved internally along independent dimensions:

| Dimension | Choices and implications |
|---|---|
| Interaction | Automatic examples or human conversation with the exact candidate. An interactive test is not inherently a separate deployment. |
| Data and effects | Simulated actions, designated real test resources, or a bounded real operating trial. A simulation does not prove provider behavior; a live trial does not activate the candidate globally. |
| Hosting | Existing app with candidate-scoped execution where supported, or a separately prepared Preview when required. Hosting alone does not determine effects. |

The Builder recommends the smallest supported combination and explains what it
does, where results appear, what can change and what remains untested. This model
is background reasoning, not a test menu or a mandatory two-question wizard.
Reuse company/process defaults; ask only about material missing decisions and
allow conversational corrections. Do not offer unavailable execution modes or
provision infrastructure for a static-only proposal.

Prioritize interactive Agent tests without Tools using the existing app and
test destination, exact candidate binding, separate conversation history and
explicit session completion. Simulation remains a later extension: execute the
candidate against specified examples and record intended business writes instead
of sending them. Model replies can remain real; report delivery is separately
scoped. Reuse existing executor, fixture/replay and business-time mechanisms.
General workflow dialogs, simulation, separate Preview provisioning and bounded
live trials are outside the first interactive increment. The specification linked
above defines this accepted direction and its availability limits.

Separate compute location, data access, and effects. A Preview may call a real
provider through an approved connection; that makes its effects real even with
an isolated internal database. Conversely, simulation may read authorized real
inputs without sending any effects. A true trial in production compute needs
an exact production candidate and scoped routing, not a relabeled Preview
artifact or an unreviewed edit to the global running Workspace.

### Preview configuration and access

Generate one dependency manifest from the exact candidate's compiled
capabilities and selected test plan. Resolve it through the existing Instance
connection/secret and setup adapters, with explicit logical substitutions for
test resources. Configuration and access resolution are Core work, not manual
steps delegated to the coding model or the employee.

| Dependency | Resolution |
|---|---|
| Core/Workspace artifact, environment, callback origin, test-session identity | Build or generate for this candidate and actual deployment; do not copy production artifact identity or URLs. |
| Database | Use isolated prepared state when required; production access is an explicit live-trial choice, not the default inherited `DATABASE_URL`. |
| Existing provider connection | Reuse the verified installation; attach it to the required environment or invoke it through the trusted Connector boundary with the test's allowed resource scope. |
| Model access | Use the selected authorized recipe/profile and budget through the existing credential resolver. |
| Provider-specific direct secret | Resolve only a required named SecretRef from its authorized source into the trusted runtime. Never export a production environment dump. |
| Timers, queues, callbacks, and automatic jobs | Enable only the test-session scope; keep unrelated copied production work inactive. |

With Vercel Connect, a connector handle in an environment variable is not proof
that the deployment may exchange it for a token. Verify the connection's project
and environment attachment and token resolution. Other providers may use OAuth,
app credentials, or a secret store behind their qualified adapter. Where a
provider cannot expose suitably scoped access in Preview, keep credentials at
the trusted Connector boundary or report that the selected test is unsupported;
do not silently substitute an unrestricted credential.

Validate configuration before building, then verify access from the actual
deployment identity before making the preview available. Check required secret
resolution without printing values, schema readiness, selected capability
grants, resource visibility, known write permissions, callback routing, and
effect limits. If a harmless write probe is needed to prove operation, use the
already authorized test operation and exact resource; a read result alone does
not establish write access. Report readable, actionable missing prerequisites.
Any new provider consent, access expansion, or unsupported resource needs the
appropriate administrator, but already authorized provisioning is automatic.

Version the non-secret resolved configuration, binding receipts, and readiness
result. Reuse unchanged setup; refresh affected evidence on credential rotation,
binding changes, or redeployment. Existing Vercel deployments do not gain new
environment values retroactively. Prevent cross-preview configuration races by
binding state, artifact, and secret references to the candidate deployment;
never repeatedly overwrite shared Preview variables such as `DATABASE_URL` for
concurrent candidates. Qualify deployment-scoped configuration or serialize the
affected provisioning slot until the adapter supports independent candidates.

The coding Sandbox remains separate: it receives the Workspace, approved
documentation and local tests, not business-provider or production secrets.
The checked preview runtime receives the capabilities and resolved access it
needs. Giving an Agent a Tool grant and provisioning the underlying connection
are both required and checked together.

### Existing apps and variable test destinations

Reuse the existing company app/installation by default. A test destination can
be a channel in the ordinary communication app, a test board in the ordinary
work-management account, a page or database in a document system, a meeting
resource, or another qualified provider resource. These are variable Instance
bindings. Slack, Monday, Microsoft Teams, Notion, and meeting systems are
examples, not mandatory dependencies or a claim that every adapter is already
implemented. Discover supported test operations from Connector capabilities.

Keep the existing provider webhook/ingress stable. Extend the current trusted
ingress with an explicit candidate-session dispatch record keyed by tenant,
provider account, and exact resource, plus thread/item/session where supported.
Ordinary traffic retains its normal routing. A matched test event is dispatched
once to the exact candidate through an authenticated internal envelope; replies,
buttons, callbacks, and cancellations use the same session identity. Do not
retarget the production app webhook, trust an arbitrary Preview URL, or let the
model choose a deployment. Preserve source identity, membership checks,
idempotency, and prompt acknowledgment at the ingress boundary.

The same app can send responses to the selected test destination through its
existing connection. Subscription/access may still need to be configured for a
new resource; an installed app does not automatically have access to every
channel or board. The Inspector reports that specific gap without requiring a
new app. A separate installation remains an optional company choice or a
provider limitation, never the normal Builder setup.

For the first release, lease one candidate at a time per shared live test
resource when the provider cannot distinguish sessions reliably. Qualified
thread/item/session routing can support concurrent candidates without requiring
a channel per change. Expired test callbacks are rejected or explained; they
must not fall through into normal production execution. The current standard
Agent Binding alone does not establish this routing; extending it is explicit
implementation work.

A test channel is an optional destination, not a complete environment boundary.
Keep test state and effect limits explicit even when app credentials are shared.
For live trials, reserve or partition the selected events so the production
workflow and candidate cannot both execute the same effect. An authorized live
trial adds no blanket permission for every live destination. Its completion or
expiry restores ordinary routing without losing or replaying consumed events.

An authenticated web test chat may be added later as another thin adapter to
the same conversation execution. It is not required before employees can
author, test through an existing app, and adopt supported changes.

## 8. Database changes

Distinguish three operations:

- **Company data or declared record mappings:** the Builder can propose supported
  Workspace definitions and test resulting behavior. Actual production data
  writes use the existing authorized capability/effect path.
- **Company-owned schema extensions:** not currently an unrestricted supported
  Builder capability. If required, add a versioned Core extension contract for
  owned namespaces, allowed migration operations, compatibility, fixtures,
  validation, and release execution. Prefer existing record contracts where
  they satisfy the requirement. Do not invent a direct SQL escape hatch in a Tool.
- **Core state schemas:** `companyos`, `companyos_knowledge`, and
  `companyos_records` are maintained by Core manifests. A Workspace Builder can
  request the missing capability and adopt a reviewed compatible release; it
  cannot patch Core infrastructure from its company checkout.

For supported migrations, freeze the migration with the candidate, provision a
temporary database through the trusted state adapter, apply it there, compare
the schema, run relevant data invariants and behavioral scenarios, and retain
redacted evidence. Coding agents may use local disposable synthetic databases;
hosted migration rehearsals receive only their scoped test resource through the
test executor, never project-admin credentials. A production migration is a
separate authorized release operation, not implied by permission to run a live
communication or work-item trial.

Use schema-only state with synthetic fixtures by default where supported, or a
fresh test database prepared from the pinned manifest. A production-derived
branch is still production data: require the company's existing data policy,
restricted access, controlled fixtures/masking, and removal or disabling of
copied queues, callbacks, timers, and production destinations before starting
the test runtime. Merely changing `DATABASE_URL` is insufficient.

At production adoption, apply the reviewed versioned migration to the current
production database after rechecking the starting schema and compatibility.
Never replace production with the preview branch or copy its test records back.
Production continues to receive writes while a candidate is tested. A schema
diff is inspection evidence, not automatically a safe migration script.

Prefer additive, backward-compatible migrations, with explicit preparation and
application rollout ordering. Test repeated migration execution, supported
upgrade paths, and recovery. An application rollback does not reverse a data
deletion; destructive or incompatible changes need an explicit migration and
recovery decision within the authorized scope.

## 9. Candidate identity, lifecycle, and concurrency

Record exact Core and Workspace commits, candidate digest, policy revision,
test configuration, migration identity, database starting manifest, test-session
identity, and execution profile. Every preview result and acceptance refers to
that candidate. Branch HEAD moving, edits during review, or a relevant production
schema change triggers refresh and revalidation rather than reuse of stale proof.

Build preview and production artifacts separately with their correct environment
identities; never relabel a preview artifact as production. Reuse the tested
source pair, and validate environment-specific bindings during release.

Share maintained base runtime images across jobs without capturing customer
files, credentials, or test records into reusable images. Keep coding and
trusted credential-bearing execution separate even if image packaging is later
consolidated. Package Workbench and Guides with the matching worker release.

Temporary resources have ownership, budget, expiry, cleanup receipts, and
failure recovery. Delete only resources created for that test, never a parent's
database or an adopted shared resource. Preserve redacted test and decision
evidence after resource cleanup. Do not keep a sandbox alive merely to retain
the conversation; use durable jobs, checked patches, and candidate revisions.

## 10. Delivery plan and smallest complete product

| Phase | Core deliverable | Acceptance evidence |
|---|---|---|
| A. Correctness | Fix working-tree inspection, plan classification, and contradictory review documentation. | Regression tests reject an unplanned tracked change and a forbidden mixed diff, while accepting a valid behavior change plus its plan. |
| B. Intent and authority | Workspace activation migration, readiness reporting, scoped acceptance policy, and trusted acceptance receipts. | Two synthetic companies use different policies on the same Core; legacy placeholders gain no execution bindings, handoff routes or wider read scope; requester mode cannot self-grant authority. |
| C. Guided authoring | Context-preserving chat, versioned brief and preparation Guide, pinned CLI/Guides, profile registry, bounded corrections, and readable result cards. | An explicit request reaches a checked result without another start dialog or repeated objective entry; Claude and Codex satisfy the same contract tests; selected profile has no silent fallback. |
| D. Complete simple adoption | Policy-aware human acceptance, Git enforcement, trusted merge/release execution for supported changes without migration, and production verification. | One authorized final action leads from the tested candidate to a recorded healthy production version without requiring the employee to use GitHub or Vercel; stale candidates and unauthorized actors are rejected. |
| E1. Next interactive increment | Multi-turn Agent tests without Tools in the existing app, exact candidate sessions and history, completion/expiry, fresh tests without unnecessary recoding, and one result card. | Follow-up questions stay on the candidate; concurrent ordinary work is unaffected; session completion and exact-result acceptance are evidenced without a second app or mandatory Preview. |
| E2. Deferred broader testing | Simulation adapters, full workflow dialogs, dependency-driven Preview provisioning, supported migration rehearsal and bounded live trials. | Qualify each requested execution scope separately; do not advertise unavailable modes. Simulation records business effects, connected tests constrain real resources, and Preview proves its actual access. |
| F. Private adoption and release | Adopt a qualified Core release through a separate Workspace/Instance change, initially using one Claude Code profile. Add E1 after the A-D path; defer E2 until needed. | Simple and process-change examples demonstrate request-to-healthy-release; connected tests demonstrate actual selected resource access without manual environment copying; no company-specific Core branches. |

Ship the smallest complete path A-D before expanding optional infrastructure.
Automatic standard checks are part of that path; optional Preview is not a
prerequisite for a supported simple change. A-C alone is an internal
proposal-only milestone, not the employee product. Existing bounded connected
tests remain available. E1 extends them with interactive Agent conversation;
E2 requires a separate implementation decision for broader test requirements.

Do not make a web test chat, second app, arbitrary company-owned schema
extension, new workflow engine, or multiple live coding profiles a first-release
gate. The contracts still support provider replacement, and unsupported test
capabilities must be explained honestly rather than silently skipped.

At adoption, serialize changes to the same production target, recheck branch
and policy state, and confirm that the release uses the candidate that was
actually accepted. If a merge changes candidate content, revalidate it and
renew acceptance where its material result changes. Apply the exact approved
source pair through existing release rules, rebuild environment-specific
artifacts, verify the active health/version, and report completion in the
original chat. A failed build or deployment never produces a successful live
status. Running processes retain their recorded version/migration semantics.

Evaluate simplicity with observable criteria: no technical setup questions for
already configured standard requests, no compulsory start confirmation after an
explicit build request, one final human action in requester mode, no manual
environment copying, no Git console work for the requester, and no Preview
resources for static-only changes. Record real completion latency and failures;
do not promise that model execution or deployment is instantaneous.

Each implementation phase needs its own bounded non-proposal Change Plan,
meaningful tests, and affected canonical documentation. Update Builder
governance, roles, Workspace/Instance architecture, Workbench Guides, schemas,
generator/validator migration, onboarding and readiness commands, compatibility,
and status together where the phase changes their contracts. If setup adapters
change, satisfy the maintained-live-setup documentation contract.

## 11. Decisions retained for private adoption

The generic product should offer these choices at setup and remember them:

- Eligible requesters, Steward or scoped requester acceptance, and any
  independence requirement.
- The selected coding profile, allowed alternatives, and bounded spend.
- Available test surfaces, exact destinations, test-data policy, and expiry.
- Whether a requester with delegated release authority may choose immediate
  production adoption or only prepare a release for another authorized actor.

No repeated choice is needed for each proposal unless the request exceeds that
recorded scope or materially changes its test strategy. Existing apps and
connections are the default. Synthetic data, designated test resources, and
authorized live trials are company-configurable options; this document creates
none of those resources or permissions.

## 12. Provider references

These references support provider mechanics; the architecture above is an
Oregano proposal, not behavior supplied automatically by those providers.

- [Vercel Sandbox](https://vercel.com/docs/sandbox): isolated execution for
  agents, commands, and development servers.
- [Vercel environments](https://vercel.com/docs/deployments/environments):
  separate deployment environments and Preview deployments.
- [Vercel environment variables](https://vercel.com/docs/environment-variables):
  environment-specific values apply to subsequent deployments.
- [Vercel Connect setup](https://vercel.com/kb/guide/vercel-connect):
  project and environment attachment of existing provider connections.
- [Neon branching workflow](https://neon.com/docs/get-started-with-neon/workflow-primer):
  isolated branches with schema/data options.
- [Neon schema diff](https://neon.com/docs/guides/schema-diff): inspection of
  schema differences between branches or points in time.
- [Neon preview workflow](https://neon.com/blog/branching-with-preview-environments):
  migrations applied to preview state and then the primary branch.
- [Slack Events API request URLs](https://docs.slack.dev/apis/events-api/using-http-request-urls/):
  one Events API request URL per app and server-side routing.


## 13. Implementation checkpoint: grounded intake and release foundation

The bounded implementation Change Plan is
`.oregano/changes/2026-09-08-builder-intake-and-release.yaml`.
It implements scoped discovery/read Tools, an exact source-bound brief,
unresolved-decision admission checks, same-request Builder handoff, no redundant
coding-start click, Workspace-presence activation, and the actual-diff fixes.
The fixed brief explicitly describes workflow, approval and access decisions;
existing definitions must be read, and rights changes require governance and
roster evidence. New file claims are checked against source existence.

The release foundation includes Workspace policy compilation, exact-candidate
acceptance, durable state contracts and an optional Postgres store, per-Instance
coordination, idempotent execution ports, production verification and a thin
optional Chat binding. No coding agent receives merge or deployment authority.

This checkpoint is not completion of phase D. Outstanding work is the real
trusted Git-host/runtime release adapter and hosted wiring, durable-store
integration qualification, complete pinned coding-worker CLI/Guide packaging,
and actual request-to-live qualification. Split-actor acceptance/deployment,
bounded correction loops, Preview dependency preparation, connected test
execution and shared-app test routing also remain unimplemented. Do not turn
local conformance evidence into a customer production-readiness claim.

## 14. Maintained executor checkpoint

The follow-on Change Plan is `.oregano/changes/2026-09-08-builder-live-execution.yaml`.
It implements the real maintained GitHub/Vercel ports, default Runner integration,
shared image with CLI and Guides, and qualified Postgres persistence/concurrency.
Source implementation and local conformance are distinct from target-Instance
qualification. Optional connected tests, Preview preparation, arbitrary migrations
and separate acceptance/deployment actors are not implied by the initial profile.
