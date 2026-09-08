---
document_id: specification.builder-governance
title: Builder Governance Specification
kind: specification
status: building
authority: normative
language: en
updated: 2026-09-08
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

After an authorized confirmation or cancellation succeeds, the Runner MUST
replace the original interactive confirmation message through its neutral Chat
adapter. A queued replacement MUST remove the confirmation actions and MAY
retain only the authenticated job-cancellation action; a cancelled replacement
MUST contain no actions. The pending confirmation MUST be consumed only after
that replacement succeeds, so a transient Chat-provider failure remains safely
retryable while durable job idempotency prevents duplicate execution.

For new jobs, the immutable input MUST retain the neutral Chat message identity
of the queued card. Terminal notification delivery MUST replace that card with
the final `published`, `failed`, or `cancelled` outcome and no actions. A legacy
job without a retained message identity MAY receive a fallback post in the same
source thread; fallback delivery is at-least-once when persistence fails after
the provider accepted the post.

When `builder.propose_change` successfully posts the confirmation card, that
card MUST be the sole visible Runner acknowledgement for the turn. The Runner
MUST NOT also post model-generated confirmation prose. It MUST retain a
deterministic internal conversation-history entry so subsequent turns know that
the card is awaiting the requester's explicit action. If card creation fails,
normal error or model communication MUST remain visible.

The Instance MAY bind one safe proposal target branch. The target MUST be
compiled into the Artifact, visible in the human confirmation, immutable in the
job, and verified with the exact base commit before publication. The model and
requester MUST NOT choose or alter it during a job. Without that binding, the
Repository Provider's verified default branch is the target.

## 2. Change matrix

| Change | Minimum class | Required authority |
|---|---|---|
| Handbook or non-behavioral operational content | content | assigned Process Steward |
| Existing SOP/Skill behavior | behavior | assigned Process Steward |
| Workflow steps, criteria, order, or schedule | behavior; security if authority/effect changes | Process Steward plus Workspace Steward where security applies |
| New workflow | security | Workspace Steward and responsible Process Steward |
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
2. **Repository boundary:** CODEOWNERS, protected branches, the declared review
   mode, no force push, and no Contributor bypass rights.
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

## 9. Implemented proposal-only profile

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

## 10. Grounded intake, activation and release foundation

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

This is a locally tested Core foundation. There is no maintained qualified
GitHub/Vercel release execution adapter or automatic hosted wiring yet. The
current default hosted worker still ends at a draft. Production readiness also
requires provider conformance, durable-store integration evidence, pinned
worker guidance, and the private Company's actual access/health proof.
Optional Preview provisioning, shared-app test routing and migration
qualification remain later capabilities; selecting them in a brief does not
execute them.

## 11. Remaining adoption work

- appoint Process Stewards and Workspace Stewards for each pilot Workspace;
- choose the isolated preview data and provider topology;
- implement and qualify the trusted provider merge/release execution binding;
- qualify durable release storage, hosted protection and actual production verification.
