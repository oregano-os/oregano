---
document_id: specification.company-instance-release-promotion-v0.1
title: Company Instance Release and Promotion v0.1
kind: specification
status: draft
authority: normative
language: en
updated: 2026-09-09
owners:
  - oregano-maintainers
  - product-owner
audience:
  - human
  - agent
availability: planned
relations:
  depends_on:
    - specification.companyos-core-v0.7
    - architecture.company-instance
    - architecture.security-governance
    - governance.roles
    - specification.identity-access-offboarding
---

# Company Instance Release and Promotion v0.1

The reviewed non-secret Instance build declaration MUST be versioned at
`.companyos/instance.yaml` in the responsible Company Workspace.
Its exact bindings and SecretRefs are permitted company Git content; resolved
credentials and operational evidence are not. Setup MUST include the declaration
before its initial commit. CLI and hosted builds MUST consume that tracked file
from the exact clean Workspace checkout. External YAML overrides and transport
copies are not supported. Hosted compilation checks the running Artifact
configuration digest before building. The format is defined in the
[Instance configuration contract](../reference/instance-configuration.md).
Reviewing or merging this file does not independently authorize deployment.

This draft defines how a Company Workspace change moves from a bounded proposal
to a reviewed source revision and, when applicable, to a running Company
Instance. It applies to Human Contributors, Agent Contributors, the future
Builder Agent, and externally implemented deployment automation.

The contract is provider-neutral. GitHub, Vercel, and Neon/Postgres are the
maintained reference stack, not architectural requirements. Approval of this
draft would authorize the remaining general implementation planning; the draft
does not itself create a hosted ruleset, Preview Instance, provider
installation, deployment workflow, or production release. The experimental
supervised starter described in Section 14 is a deliberately narrower path and
must not be presented as implementation of this complete contract.

Normative requirements use stable `CIRP-*` identifiers.

The maintained hosted Builder implementation gates scheduled production work on
the exact deployment currently served by the configured primary production
domain. A production-target build without domain promotion is insufficient
authority to advance workers. Staged and superseded deployments must remain
inactive for scheduled company effects, even when the provider invokes their
cron routes. Unavailable live identity fails closed. Fixed-fixture qualification
remains a separately authenticated operation and cannot authorize company work.

## 1. Outcomes and non-goals

**CIRP-OUT-001 — Test before merge.** A change MUST receive the validation,
review, and isolated execution evidence required by its actual behavior before
it may merge. Production MUST NOT be used as the first test environment for a
change that can be tested safely before merge.

**CIRP-OUT-002 — Merge is not activation.** Merge records an accepted source
revision. It MUST NOT by itself grant production authority, change a running
Instance, migrate live state, or enable a new external effect.

**CIRP-OUT-003 — Exact promotion.** Deployment and promotion MUST identify the
exact reviewed Core revision, Workspace revision, runtime artifact, Instance,
environment, and applicable configuration and ToolSet evidence.

**CIRP-OUT-004 — Risk-based topology.** CompanyOS MUST NOT require a permanent
staging environment for every Workspace change. It MUST require the smallest
isolated test surface that can provide credible evidence for the changed code,
state, integration, or effect.

This specification does not define a fleet orchestrator, a generic deployment
command, a mandatory cloud provider, or permission for the Builder Agent to
merge or deploy.

## 2. Terms

A **Preview Instance** is a non-production Company Instance that runs an exact
Core and Workspace pair with explicitly isolated environment configuration.
It may be created for one pull request and destroyed when the pull request
closes, or it may be longer lived.

A **Staging Instance** is a longer-lived Preview Instance used when persistent
webhooks, schedules, provider installations, queues, or multi-step observation
make an ephemeral pull-request environment impractical. Staging is an optional
topology, not a universal release stage.

A **Production Instance** is the named Company Instance allowed to consume
production configuration, state, provider bindings, and effects.

A **Release Candidate** is an accepted, immutable Core and Workspace revision
pair, plus its build and review evidence, that may be evaluated for deployment.
It is not a running environment and carries no production authority.

**Promotion** is the explicit authorization to deploy a Release Candidate to a
named environment or to advance an already deployed workflow from a more
restricted rollout state to a less restricted one.

**Shadow operation** is a production rollout state in which a candidate may
observe approved production inputs but its external effects are suppressed and
recorded in an evidence sink. Shadow operation is not a third workflow
`execution_mode`; the canonical workflow modes remain `supervised` and
`unattended`.

## 3. Roles and authority

CompanyOS uses three company authority roles for this flow:

| Role | Authority in this flow |
|---|---|
| Workspace Steward | Approves company-wide authority, governance, Agents, Tools, grants, connections, policies, and protected Workspace changes. |
| Process Steward | Approves the business behavior and acceptance criteria of an assigned workflow or SOP. |
| Platform Administrator | Administers technical hosting through separately assignable `repository` and `instance` scopes. |

The Platform Administrator `repository` scope covers Git-host access,
CODEOWNERS, rulesets, and hosted merge protection. The `instance` scope covers
runtime hosting, state, provider installations, secrets, deployment,
observability, backup, and recovery. One person MAY hold both scopes; a company
MAY assign them to different people without changing this contract.

A CompanyOS Contributor proposes or implements a change but receives no
approval, merge, or deployment authority merely by contributing. A GitHub code
owner is a review-routing principal, not a CompanyOS authority role. A Core
Maintainer approves generic Oregano Core releases but cannot decide a company's
Workspace policy or production timing.

One human MAY hold several roles, but every recorded action MUST identify the
role and scope being exercised. In `review_mode: steward`, one Workspace
Steward MAY authorize a checked security change and later authorize deployment.
In `review_mode: independent-review`, a security-change author MUST NOT provide
the independent approval. Acceptance, merge and deployment retain separate authority checks. A single
explicit result-acceptance action MAY authorize the exact merge and deployment
when the same human holds both authorities and sees the candidate and target.
The fresh-only initialization exception below has no prior operating version to merge.

## 4. Change lanes

The actual diff and consequences determine the required lane. A proposal
inherits the highest lane required by any affected file, runtime dependency,
state change, grant, connection, or effect.

### 4.1 Authoring Lane

The Authoring Lane applies when deterministic validation and human review can
fully evaluate the change without executing a Company Instance. Typical
examples include non-behavioral handbook content and definitions in an
`authoring-only` Workspace.

Authoring Lane evidence MUST include the applicable Workbench checks, actual
diff classification, required CODEOWNERS routing, and human review. It requires
neither durable-state branching nor a Preview Instance merely to duplicate the
repository branch.

### 4.2 Isolated execution lane

The isolated execution lane applies when the change affects executable code, workflow
execution, a Core or dependency pin, runtime configuration shape, durable state,
schema, migration, retry behavior, ordering, idempotency, approval handling, or
another property that static review cannot establish.

Execution evidence MUST exercise the relevant exact proposed Core and Workspace
pair in an isolated environment. A local fixture or coding Sandbox can satisfy
the applicable check; a hosted Preview is required only when the behavior needs
a separately running application, callback, state or provider integration.
Do not provision a Preview for every behavior change. Stateful changes MUST use an isolated database or
equivalent StateStore branch. Database isolation alone is insufficient when
the changed behavior also depends on runtime processes, queues, webhooks,
secrets, or provider adapters.

### 4.3 Effect Lane

The Effect Lane applies when a change can send a message, mutate an external
provider, register or receive a production-relevant webhook, run a schedule,
expand a grant or Connector scope, or otherwise create a material effect beyond
the isolated Instance.

Effect Lane evidence MUST use an approved test installation, test resource,
mock Connector, or effect sink. It MUST prove scope enforcement, duplicate
suppression, failure and retry behavior, and receipt verification where the
effect contract requires read-after-write. Production credentials and
production write targets MUST NOT be exposed to an ordinary pull-request
Preview Instance. Existing company apps may provide scoped test channels,
boards or equivalent resources through the trusted test executor; no second
app is mandatory. A deliberately selected live trial requires separately
recorded exact effect scope under existing company authority. A preference in
a build brief does not grant that authority or prove execution.

## 5. Pull-request assessment and notification

**CIRP-PR-001 — Actual-diff classification.** CI MUST classify the actual diff
against the protected base revision. A Contributor's declared class or lane
MUST NOT lower the resulting requirement.

**CIRP-PR-002 — Visible consequence report.** The pull request MUST expose the
following in human-readable evidence. Automation SHOULD expose the same fields
in machine-readable evidence when that integration is implemented:

- the change class and required lane;
- affected workflows, Agents, Tools, grants, state, and connections;
- required checks and Preview Instance evidence;
- the required Steward authority and CODEOWNERS routing;
- production impact and rollout restrictions; and
- missing evidence that blocks merge.

**CIRP-PR-003 — Routed humans.** The Git host MUST request review from the
principals mapped to the required Process or Workspace Steward authority.
CODEOWNERS provides routing and merge protection but MUST NOT be treated as the
source of CompanyOS authority.

**CIRP-PR-004 — No documentation-only notification contract.** A requirement
that needs human action MUST be surfaced through the Workbench, pull-request
status, Git-host review request, deployment approval, or an equally auditable
mechanism. CompanyOS MUST NOT depend solely on a person remembering prose in a
specification.

Automated pull-request summaries and notifications are planned capabilities.
Until implemented, the Change Plan, CI results, CODEOWNERS, and manual review
checklist carry the same required information.

## 6. Pre-merge execution and evidence

A Preview Instance MAY use a temporary Git-host preview, an isolated StateStore
branch, and test provider resources. The maintained reference path is a Vercel
Preview Deployment connected to an isolated Neon/Postgres branch. Sensitive
production records SHOULD be replaced with fixtures, sanitized data, or a
schema-only branch unless an approved data decision permits their isolated use.

The pull request MUST identify the tested Core and Workspace revisions and the
environment bindings used for evidence. If the final merge result differs
materially from the tested pull-request revision, CI MUST retest the merge
candidate or the resulting Release Candidate before production deployment.

Preview resources SHOULD be removed when the pull request closes unless they
are retained under an explicit evidence, investigation, or staging policy.
Deleting a preview never deletes production state or effect evidence.

## 7. Review and approval

**CIRP-APR-001 — Minimal interruption.** An explicit task request or confirmed
plan authorizes unchanged-scope Authoring and Preview preparation. Read-only
inspection, local editing, validation, retry and resume, branch publication,
and pull-request preparation MUST NOT create additional conversational approval
gates. They do not grant merge, release, deployment, or Effect authority.

An Agent Contributor MUST pause only for human authentication or provider
consent; a new or increased permission, cost, external resource, or secret
placement outside the confirmed plan; protected merge or release; production
deployment, migration, externally visible effect, or destructive action; or a
material unresolved scope decision. Currently available Workbench confirmation
artifacts SHOULD be presented as one batch. Batching MUST NOT let the Agent
invent an approval, bypass an enforced confirmation, or extend an approval to a
different target or scope.

At minimum:

| Change | Required authority |
|---|---|
| Non-behavioral process content | assigned Process Steward |
| Existing workflow or SOP behavior | assigned Process Steward |
| New workflow | responsible Process Steward and Workspace Steward |
| Agent authority, Tool, grant, connection, roster, policy, governance, or protected CI | Workspace Steward under the declared review mode |
| Core adoption by a company | Core release evidence and Workspace Steward |
| Instance deployment or migration | Platform Administrator with `instance` scope after Workspace approval |

In `independent-review` mode, one authorized review MAY satisfy both the
Git-host approval and required CompanyOS authority when the reviewer genuinely
holds that authority. Merely administering GitHub, Vercel, Neon, or another
provider does not grant business approval.

## 8. Merge execution

Merge is a mechanical repository action after required checks and approvals.
CompanyOS defines no separate Merger authority role. A Human Contributor MAY
enable hosted auto-merge or an authorized human with ordinary merge permission
MAY execute the merge. Existing hosted protection MUST remain enforced. The
confirmed Builder path also supports repositories without hosted protection.

The merge initiator does not create missing approval by clicking merge. A
Platform Administrator MUST NOT use administrative bypass as the normal merge
path. The Builder coding process remains proposal-only and MUST NOT merge its own
change. A separate trusted Core Release Coordinator may perform the mechanical
merge under verified human acceptance. Before it starts, Chat MUST explicitly
ask permission to merge the exact checked result; the combined action also
names production adoption. Confirmation is bound to the candidate, checks,
current company authority and merge strategy. On an unprotected branch, the
maintained adapter MUST use a non-forcing fast-forward to the exact single-parent
candidate. It MUST NOT synthesize a merge with concurrent unreviewed changes.
Moved divergent bases require refreshed validation and confirmation. A successful
fast-forward may have the candidate commit itself as its merge receipt.
On protected branches the maintained adapter keeps the strict hosted-check and
expected-head merge path. Provider errors MUST NOT silently select another path.

This Core-controlled release protects what the Builder merges and deploys; it
does not prevent administrators making manual changes to an unprotected Git
branch. Such pushes MUST NOT independently activate a production Instance.

The accepted revision becomes a Release Candidate. Production remains pinned
to its prior recorded revision until deployment is authorized. That
authorization may be part of the combined exact-result acceptance described
above; merging by itself never grants it.

## 9. Deployment and production promotion

An operating Workspace MUST use a separately governed deployment path. A
Platform Administrator with `instance` scope authorizes the target Instance and
timing; a least-privilege deployment identity performs the technical action.
Neither a merge to the Company Workspace nor a push to Oregano Core MUST
automatically deploy a real company's Production Instance.

A configured Workspace `builder.release` policy MAY delegate content and
behavior acceptance to eligible requesters. Existing protected security
changes retain Workspace Steward and independent-review requirements. Evaluate
such changes using the current accepted policy, never proposed new permissions.
The same human's combined acceptance and deployment action is valid only when
that human is also an eligible production deployer.

Before deployment, the path MUST verify:

- the exact Core repository and revision;
- the exact Workspace repository and revision;
- the reviewed governance and compatibility evidence;
- the target Instance and environment;
- required secrets, provider bindings, scopes, and StateStore migrations;
- backup, rollback, or forward-recovery evidence where state can change; and
- health and readiness criteria for the candidate.

Production deployment SHOULD reuse the immutable reviewed artifact. If the
artifact must be rebuilt, the build MUST use locked inputs and prove equivalent
provenance rather than silently resolving newer dependencies.

## 10. Rollout states

The smallest safe rollout sequence is selected by lane and effect risk:

```text
pull-request validation
  → isolated Preview Instance when required
  → reviewed merge and Release Candidate
  → production shadow operation when real inputs are required
  → supervised production
  → unattended production only when separately eligible
```

Not every change requires every state. Authoring-only content has no Instance
rollout. A pure deterministic Tool may require tests but no provider staging.
A provider-writing workflow normally requires Effect Lane evidence and a
restricted production rollout.

Shadow operation MUST deny or redirect external effects while retaining the
candidate's decision and intended-effect evidence. Supervised rollout MUST keep
an accountable operator able to observe, stop, and recover the workflow.
Unattended promotion MUST additionally satisfy the workflow execution-mode,
effect-risk, approval, ToolSet enforcement, evidence, and recovery contracts.

## 11. Verification, rollback, and compensation

Deployment success MUST include observable health and readiness checks for the
exact target Instance. A failed check MUST stop further promotion and preserve
enough evidence to diagnose the failure.

Source rollback selects a previously reviewed Core and Workspace pair.
Deployment rollback selects a previously recorded immutable artifact. State
rollback is a separate operation and MUST NOT be implied by either source or
deployment rollback. Effects that have already escaped the Instance require
explicit compensation where compensation is possible.

## 12. Reference implementation and replacement boundary

The maintained reference workflow MAY create one isolated Neon/Postgres branch
and one Vercel Preview Deployment per qualifying pull request. External effects
use dedicated Slack channels, Monday boards, provider test installations, mock
Connectors, or a durable effect sink. A stable Staging Instance is introduced
only when persistent callbacks, schedules, provider installations, queues, or
observation windows justify it.

An alternative Git host, runtime host, StateStore, or provider test topology is
conforming when it preserves exact identity, isolation, least privilege,
review, evidence, health, rollback, and promotion authority.

## 13. Required acceptance evidence

Implementation of this contract requires tests proving at least:

- Authoring Lane changes do not provision unnecessary runtime resources;
- Preview and Effect Lane changes cannot reach production state or write targets;
- actual-diff classification cannot be understated by the Contributor;
- missing required Steward review blocks merge;
- the merge initiator cannot substitute for an approval;
- merge does not change the running Production Instance;
- deployment consumes the exact reviewed revision pair and target environment;
- Platform Administrator `repository` and `instance` scopes can be assigned to one or different humans;
- the Builder and deployment identities cannot approve their own changes;
- failed health checks prevent further promotion; and
- rollback distinguishes source, artifact, state, and escaped effects.

## 14. Implementation status and open decisions

::: implementation-example

The maintained initial Builder release profile is implemented behind Workspace
acceptance/deployer policy and exact Company Instance bindings. After explicit
human confirmation, GitHub advances to the independently checked candidate using
an exact fast-forward or the existing protected merge path. A separate trusted compiler builds
the exact merged Workspace with the running Core and normalized Instance digest.
Vercel stages a production-target build using the existing production environment,
checks readiness before promotion, and verifies the live deployment and Artifact.
Before staging, the full Artifact is retained and read back by exact hash in the
existing Instance Artifact store. The deployment carries that hash and clears
its legacy inline payload. The Runner awaits verified initialization before
requests; missing or corrupt content cannot select another version. This path
requires an already prepared database and adds no schema or second runtime.
The coding worker receives none of this execution authority or its credentials.

See the [maintained host profile](../operations/maintained-host-profile.md).

:::

::: implementation-example

Postgres stores immutable acceptance and append-only release snapshots, with a
leased Instance queue and atomic revision pointer. Private operation intents retain
ambiguous creates for provider reconciliation. Local tests exercise actual database
restart and concurrency, provider receipt loss, stale checks and distinct staging
and promotion. Target provider scopes, the selected merge strategy, worker image and a real
human request-to-live proof must be qualified independently before an Instance is
called ready.

See the [maintained host profile](../operations/maintained-host-profile.md).

:::

The combined action currently requires one human to hold both acceptance and
release authority. Connected test execution, optional Preview preparation,
arbitrary migration adapters and split-actor handoff remain future extensions.
A failed deployment must retain its exact evidence; application recovery does not
undo database changes or already completed business effects.

### Standard fresh initialization

The standard `companyos setup` command implements the fresh-only exception:
one reviewed decision authorizes the listed new resources and their first
production deployment. Schema `5` and flow `fresh-initialization` bind session,
authenticated human, selected scopes, exact release/template/configuration,
model, region, names and disclosed costs. All resource modes MUST be `create`.
Changed scope MUST NOT reuse the decision. Provider consent remains separate.

::: implementation-example

The initializer MUST produce one valid operating `0.1.0` Workspace, a private
repository with an exact checked first commit, attempted hosted protection,
resource ownership receipts, qualified database and exact Artifact. It MUST NOT
fabricate an activation PR, merge commit or approval record. The verifier uses
this evidence variant only for fresh initialization; existing states, adoption
and later changes retain their applicable review and deployment requirements.
The maintained Slack identity adapter MUST use the `identity.basic` identity
contract and the current CLI requester. The app Messages link MUST bind the
recorded connector and consenting human workspace using authenticated provider
metadata. Metadata MUST NOT substitute for runtime exchange evidence, expose
provider credentials, or require production connector access from a local
development identity. Provider CLI filesystem effects MUST remain outside
the immutable Core; temporary contexts MUST be removed on failure as well as
success. A standard fresh setup MUST inspect the exact production deployment,
select only a provider-reported production alias, and require current health to
match the deployment ID and complete Artifact provenance. It MUST NOT disable
deployment protection or generate bypass credentials merely to check health.
The maintained Slack connector MUST be created with incoming triggers enabled.
Before requesting the first message and during final verification, setup MUST
check current source forwarding, the exact production webhook destination,
and a production-only project attachment. A destination receipt alone MUST NOT
be treated as evidence that incoming forwarding is enabled. Explicit event
selections MUST include `message.im`. A repeated missing first reply MUST expose
exact-app delivery recovery instead of only repeating the message invitation.
Recovery MUST distinguish Vercel synchronization, Slack Request URL verification,
and actual message delivery. It MUST preserve approved scopes when the provider
UI adds event-dependent permissions; a URL challenge MUST NOT count as reply
evidence. The maintained setup guide defines the bounded recovery procedure.

See the [maintained host profile](../operations/maintained-host-profile.md).

:::

::: implementation-example

The first ordinary Slack exchange MUST bind the authorized principal, current
Artifact, selected model, delivered response and durable conversation evidence.

See the [maintained host profile](../operations/maintained-host-profile.md).

:::

The standard implementation is experimental. Its release-built platform payloads
and local/simulated regression tests do not establish cold live timing.

::: implementation-example

The maintained `companyos setup` lifecycle requires schema-5 fresh initialization,
exact resource-create receipts, the checked initial commit containing
`.companyos/instance.yaml`, one explicit model choice and the scoped initial
deployment decision. Current health and an authorized model-backed Slack
exchange MUST be verified before completion. The retired `--profile` flow and
state versions 1–4 MUST be rejected before provider operations. Historical
receipts MUST NOT be relabeled to manufacture current initialization authority.

See the [maintained host profile](../operations/maintained-host-profile.md).

:::

::: implementation-example

The Workbench implements this subset through a private typed setup-provider
boundary with four roles: source host, runtime host, state service, and
communication provider, plus a typed Runner model-execution selection. The
maintained profile currently binds those roles to GitHub, Vercel,
Neon/Postgres, and Slack and supports Gateway, native Anthropic/OpenAI/Google,
and named compatible cloud recipes. Generic OpenAI-compatible, LiteLLM,
Ollama, and llama-server recipes are available outside the bounded one-prompt
profile when their endpoints are explicitly reachable from the runtime.
Fresh standard setup MUST require an explicit provider selection. Its ordinary
choices MUST be OpenAI and Anthropic, without preselection; each MUST use its
direct recipe and maintained agent model. Another supported model or route MUST
require an explicit request. Gateway MUST NOT be an automatic setup default.
The single resource/cost review MUST bind route, exact model and credential
destination. Provider edits MUST invalidate that review; confirmed sessions
MUST retain their original binding. Reuse the existing Sensitive Production key
entry and model-backed verification. This does not migrate existing sessions.

See the [maintained host profile](../operations/maintained-host-profile.md).

:::

This boundary is installation
orchestration only; it is not a public plugin contract and does not alter the
provider-neutral runtime, Capability, Tool, evidence, or StateStore contracts.
Provider creates require write-ahead intents and immutable receipts so resume
does not depend on eventually consistent name searches.

For this subset, StateStore provisioning and schema preparation are distinct
operations. Fresh setup MUST create exactly one
PostgreSQL StateStore, bind its `DATABASE_URL` only through the selected
runtime host's secret environment, and successfully run the provider-neutral
database prepare operation before setup advances. Prepare MUST inspect the
catalog and immutable ledger, select `bootstrap` for an empty database,
`upgrade` for a supported predecessor, or read-only `verify` for the current
manifest, and fail closed for an unknown or conflicting state. Bootstrap MUST
remain the empty-database primitive. Preparation MUST cover `companyos`
and `companyos_records`, record the exact immutable manifest, be idempotent,
and fail closed if the same manifest version has different content. Setup state
MUST retain only the selected operation, previous manifest versions, provider
resource identity, and bounded non-secret qualification receipt.
Runtime health and completion verification MUST use read-only qualification,
MUST match the receipt's manifest digest, and MUST NOT perform schema DDL. The
maintained Vercel profile's `vercel env run` transport is one adapter binding,
not a requirement on a conforming alternative runtime host.

::: implementation-example

The current manifest is `companyos-postgres@3.0.0`. It qualifies 15 control/Workflow
and 14 Company Records/Sprint tables, and recognizes the immutable identities
of supported `1.0.0` through `2.0.0` predecessors. Qualification receipt version
2 covers only `companyos` and `companyos_records`. General identity,
authorization, approvals, Records, Sprint and model routing remain in Core.
Preparation preserves existing data; it neither creates nor deletes a Knowledge
schema. Existing Instances use the separately targeted
[retirement procedure](../workbench/guides/retire-knowledge.md), then rebuild
the Artifact and refresh their qualification evidence.

See the [maintained implementation](../workbench/guides/retire-knowledge.md).

:::

Runtime authorization and provider qualification for retained Record Sources
remain separate release evidence. Database readiness alone MUST NOT authorize
sensitive source activation or an effect.

This subset records readiness as `validated`. It has no reusable Preview or
Effect Lane, no generic pre-production provider-test topology, no unattended
promotion, and no claim of `enforced` readiness. It is therefore suitable only
for the documented Tool-free supervised starter. Later behavior, integration,
scope, state, or effect changes remain subject to every applicable requirement
in this draft, including isolated pre-merge evidence where safely testable.
Hosted GitHub protection is defense in depth for this bounded starter rather
than a readiness gate. It becomes mandatory before a future unattended agent
receives repository write, merge, or deployment authority.

## Explicit unpublished installer candidates

::: implementation-example

A fresh standard setup MAY acquire a local unpublished bundle when explicitly
selected. Acquisition MUST verify the platform, archive SHA-256 and exact Core
commit and MUST retain that identity on resume. Candidate identity MUST be part
of the reviewed scope and generated initialization receipt. Its initial GitHub
check MUST use the same exact source with frozen dependencies without requiring
a release tag. Candidate checks do not relax identity, initial-commit validation,
resource-creation, deployment or Slack evidence requirements. Candidate timing
MUST be labeled separately and MUST NOT qualify the stable release installer.
A candidate session MUST create its own deterministic test connector and bind
that name into its reviewed scope, provider receipt, trigger, deployment and
verification. It MUST NOT reuse the ordinary Oregano connector in the same team.

See the [maintained host profile](../operations/maintained-host-profile.md).

:::
