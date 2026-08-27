---
document_id: specification.company-instance-release-promotion-v0.1
title: Company Instance Release and Promotion v0.1
kind: specification
status: draft
authority: normative
language: en
updated: 2026-08-26
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
the independent approval. Merge and deployment remain separate confirmations
in both modes.

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

### 4.2 Preview Lane

The Preview Lane applies when the change affects executable code, workflow
execution, a Core or dependency pin, runtime configuration shape, durable state,
schema, migration, retry behavior, ordering, idempotency, approval handling, or
another property that static review cannot establish.

Preview Lane evidence MUST run the exact proposed Core and Workspace pair in
an isolated environment. Stateful changes MUST use an isolated database or
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
Preview Instance.

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
MAY execute the merge. The Git host MUST perform it only after all protected
conditions are satisfied.

The merge initiator does not create missing approval by clicking merge. A
Platform Administrator MUST NOT use administrative bypass as the normal merge
path. The future Builder Agent remains proposal-only and MUST NOT merge its own
change.

The accepted revision becomes a Release Candidate. Production remains pinned
to its prior recorded revision until a separate deployment is authorized.

## 9. Deployment and production promotion

An operating Workspace MUST use a separately governed deployment path. A
Platform Administrator with `instance` scope authorizes the target Instance and
timing; a least-privilege deployment identity performs the technical action.
Neither a merge to the Company Workspace nor a push to Oregano Core MUST
automatically deploy a real company's Production Instance.

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

This document specifies mostly planned behavior. The current Workbench does not
yet implement general lane classification, hosted pull-request consequence
summaries, isolated Preview Instance provisioning, reusable Release Candidate
records, protected deployment environments, or promotion orchestration.

The experimental `companyos setup --profile vercel-neon-slack` command
implements one bounded initial-installation subset:

- exact clean Core and Workspace identity plus an immutable Artifact;
- a private GitHub repository, an automatic hosted-protection attempt recorded
  as `enforced` or `advisory`, a required CompanyOS check, and explicit
  Workspace Steward merge authorization for the authoring-to-operating change;
- explicit create-or-adopt choices for one Vercel project, Neon resource, and
  Slack connection;
- database preparation that detects first bootstrap, additive upgrade, or
  already-current verification for both maintained schemas, an immutable
  versioned manifest, and a non-secret read-only qualification receipt before
  runtime deployment;
- an explicit `vercel-ai-gateway`, `anthropic-direct`, `openai-direct`, or
  `google-direct` model execution recipe, with direct credentials confined to
  the runtime host secret store;
- separate hash-bound confirmations for the setup plan, operating Workspace
  content, checked merge, and exact production candidate;
- current deployment health plus one nonce-bound, model-backed Slack response,
  non-secret route/model response evidence, and Neon persistence proof; and
- a supervised Oregano Agent with no business Tool grants.

The Workbench implements this subset through a private typed setup-provider
boundary with four roles: source host, runtime host, state service, and
communication provider, plus a typed Runner model-execution selection. The
maintained profile currently binds those roles to GitHub, Vercel,
Neon/Postgres, and Slack and supports Gateway, native Anthropic/OpenAI/Google,
and named compatible cloud recipes. Generic OpenAI-compatible, LiteLLM,
Ollama, and llama-server recipes are available outside the bounded one-prompt
profile when their endpoints are explicitly reachable from the runtime.
This boundary is installation
orchestration only; it is not a public plugin contract and does not alter the
provider-neutral runtime, Capability, Tool, evidence, or StateStore contracts.
Provider creates require write-ahead intents and immutable receipts so resume
does not depend on eventually consistent name searches.

For this subset, StateStore provisioning and schema preparation are distinct
operations. A new Instance MUST create or explicitly adopt exactly one
PostgreSQL StateStore, bind its `DATABASE_URL` only through the selected
runtime host's secret environment, and successfully run the provider-neutral
database prepare operation before setup advances. Prepare MUST inspect the
catalog and immutable ledger, select `bootstrap` for an empty database,
`upgrade` for a supported predecessor, or read-only `verify` for the current
manifest, and fail closed for an unknown or conflicting state. Bootstrap MUST
remain the empty-database primitive. Preparation MUST cover both `companyos`
and `companyos_knowledge`, record the exact immutable manifest, be idempotent,
and fail closed if the same manifest version has different content. Setup state
MUST retain only the selected operation, previous manifest versions, provider
resource identity, and bounded non-secret qualification receipt.
Runtime health and completion verification MUST use read-only qualification,
MUST match the receipt's manifest digest, and MUST NOT perform schema DDL. The
maintained Vercel profile's `vercel env run` transport is one adapter binding,
not a requirement on a conforming alternative runtime host.

The current bounded subset targets additive manifest
`companyos-postgres@1.6.0`, which preserves predecessors `1.5.0`, `1.4.0`, `1.3.0`, `1.2.0`,
`1.1.0`, and `1.0.0`, qualifies 62 required Knowledge relations, and assigns unresolved
existing access-policy identities to quarantine. The successor adds durable
Source Events, provider ACL snapshots, pipeline receipts, completed watermarks,
synchronization leases, lifecycle requests, and an integrity-linked change stream. Deployment
qualification proves schema readiness only. Runtime authorization and
provider-ACL mapping conformance are separate release evidence and MUST pass
before a sensitive Source is enabled.

This subset records readiness as `validated`. It has no reusable Preview or
Effect Lane, no generic pre-production provider-test topology, no unattended
promotion, and no claim of `enforced` readiness. It is therefore suitable only
for the documented Tool-free supervised starter. Later behavior, integration,
scope, state, or effect changes remain subject to every applicable requirement
in this draft, including isolated pre-merge evidence where safely testable.
Hosted GitHub protection is defense in depth for this bounded starter rather
than a readiness gate. It becomes mandatory before a future unattended agent
receives repository write, merge, or deployment authority.

The general implementation Change Plan must still select:

- the machine-readable lane and release-evidence schemas;
- the final Company Instance deployment repository or Workspace-owned CI model;
- the Git-host review, merge-queue, and protected-environment integration;
- the reference Vercel, Neon/Postgres, and provider-test topology; and
- retention and cleanup policy for Preview Instance resources and evidence.
