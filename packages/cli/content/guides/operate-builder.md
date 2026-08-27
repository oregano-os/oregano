---
document_id: guide.operate-builder
title: Operate the Builder
kind: guide
status: building
authority: canonical
language: en
updated: 2026-08-27
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
relations:
  depends_on:
    - specification.builder-governance
    - architecture.company-instance
    - guide.review-change
---

# Operate the Builder

Use this guide to configure, qualify, observe, cancel, and review the
proposal-only Builder. The current implementation is experimental until all
target-environment gates below pass.

## Configure Agent and provider bindings

Keep Company Agent routing separate from coding execution. A representative
non-secret Instance declaration is:

```yaml
version: 1
instance_id: acme-production
environment: production
bindings: []
agent_bindings:
  - id: slack-builder
    agent: builder
    surface: slack
    account_id: T012345
    channel_id: C012345
default_agent: oregano
builder:
  enabled: true
  execution:
    adapter: vercel-sandbox
    profile: isolated-v1
  coding_agent:
    protocol: acp-v1
    profile: claude-code
  repository:
    repository_id: acme/company-workspace
    source_binding: github-company-workspace
    proposal_publisher_binding: github-company-workspace
    target_branch: reviewed/company-workspace
```

The same execution adapter can host `claude-code` or `codex`. A future
qualified worker host can replace `vercel-sandbox` without changing Agent
routing, ACP, repository, or Builder job semantics.

`target_branch` is optional. Omit it to propose against the repository's
verified default branch. When a pilot Artifact is built from an exact reviewed
but not-yet-default Workspace revision, bind that revision's branch explicitly;
the target is copied into the immutable job, shown in the confirmation card,
and independently verified by the proposal publisher.

## Configure secrets and repository installation

Store general model credentials only in the Instance secret store:

- `ANTHROPIC_API_KEY` for the Claude Code profile;
- `OPENAI_API_KEY` for the Codex profile.

The hosted GitHub provider additionally requires one service-environment App
identity, private key, webhook secret, and authenticated onboarding callback.
Create that App once per service environment. Customers install the same App
and select repositories. Do not ask a customer to create an App, paste a
long-lived token, or put repository credentials in Workspace configuration.

The Instance stores only the verified installation ID, selected repository ID,
status, environment, and provider receipt. Suspension, uninstall, permission
loss, or selected-repository removal must make source and publication
operations fail closed.

## Qualify before activation

Run:

```bash
pnpm builder:check
node --experimental-strip-types packages/runner-vercel/src/lib/builder/qualify-sandbox.ts
node --experimental-strip-types packages/runner-vercel/src/lib/builder/qualify-sandbox-timeout.ts
node --experimental-strip-types packages/runner-vercel/src/lib/builder/qualify-brokered-acp.ts claude-code
node --experimental-strip-types packages/runner-vercel/src/lib/builder/qualify-brokered-acp.ts codex
```

Then create the digest-pinned worker snapshot:

```bash
node --experimental-strip-types packages/runner-vercel/src/lib/builder/create-worker-snapshot.ts
```

Store its returned non-secret snapshot ID as
`COMPANYOS_BUILDER_WORKER_SNAPSHOT_ID` in the Instance environment. A profile is
supported only when the exact ACP and execution-adapter combination passes.
Never silently fall back from ACP, Claude Code, or Codex to another runtime.

The hosted GitHub provider also needs a separate snapshot that contains Git and
the pinned Workbench but never runs a coding agent:

```bash
node --experimental-strip-types packages/runner-vercel/src/lib/builder/create-trusted-git-snapshot.ts
```

Store that non-secret ID as
`COMPANYOS_BUILDER_TRUSTED_GIT_SNAPSHOT_ID`. The trusted Git worker performs
full source acquisition before closing network access, emits a bounded
credential-free Git bundle, validates the returned diff independently, and
creates the one outer commit. Real installation tokens exist only in
host-scoped network-header transforms and never in either process environment.
Recreate and rebind this snapshot whenever trusted Git or Workbench validation
code changes; deploying the Runner alone does not update the pinned snapshot.

Qualify a selected private repository with the exact repository identity,
numeric provider repository and installation IDs, exact base commit, App ID,
service environment, and one private-key source:

```bash
node --experimental-strip-types packages/runner-vercel/src/lib/builder/qualify-private-repository.ts
```

The harness performs a credential-free exact-base materialization. Set
`COMPANYOS_GITHUB_QUALIFICATION_BRANCH` to a fresh
`companyos/builder/...` branch only when the operator also authorizes the live
publication check. That check may create one unmerged draft proposal containing
only the bounded qualification document and must return the same proposal when
repeated.

When model keys are intentionally non-readable outside Vercel, create a staged
Production build without assigning any Production domain:

```bash
vercel --prod --skip-domain
```

Before invoking `/api/builder/qualification`, prove that an unauthenticated
request to the generated deployment URL is denied. Invoke the protected URL
through `vercel curl` once for `claude-code` and once for `codex`. The endpoint
accepts no prompt or repository input, runs one fixed fixture through the
pinned worker snapshot, and is unavailable through the Production alias. Delete
the staged deployment after retaining its non-secret evidence.

Every successful fixed profile run must retain token totals and categories from
its fresh ACP session. It must also retain either a provider-reported estimated
cost with currency or the explicit status `unavailable`; do not infer a model
price when the profile does not identify and report one. The Claude ACP profile
currently reports estimated USD cost. The current Codex ACP profile reports
tokens but not cost.

Run the same protected endpoint once with the fixed
`acp-crash-recovery` gate. It waits for job-bound prompt-start evidence, sends
`SIGKILL` only to that recorded ACP process, and requires a newly instantiated
coordinator to recover the persisted execution handle as `failed`. Passing
evidence must contain no checked diff and must prove Sandbox disposal. Never
resume a half-executed coding turn; retry requires a new human-confirmed job.

The same endpoint accepts the exact fixed `trusted-git` gate only when its
bounded repository, installation, base-commit, proposal-branch, and optional
stacked target-branch settings are present. It calls the same authenticated
onboarding handler as self-service, rereads the persisted binding, and must
return the same draft proposal on repetition. Remove the temporary
qualification settings, staged deployment, and automation bypass immediately
after evidence capture. Keep both reusable snapshot IDs and the normal
non-qualification provider bindings.

## Operate a proposal

1. Address the Builder through its bound channel.
2. Clarify the exact objective in the normal Runner conversation.
3. Review the confirmation card's repository and exact base commit. Once this
   card is posted, it is the sole visible acknowledgement; the Runner does not
   add a second model-authored restatement below it.
4. Select **Start proposal**. This is the first point at which a job exists.
   The same card changes to **CompanyOS Builder proposal queued** and no longer
   offers **Start proposal** or the confirmation **Cancel** action. If the
   original confirmation remains actionable, do not click it again; retain the
   job identifier and diagnose the Chat-provider message update.
5. Use **Request cancellation** on the queued card when required. The request
   is authenticated against the original requester and is applied by the
   asynchronous worker.
6. Wait for the queued card to change to **ready for review**, **failed
   closed**, or **cancelled**. New jobs resolve that same card; a legacy job
   without a retained message identity receives a fallback message in the same
   source thread.
7. Review the draft proposal, Change Plan, diff, Workbench evidence, and CI.
8. Apply the normal human merge and deployment governance.

The coding process cannot commit, push, merge, or deploy. CompanyOS creates the
canonical outer commit and draft proposal only after independent validation.

## Diagnose and recover

The durable job ledger records `queued`, `preparing_source`, `executing`,
`validating`, `publishing`, and terminal `published`, `failed`, or `cancelled`
states. Workers claim bounded leases; a replacement coordinator recovers the
same named execution from its opaque handle. A completed detached worker
flushes one job-bound structured result and exits explicitly. A failed ACP run
flushes a bounded terminal failure receipt so a replacement coordinator does
not depend on a provider SDK's stale detached-command status. Coordinator output
polling is bounded, and a missing persisted worker marker fails closed instead
of leaving the job in `executing`. Duplicate request IDs with different
immutable input fail closed.

Terminal notification delivery is durable and separately leased from job
execution. A transient Chat-provider error records a bounded reason and next
attempt time, then retries with bounded exponential backoff. It never reopens
or reruns a terminal coding job. A notification marked `delivered` is not
claimed again. If a job is terminal but its card has not changed, inspect the
notification state, attempt count, next-attempt time, and redacted last error
in the job ledger; do not retry the coding execution to repair presentation.

For a failed job, inspect only redacted terminal reason, provider receipts,
exact profile versions, source digest, observed diff digest, and Workbench
check digests. Never copy a provider credential into logs or a retry request.
Retry by creating a new confirmed request at an exact current base unless the
existing idempotent job is still recoverable.

For a bounded manual smoke test, target a file that exists at the displayed
exact base and allow the governance artifacts required for the actual diff. A
valid prompt is:

> Create a Builder draft proposal that appends the clearly marked line
> `Builder terminal-card smoke test: 2026-08-27` to `company.md`. Create or
> update only the Workspace Change Plan and documentation required for this
> actual diff. Do not change any other operating content. Do not merge or
> deploy. Start the coding agent only after my explicit confirmation.

Do not combine “change only one file” with a request that also requires a
Change Plan: those instructions conflict and the Builder must fail closed.

When coding and trusted Git workers report different diff digests, do not
publish. Both boundaries must hash the same canonical byte sequence, including
adjacent new-file patches and one global path order for mixed tracked changes
and new files. Both sides use intent-to-add followed by the same binary global
diff against the exact base. Treat any remaining mismatch as a failed job and
retain both redacted digests for diagnosis.

## Current qualification status

Unit and local integration coverage proves routing, confirmation gating, job
leases, cancellation, local repository conformance, GitHub App token
separation, protected-path rejection, ACP protocol behavior, independent diff
inspection, and trusted outer publication. Basic live Vercel Sandbox lifecycle,
duplicate recovery, timeout, and credential-transform mechanics are also
proved.

The current worker snapshot is `snap_XhgH5ozYTOR5L5GTI3e8ST1G3hvy`; the
current trusted Git snapshot is `snap_ELocj6iQRrgRzFnOJPeGNcAs7H8k`. Both
brokered model profiles and the service-owned GitHub App source and
draft-publication path passed live qualification. The protected model runs
kept the real general Instance model keys outside the coding processes. The
separate trusted Git worker and deployed onboarding handler passed source
transfer, durable binding reuse, independent Workbench validation, outer
commit, stacked draft publication, and repeat-call idempotency against one
selected private Workspace. The coding workspace contained no repository
credential or remote.

On 2026-08-27, the isolated qualification Instance completed the remaining
Slack-to-draft gate through the normal Runner, an exact Builder Agent Binding,
explicit confirmation, Claude ACP, independent validation, and checked draft
`fylingpete/oregano-hq-companyos#6`, with no merge or deployment. The job took
298.240 seconds end to end. Its one-vCPU, 2 GB coding Sandbox ran for 264.182
seconds, used 8.401 active CPU seconds, and incurred approximately USD 0.00374
of listed provider compute, memory, network, and creation usage before included
quotas and excluding Claude model cost.

On the final worker snapshot, a fixed Claude job recorded 110,033 total tokens
(10 input, 455 output, 103,466 cached read, and 6,102 cached write) plus an
ACP-reported estimated model cost of USD 0.1019435. This is model evidence from
the direct Anthropic-backed run, separate from Vercel Sandbox resource cost. A
second fixed job injected `SIGKILL` after prompt-start evidence; a replacement
coordinator recovered `failed`, emitted no diff, and disposed the Sandbox.

The hosted profile remains inactive in customer production. Provider-billing
reconciliation and a supervised history of 10–20 representative proposals
remain production-readiness measurements.
