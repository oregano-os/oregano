---
document_id: specification.builder-governance
title: Builder Governance Specification
kind: specification
status: building
authority: normative
language: en
updated: 2026-09-09
owners:
  - oregano-maintainers
audience:
  - human
  - agent
relations:
  depends_on:
    - specification.companyos-core-v0.7
    - architecture.security-governance
    - governance.roles
---

# Builder Governance Specification

The Builder Agent proposes Company Workspace changes from an authorized human
request. The proposal-only control path is implemented and tested; hosted
GitHub onboarding, brokered Claude Code and Codex, and the separate trusted Git
boundary have passed live Stage-0 qualification. One isolated
Slack-to-draft-proposal round trip, job-bound model accounting, and deliberate
ACP-process crash recovery have also passed their activation gates. This
specification distinguishes implemented invariants from activated profiles.

## 1. Scope and authority

The Builder lives under `agents/builder/` in the Company Workspace. It is a
company actor, not a Core developer. It MAY propose changes only inside that
Workspace and MUST NOT edit Oregano Core, Instance infrastructure, secrets,
runtime state, approval evidence, or hosted repository rules.

Any active roster member MAY submit a request. A request is not authority. The
Builder may create a branch, Change Plan, diff, and dry-run evidence, but the
governance class determines who reviews and approves it.

The old term “owner” is replaced by Workspace Steward for Workspace governance
and Process Steward for bounded process behavior. Legal ownership grants no
implicit technical right.

The Builder is selected like any other Company Agent: a deterministic
`AgentResolver` evaluates exact trusted Agent Bindings. Merely selecting the
Builder starts only a normal Runner conversation. A coding agent MUST NOT start
until the Builder has resolved the requested change and read the current
affected process definitions. `builder.propose_change` admits a versioned
source-grounded brief only after material questions are resolved. An explicit
unchanged-scope development request requires no additional start click.

Every admitted request MUST create one idempotent durable Builder job.
Duplicate delivery MUST NOT create a second execution or proposal. Jobs MUST
support leases, recovery, timeout, requester-authorized cancellation, terminal
evidence, and notification back to the source conversation.

Entering `published`, `failed`, or `cancelled` MUST create one durable pending
terminal notification. Notification delivery uses a lease independent from the
execution lease, records bounded delivery errors, and retries transient
Chat-provider failures with bounded backoff. Retrying a notification MUST NOT
make a terminal job executable again. Successful delivery MUST be persisted so
the notification is not reclaimed.

A newly admitted brief produces one queued acknowledgement and a durable job.
The Runner MUST retain deterministic conversation history identifying the
submitted job and MUST NOT ask for another start confirmation. Its terminal
result updates the retained request card in the original conversation; release readiness and
acceptance are separate from execution completion.

Legacy confirmation cards remain consumable during migration. Their handlers
MUST authenticate the original requester and conversation, remove consumed
actions, and preserve job idempotency across message-edit failures. Legacy jobs
with a retained card identity may replace that card; new jobs retain their posted card identity in the chat store and update it
through progress and result delivery. Delivery remains at-least-once if persistence fails
after the provider accepts a post.

The Instance MAY bind one safe proposal target branch. The target MUST be
compiled into the Artifact, retained in the brief/job evidence, and verified
with the exact base commit before publication. The model and requester MUST NOT
choose or alter it during a job. Without that binding, the Repository Provider's
verified default branch is the target.

## 2. Change matrix

| Change | Minimum class | Required authority |
|---|---|---|
| Handbook or non-behavioral operational content | content | configured requester or Steward acceptance |
| Existing SOP/Skill behavior | behavior | configured requester or Steward acceptance |
| Workflow steps, criteria, order, or schedule | behavior; security if authority/effect changes | Process Steward plus Workspace Steward where security applies |
| New workflow | declared class; security when authority/data expands | configured acceptance; Workspace Steward for security |
| Agent scope or instructions | behavior; security when authority/data expands | Process Steward or Workspace Steward by effect |
| Company Tool, grant, connection, roster, or policy | security | Workspace Steward; plus independent review only when Workspace policy requires it |
| Builder, governance, CODEOWNERS, CI, or protected paths | security | Workspace Steward under the declared review mode |
| Core/module upgrade | security and Instance release | Core release evidence, Workspace Steward, Platform Administrator |

A change inherits the highest class of every file and effect it touches. Diff
classification overrides a lower class claimed by the author.

## 3. Change loop

```text
verified request
  → Change Plan
  → branch and bounded diff
  → deterministic validation
  → isolated replay/dry-run where available
  → consequence summary and evidence
  → required Git-host check and human authorization
  → merge
  → exact-pair deployment
  → verification or compensation
```

The requester chooses deployment timing when policy permits. Existing runs do
not silently change definitions; the Instance records version pinning and
migration behavior.

## 4. Defense in depth

1. **Workbench boundary:** normalized paths, governance class, forbidden
   imports, scope, and Change Plan are checked after model output.
2. **Repository boundary:** the declared human review mode, exact confirmed
   content, no force push, and no Contributor bypass rights. Existing hosted
   protection remains enforced; unprotected branches use exact fast-forward.
3. **CI boundary:** the real diff is classified against the base revision;
   validation, inspection, tests, and documentation checks must pass.
4. **Runtime boundary:** unattended enforcement mounts only compiled write
   scopes and never grants the Builder production secrets or protected state.

The coding-agent process receives no Git-host, deployment, Slack, StateStore,
or production-provider credential. A trusted `RepositorySourceAdapter`
materializes one exact base revision and removes remotes and credentials before
execution. After execution, CompanyOS reads the actual diff independently.
Only a separately trusted `ProposalPublisher` may create the canonical branch,
commit, and draft pull request after all checks pass.

The coding boundary and trusted Git boundary MUST hash the same canonical patch
bytes. Both use intent-to-add followed by one binary global diff against the
exact base, preserving a single Git path order across tracked changes and new
files. A digest mismatch MUST fail closed before publication.

When the Runner host has no Git executable, the repository provider may use a
separate private trusted Git worker for complete source acquisition,
independent Workbench validation, the outer commit, and the bounded branch
push. Repository credentials are brokered only at that boundary. The coding
worker receives a credential-free bundle and cannot share a process or
filesystem with the trusted Git worker.

The first isolated worker uses a private five-method
`BuilderExecutionAdapter`; provider SDK types MUST NOT enter Builder jobs or
evidence contracts. Stable ACP v1 is the private protocol between that worker
and one exactly pinned Claude Code or Codex profile. ACP MUST NOT replace
normal Runner, Tool, approval, repository, or governance contracts.

Agent instructions are useful behavior guidance but are not a security
boundary. A claim written into a plan or approval file is not proof that the
required Git-host check or human merge confirmation occurred.

## 5. Workbench access by actor type

All Contributors and CI use the same Workbench contracts and validation engine;
only the interface differs:

| Actor | Required Workbench interface |
|---|---|
| Human Contributor | version-pinned `companyos` CLI |
| General Agent Contributor | version-pinned `companyos` CLI in its bounded development environment |
| CI | non-interactive CLI with explicit Workspace, base revision, and automatic Change Plan discovery |
| Builder Agent | typed, least-privilege Workbench Tools or SDK backed by the same implementation |

The Builder Agent's intended Tool surface is
`workbench.guide`, `workbench.create_change_plan`,
`workbench.validate_change_plan`, `workbench.inspect_diff`,
`workbench.validate_workspace`, and `workbench.security_preflight`. It MUST NOT
receive an unrestricted shell merely to invoke the CLI. A proposal-mode
prototype MAY invoke the CLI inside a restricted sandbox until the typed
interface exists, but that is transitional implementation, not a security
boundary.

The CLI and Builder Tool surface MUST NOT contain separate validation logic.
Both call the same versioned Workbench library so CI, Human Contributors, Agent
Contributors, and the Builder Agent cannot obtain different governance results.

## 6. Tool discovery

The Builder discovers capabilities only through the resolved catalog of the
exact Core revision. It does not infer Tool availability from model knowledge
or browse implementation code. Its read-only discovery operations list
available Tools, describe a Tool, list an agent's resolved grants, and preflight
a proposed grant.

For a requested capability it checks, in order: existing grants; installed
standard Tools; scopes and connections; approved module upgrades; a bounded
Company Tool; then a reported missing Core capability. It never writes a direct
provider integration as a workaround.

## 7. Pilot and graduation

The maintained hosted Builder remains proposal-only until its trusted release
binding is implemented and qualified. Qualification must prove actual scope,
current authority, exact candidate identity, retry behavior and production
verification; an arbitrary count of prior changes is not a substitute.
A separate Core Release Coordinator may merge and deploy after an authorized
human accepts the exact result. The coding process remains proposal-only.

## 8. Required evidence and tests

- prompt injection from company data cannot become a Builder instruction;
- path traversal, symlink, rename, and partial-apply attempts cannot reach
  protected paths;
- actual diff class cannot be understated by the plan;
- security approval follows the declared `steward` or `independent-review` mode;
- denied and failed proposals leave no partial branch effect;
- every successful fresh coding-agent session records job-bound model tokens
  and an explicit provider-cost status without inventing a price;
- an ACP-process crash is retained as a job-bound terminal failure and a
  replacement coordinator produces no diff or proposal from that execution;
- dry-run cannot reach production providers or state;
- merge/deploy uses the exact reviewed commit pair;
- rollback restores definition and separately tracks compensation for effects.

## 9. Historical Stage-0 proposal profile

The experimental implementation currently includes:

- exact Slack team/channel Agent Bindings with explicit default and
  fail-closed ambiguity behavior;
- persistent Postgres Builder jobs and leases;
- separately leased, retryable terminal notifications that resolve the queued
  Chat card without rerunning terminal execution;
- a Vercel Sandbox worker adapter plus an in-memory conformance adapter;
- exactly pinned ACP SDK, Claude Code ACP, and Codex ACP packages in the
  isolated worker;
- job-bound token usage and explicit reported-or-unavailable model-cost
  evidence for every successful coding-agent session;
- terminal worker receipts that let a replacement coordinator fail closed
  after an ACP-process crash;
- local Git and GitHub App repository provider implementations;
- a separate Vercel Sandbox trusted Git adapter that never runs a coding agent;
- independent protected-path and changed-path inspection;
- Workbench inspection, validation, and security checks; and
- trusted outer draft-proposal publication with no merge or deployment.

The hosted profile remains inactive in customer production. Its isolated
Instance Artifact, exact Builder Agent Binding, representative
Slack-to-draft-proposal run, two snapshots, model broker, service-owned GitHub
App onboarding, repository transfer, Workbench validation, job-bound model
accounting, deliberate ACP-process crash recovery, and idempotent draft
publication have passed their bounded Stage-0 live gates. Any customer pilot
activation still requires an explicit Instance decision and remains
proposal-only.

The live gate includes a mixed tracked-plus-new-file proposal. The coding and
trusted Git boundaries must hash the same globally ordered patch, and any
trusted Git or Workbench validation change requires a rebuilt and rebound
pinned snapshot before the gate is repeated.

## 10. Grounded intake, activation and release

A valid Workspace `agents/builder/instructions.md` declares desired Builder
availability. The Instance supplies repository and coding execution bindings;
`builder.enabled: true` is accepted only for compatibility and is no longer
required. Missing execution bindings must allow scoped discovery and
clarification while refusing coding submission. Removing the definition removes
the compiled Builder; stale execution bindings then fail the build. Inclusion
does not add handoff rules or divert the existing sole operating Agent's route.
Existing scoped content is not expanded automatically. New generator output
includes process, Agent, policy, schedule and connection definitions, plus the
governance and roster needed for approval questions.

The canonical intake procedure is [Prepare a Builder Change](../workbench/guides/prepare-builder-change.md).
Core verifies current scoped reads for all existing targets and context
references. Approval/access changes additionally require governance and roster
reads. Unknown questions, unresolved decisions, unavailable context and a
missing exact connected-test destination prevent admission. New-path claims
are checked against the full source existence inventory without exposing
out-of-scope file content. The employee reviews the finished result; source
hashes alone do not establish semantic correctness.

Actual-diff inspection includes uncommitted, staged, new, renamed and deleted
files. A validated v3 plan under `.companyos/changes/` is evidence metadata and
does not inherit security solely from the broad `.companyos/**` rule. Invalid,
deleted or legacy plans, and explicit narrower protection rules, retain their
normal classification. Core `.oregano/` plans are not exempted.

An optional `builder.release` policy in `.companyos/governance.yaml` declares
eligible named members/groups, requester or Steward acceptance by change
class, independence, and production deployers. Security acceptance preserves
Workspace Steward authority and the existing independent-review mode. Missing
policy grants no automated release authority. The Artifact freezes the policy;
release authorization must use the currently accepted policy and membership,
not candidate-proposed permissions. One combined action may cover acceptance
and deployment when the same human holds both authorities. A split-actor
acceptance/deployment handoff is not yet implemented by the coordinator.

The provider-neutral Release Coordinator and optional Chat binding implement
exact-candidate admission, per-Instance leases, deterministic operation IDs,
merge/build/migration/deploy/verify receipts, and verified live completion.
Pending operations resume with the same ID; a provider adapter must reconcile
ambiguous dispatch before retrying. Unknown errors stop the run without
claiming live success. The optional Postgres store reuses existing runs,
append-only events and lease tables, with no new DDL in the release path.
Application rollback excludes migrations and does not undo external effects.

The maintained Runner now composes the GitHub release connector and Vercel
production host when their Instance binding is present. Exact single-parent
candidate commits, the full changed-path inventory, trusted Workbench evidence,
producer-pinned hosted checks and an exact merge strategy bind the accepted
content. On unprotected branches, Core uses a non-forcing fast-forward to the
single-parent candidate; it does not request paid branch-protection APIs or
compute a merge containing concurrent changes. On protected branches it retains
the strict hosted-check and expected-head merge path without bypass. The class is the strictest classification under the
base and proposed governance; a proposal cannot lower its own review class.

Before any merge, the chat explicitly asks whether to merge the reviewed result
and make it live. Only the authenticated human confirmation admits the release;
showing the result, starting a coding job or requesting a readiness refresh does
not. The strategy is included in the evidence digest, so a changed strategy or
changed checks invalidates the pending confirmation. Workbench inspection,
validation and security evidence remain mandatory; all observed hosted checks
must also pass. Hosted protection is optional for this confirmed Builder path.
GitHub itself does not prevent manual unreviewed changes on an unprotected
branch; those changes cannot independently activate the production Instance.

Vercel staging reuses the exact current Core deployment and its production
environment, overriding the newly compiled Artifact and revalidated non-secret
Records/Workflow pairing references. Offline compilation
requires the exact normalized Instance digest from running Artifact provenance.
Staged health precedes domain promotion; live health must prove deployment ID,
Core/Workspace commits, Artifact and configuration. Ambiguous creation is retained
as a durable intent and reconciled through provider metadata without a blind retry.
Read-only recovery can recognize a deployment that changed its own acceptance
policy before the previous worker saved its receipt.

The Postgres implementation is qualified against an isolated database for restart,
concurrent acceptance, same-revision save races and expired leases. A separate
atomic revision pointer fences append-only snapshots; no runtime DDL is introduced.
The shared image packages both coding profiles, CLI and Guides for separate coding
and trusted executions. Actual per-Instance App rights, merge strategy, selected
profile and request-to-live proof remain mandatory deployment evidence.

The first automatic profile supports structural checks and human result review.
It stages and verifies the exact Knowledge Bundle without changing the old live
Handbook selection. A configured release Runner reads the snapshot pinned by its
Artifact. Changes to Knowledge access policy, Records sources, connections or
the Records identity roster require renewed Instance qualification.
General simulations, live trials, arbitrary migrations and optional Preview
preparation require further qualified adapters. The bounded connected profile
below has a maintained executor. Selecting a
strategy in the brief never claims it was executed. Split-actor acceptance and
release remain outside the combined-action implementation.

## 11. Remaining adoption work

- appoint Process Stewards and Workspace Stewards for each pilot Workspace;
- choose test evidence and resources only where the change requires them;
- qualify the maintained provider merge/release binding in the target Instance;
- verify the selected merge strategy, correct model/image bindings and actual production adoption.


## Operational state path enforcement

The shared proposal inspector rejects the root `state/` path (including case
variants) before Workbench checks can accept a Builder diff. It inspects the
whole base-to-worktree change, not only working-tree status: worker commits,
staged/unstaged edits, additions, removals and both sides of renames are covered.
A committed forbidden change cannot hide behind an unrelated dirty file.

The real CompanyOSWorkbenchProposalValidator has negative fixtures for every
form above. This establishes a proposal-file boundary, not access to a
production database and not a claim that an unactivated hosted profile has
already received this code. Runtime state and audit retention stay under the
Instance's separate authority. Existing trusted Git profiles must use the
updated inspector and pass their qualification gate before activation.


## Connected functional tests before merge

The connected profile introduced in Core 0.8.0 supports
`test.strategy: test-resources` with one explicit execution:

- `kind: agent`, `agentId`, `prompt`: one actual reply from a compiled read-only
  Agent using the existing model recipe. This does not test conversational Tools
  or Agent handoffs. Add `interaction: interactive` for the bounded multi-turn
  profile described below; omission preserves the single-answer behavior.
- `kind: workflow`, `workflowId`, `fields`: an actual operator-opened graph through
  CompanyOSRuntime and WorkflowEngine. The initial qualified profile excludes
  messages, timers and intermediate human decisions; its bounded work-item
  effects use the maintained Connector and ordinary effect claims.

The Instance's optional `builder.test_resources` selects existing capability
bindings and exact input constraints. A work-item test must constrain both its
logical resource binding and item. One selected communication binding receives
an identifiable test thread in the existing app. The Builder reads current
capabilities and test resources before coding; unavailable bindings or unsupported
capabilities stop admission. Configured access is not proof of current provider
availability; the executor performs the provider's actual qualification.

The trusted compiler builds the published candidate commit, with the running
Core and normalized Instance configuration. It verifies and retains the exact
Artifact and Knowledge Bundle without changing the live selection. The coding
worker neither runs connected tests nor receives provider credentials.

A durable session binds the job, brief, base, candidate, Core, checks, scope,
Artifact, conversation and result. A connected-test preference alone cannot
create a release candidate. Workflow execution uses the maintained stores under
a separate storage namespace; production workers, assignments, timers and
workflow dispatch fences cannot consume that state. Artifact identity is retained.
Unknown publication or execution outcomes stop rather than repeating effects.

The result is delivered with a provider permalink. **Request changes** immediately
invalidates its live action; the next authenticated requester message becomes
feedback. Builder reads that feedback and original brief, then rebuilds the
complete requested result against the current source. The new session retains
its predecessor and must run its own tests. Test resources and company policy
cannot be expanded by candidate-authored instructions.

One **Go live** action accepts the exact completed test and starts
release when the current human has both company authorities. It atomically
freezes the test result before release admission. Changed or concurrently
invalidated results fail closed; another human cannot overwrite acceptance.
The release candidate includes the test digest, which the maintained adapter
checks before inspection and merge. Staged production health and final live
health remain separate technical checks after the user's functional acceptance.
They do not establish arbitrary end-to-end business correctness.

`auto` retains technical checks and explicit human result acceptance without a
connected test. Adding a test resource does not create another app or copy
secrets into Preview. New provider access still follows the existing Instance
setup/qualification boundary. Each pilot must retain real model/provider, human
feedback, merge and deployment receipts before claiming its complete live proof.

## Accepted Builder experience and test direction (2026-09-09)

The guided progress, unified result card and interactive Agent profile in this
section are implemented in this change. Deployment requires adopting the updated
Core; existing running Instances do not change merely because this specification
changed. Simulation and the broader profiles below remain deferred. Requirements
apply to every company and coding profile; destinations and policy stay configurable.
The maintained action-card labels are English; free-form Builder conversation
continues to use the Company Workspace language.

### Build requests and progress

Use **Build request** for both new development and changes to existing behavior;
ordinary conversation can say "your request". **Build brief** names the resolved
instructions passed to the coding agent. These are the maintained English action-card labels; the Builder explains the
request in the Company Workspace language.

Initially acknowledge that the request is being passed to the coding agent and
promise an update when development starts. "The coding agent is working on your
request" requires job-bound evidence that the agent has begun processing the
brief; queuing a job or creating a sandbox is insufficient. Reuse worker progress
evidence and durable delivery, not a chat model's assertion. Keep cancellation
available while pending or running; distinguish requesting it from confirmed stopping.

Maintain one understandable progress presentation through preparation, coding,
checks and testing. Show the objective, current step and next action. Keep
repository identifiers, full commits and job IDs in technical details.

Return one result card in the original Builder conversation: a plain-language
summary, the actual test and its limits, a result link, **Request changes**, and
**Go live** when authorized and ready. Do not post separate test and proposal
cards. Explain that Go live accepts the exact reviewed result and starts
publication; report progress until deployed verification proves it is live.
If readiness or authority is missing, explain the next step on the same result
instead of presenting a working Go live action.

"Make it live only after my approval" means offer publication after later
acceptance, not prepare-only. Preparing a draft without offering publication
remains distinct. Starting development never accepts the result.

### Agent-recommended testing

The Builder recommends the smallest supported test that answers the human's
question, using Workspace defaults and verified Instance capabilities. Before
coding, explain what will run, where the result appears, which data or actions
are affected, what the human should inspect and what the test does not cover:

> I suggest asking the new version one example question and posting its answer
> in the configured test channel. You can review the wording there. This test
> does not support follow-up conversation with that version.

The human can adjust this recommendation in conversation. Do not require a test
menu, two-question wizard, technical strategy name or repeated confirmation when
the request and defaults resolve the choice. Ask only about material missing
decisions. Explain unsupported requests before promising a test.

Core reasons about independent dimensions in the background:

| Dimension | Meaning |
|---|---|
| Interaction | Automatically execute specified examples, or let the human interact with the candidate. |
| Data and effects | Simulated inputs/actions, designated real test resources, or an explicitly scoped trial on real operating resources. |
| Environment | Reuse the existing app and isolated candidate session where supported; provision a separate Preview only when needed. |

These are not four competing test types. Interactive tests can use simulated
actions or real test resources. Preview describes hosting, not a test method or
proof of isolation. A bounded live trial performs real effects on selected
operating resources without global candidate activation. It requires actual
scope and authority; a preference grants neither. This conceptual model does
not migrate current machine fields or make unimplemented executors available.

Distinguish execution success, business correctness and human acceptance. A
generated answer alone does not prove all content criteria. Publishing a test
report is a real, separately scoped delivery.

### Interactive Agent testing without Tools

The interactive Agent profile extends `test.execution` with optional
`interaction: interactive`; omitted or `automatic` retains the single-answer test. Reuse the existing app,
configured test destination and compiled candidate. Bind the test conversation
to one exact candidate, retaining its own multi-turn history for follow-up
questions. Keep it separate from the company's active Agent and other work.
Sessions admit at most twenty completed replies and expire after 24 hours while
open. Expiry is enforced on use; completed review evidence is retained. Only the
requester may send questions, finish, restart or request revisions. A supported
Workspace-only change needs no second app or mandatory Preview. Mention the app
in the test thread where the Instance's ingress policy requires mentions.

Changing only test questions or inputs should allow a fresh test of the same
unchanged candidate without recoding. Retain fresh evidence and prevent old
acceptance from authorizing a different result. Full workflow dialogs with
Tools, messages, timers and intermediate decisions are outside this increment.

### Deferred: simulation

Simulation is specified for later work, not the next implementation. It executes
the candidate with defined example data and scenarios. Selected business writes
are recorded as intended actions instead of being sent to external systems. The
report shows executed steps, intended actions, errors and unsupported parts.
Reuse the applicable Core executor and existing test/replay mechanisms; do not
create a second workflow engine or present an invented narrative as execution.

Simulation may be automatic or interactive. Model replies may be real while
selected data and external actions are simulated. Report delivery is separately
scoped. Simulation does not prove provider access, actual external writes or
end-to-end production behavior. General simulation, separate Preview provisioning
and bounded live-trial execution remain later capabilities, not currently
available Builder options.
