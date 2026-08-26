---
document_id: guide.operate-builder
title: Operate the Builder
kind: guide
status: building
authority: canonical
language: en
updated: 2026-08-26
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
3. Review the confirmation card's repository and exact base commit.
4. Select **Start proposal**. This is the first point at which a job exists.
5. Use **Request cancellation** when required. The request is authenticated
   against the original requester and is applied by the asynchronous worker.
6. Wait for the terminal message in the same source thread.
7. Review the draft proposal, Change Plan, diff, Workbench evidence, and CI.
8. Apply the normal human merge and deployment governance.

The coding process cannot commit, push, merge, or deploy. CompanyOS creates the
canonical outer commit and draft proposal only after independent validation.

## Diagnose and recover

The durable job ledger records `queued`, `preparing_source`, `executing`,
`validating`, `publishing`, and terminal `published`, `failed`, or `cancelled`
states. Workers claim bounded leases; a replacement coordinator recovers the
same named execution from its opaque handle. Duplicate request IDs with
different immutable input fail closed.

For a failed job, inspect only redacted terminal reason, provider receipts,
exact profile versions, source digest, observed diff digest, and Workbench
check digests. Never copy a provider credential into logs or a retry request.
Retry by creating a new confirmed request at an exact current base unless the
existing idempotent job is still recoverable.

## Current qualification status

Unit and local integration coverage proves routing, confirmation gating, job
leases, cancellation, local repository conformance, GitHub App token
separation, protected-path rejection, ACP protocol behavior, independent diff
inspection, and trusted outer publication. Basic live Vercel Sandbox lifecycle,
duplicate recovery, timeout, and credential-transform mechanics are also
proved.

The digest-pinned worker snapshot, both brokered model profiles, and the
service-owned GitHub App source and draft-publication path passed live
qualification on 2026-08-26. The protected model runs used the same snapshot,
verified the expected diff outside ACP, and kept the real general Instance
model keys outside the coding processes. The separate trusted Git snapshot and
the deployed onboarding handler then passed source transfer, durable binding
reuse, independent Workbench validation, outer commit, stacked draft
publication, and repeat-call idempotency against one selected private
Workspace. The coding workspace contained no repository credential or remote.
The maintained hosted profile remains inactive until one representative
Slack-to-draft-proposal round trip succeeds from an isolated Artifact with an
exact Builder Agent Binding and without merge or deployment.

Representative model-backed cost and ACP-process-crash recovery remain
production-readiness measurements.
