---
document_id: guide.operate-builder
title: Operate the Builder
kind: guide
status: building
authority: canonical
language: en
updated: 2026-09-08
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
Builder and its separately trusted release path. The implementation remains experimental until all
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
the target is copied into the immutable job, retained in the resolved request,
and independently verified by the proposal publisher.

## Clarify the process before coding

Follow [Prepare a Builder Change](prepare-builder-change.md). The Workspace
Builder definition declares desired availability. It compiles for conversation
without an Instance coding binding; actual job submission still needs that
binding. Keep existing read scopes deliberate. To discuss process changes,
include the relevant `workflows/**`, `agents/**`, `schedules/**` and connection
definitions; governance and roster must be available for rights changes.

The Builder reads the existing process, resolves ambiguous targets, asks only
material unanswered questions and prepares a versioned before/after brief.
The resolved request starts isolated coding without a redundant start click.
The current human message continues through an authorized Builder handoff;
private history and Tool grants do not transfer. Existing normal chat routing
is preserved when the sole operating Agent gains a Builder alongside it.

## Configure result acceptance

The Core accepts this optional policy in `.companyos/governance.yaml`. Member
and group ids must resolve to the roster. The names below are synthetic;
choose each company's existing membership and actual deployment delegation.

```yaml
builder:
  release:
    version: 1
    acceptance:
      content:
        mode: requester
        eligible: { members: [], groups: [employees] }
        independent: false
      behavior:
        mode: requester
        eligible: { members: [], groups: [process-editors] }
        independent: false
      security:
        mode: steward
        eligible: { members: [workspace-steward], groups: [] }
        independent: false
    deployers: { members: [workspace-steward], groups: [process-editors] }
```

`workspace-steward` must be a roster member assigned Workspace Steward
responsibility. With `review_mode: independent-review`, security's
`independent` must be true. Do not change review mode to grant ordinary member
self-acceptance. Eligibility applies to the actual change class. Production
release also requires membership in `deployers`; writing the policy does not
install a provider executor or give anyone repository credentials.

The maintained Runner wires **Accept and make live** when both company policy
and the trusted Instance release binding are present. A human who holds both
acceptance and deployment authority needs one action. Otherwise a checked draft
remains available; split-actor acceptance/deployment is not yet implemented.
A request, live-trial preference or Preview choice never grants release authority.

The initial automatic release profile supports `test.strategy: auto`: independent
Workbench validation, protected CI, human result acceptance, staged production
health and final live verification. These checks do not claim functional simulation
or provider test effects. A selected simulation, connected test, live trial or
migration needs its own qualified evidence adapter and remains outside this
initial automatic profile.

## Bind trusted production release

Keep these values in the Company Instance, never in the Workspace:

- `COMPANYOS_BUILDER_INSTANCE_YAML_BASE64`: base64 of the exact non-secret Instance
  YAML used to build the running Artifact. Its normalized configuration digest
  must equal the Artifact provenance; no credentials may be embedded.
- `COMPANYOS_BUILDER_RELEASE_BINDING_BASE64`: base64 JSON containing `projectId`,
  `teamId` and the existing `productionUrl` for the maintained Vercel host.
- `COMPANYOS_VERCEL_RELEASE_TOKEN`: the service credential for that deployment
  project. It is not supplied to the coding process.
- The existing automation bypass secret, if deployment protection requires it
  for the staged health probe. Do not disable protection or create bypass access
  implicitly during a probe.

The GitHub App requires Contents and Pull requests write, plus Checks and
Administration read for release inspection. Customers select the exact repository.
The target branch must enforce strict up-to-date required checks pinned to their
producer App, no force pushes/deletions/bypass, and enforcement for administrators.
Existing review requirements still apply. A provider plan that cannot enforce
these controls blocks automatic release; it does not justify a public repository
or a bypass. The default branch is `main` for this release binding; explicitly
bind another target when the company's verified default differs.

The trusted host reuses the exact current Core deployment as the build source.
It compiles the merged Workspace in a separate offline sandbox, builds with the
existing production environment and only overrides the compiled Artifact, then
checks staged health before promoting. It creates no Preview app and copies no
production secrets into Preview. Domain promotion and a second exact live health
probe complete the release. Preserve the final Artifact in Instance deployment
configuration when an operator performs a later manual deployment; a Workspace
merge alone never publishes it.

Create operations retain a durable intent before dispatch. After an ambiguous
provider response, reconcile the same operation's deployment metadata; never
create another deployment merely because a receipt was lost. Inspect unresolved
intents operationally. A failed release is not proof that production is unchanged.

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

Create one qualified image from a clean, committed Core checkout:

```bash
node --experimental-strip-types packages/runner-vercel/src/lib/builder/create-worker-snapshot.ts
```

Store the returned ID as `COMPANYOS_BUILDER_SNAPSHOT_ID`. The image contains
both pinned ACP profiles, Git, the exact Core and Workbench, and matching Guides.
The setup checks each binary version and the Workbench fixture. Qualify the
selected coding profile against its actual model broker before admitting jobs.
The legacy two snapshot environment names remain readable during migration;
new setup needs only the common ID. The older trusted-Git image command also
builds this same image recipe.

Coding and trusted operations always run in separate sandbox executions. Coding
can run local commands and read Core references, with no production credentials.
Independent validation and artifact compilation run in fresh trusted sandboxes
with network access closed. Source/publisher credentials remain host-scoped
broker transforms. Rebuild and rebind the image when its Core code changes;
upgrading the Runner alone does not update an existing image.

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
resume a half-executed coding turn; retry requires a new resolved job.

The same endpoint accepts the exact fixed `trusted-git` gate only when its
bounded repository, installation, base-commit, proposal-branch, and optional
stacked target-branch settings are present. It calls the same authenticated
onboarding handler as self-service, rereads the persisted binding, and must
return the same draft proposal on repetition. Remove the temporary
qualification settings, staged deployment, and automation bypass immediately
after evidence capture. Keep the reusable snapshot identity and the normal
non-qualification provider bindings.

## Operate a change

1. Ask the normal company Agent to change a process, or open a configured Builder
   conversation. An allowlisted handoff carries the same human request.
2. The Builder reads current definitions and asks only material unanswered
   questions. It retains a brief covering the exact target, before/after,
   acceptance criteria, rights and test strategy.
3. A clear, resolved implementation request queues isolated development
   immediately. Use the queued card to stop the job if necessary.
4. The trusted worker independently checks the diff and Workbench result, then
   publishes the exact outer proposal. Coding-agent claims are not evidence.
5. With the qualified release binding and passed checks, the authorized human
   accepts the result using **Accept and make live**. The coordinator merges,
   builds, checks, promotes and verifies the exact pairing.
6. The terminal card says live only after the production deployment and health
   match. Otherwise it remains a draft, pending or stopped result with evidence.

Legacy start-confirmation cards remain readable during migration. Once consumed,
those cards must remove their old actions; new resolved briefs need no extra start
click. A replayed action never creates a different job or release.

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
Retry by creating a new resolved request at an exact current base unless the
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

Local tests cover grounded intake, both coding profile contracts, exact-candidate
policy, protected provider inspection, ambiguous merge/deploy reconciliation,
separate staging and promotion, and actual Postgres persistence, concurrent saves
and expired leases. The initial Stage-0 Slack-to-draft tests predate this release
path and do not qualify its new image or production executor.

Each Company Instance still needs its selected App installation and scopes, hosted
branch protection, model/worker qualification, staged production health access,
and a bounded request-to-live proof. Record those private receipts with exact Core,
Workspace, image, Artifact and deployment identities. Local tests never substitute
for these provider and human acceptance steps.


## Release configuration and knowledge continuity

Core 0.6.0 introduces Workspace-declared Builder availability and the optional
`builder.release` company policy. Workbench 0.1.0-experimental.16 distributes the
matching intake and operations Guides. Remove a legacy `builder.enabled: false`
binding; omit execution bindings to keep conversation-only authoring available.
Previously explicit `enabled: true` bindings remain readable during migration.

The trusted compiler builds both the Artifact and its exact Knowledge Bundle.
The release stages and verifies an immutable Knowledge snapshot; the configured
Runner selects the snapshot named by its Artifact. Staging cannot switch the
old production deployment's Handbook. Initial adoption must also stage and
verify the current Artifact's bundle before configuring live release. A changed
Knowledge access policy needs separate Instance qualification in this profile.

Existing Records and hosted Workflow settings are revalidated and rebound to
the exact new Workspace/Artifact while retaining qualified resources, enabled
workflow IDs, schedules and operators. No credentials are copied. Changes to
record sources, connections or the Records identity roster require renewed
qualification; they remain reviewable proposals until that evidence is supplied.
The live profile currently supports `auto` tests. Connected trials, new provider
resources, data migrations and split acceptance/deployment actors require a
separately qualified execution path and must not be presented as automatic.

If CI or Instance readiness is still pending, the chat delivers the built draft
and a **Check readiness** action. This action only refreshes evidence; it never
approves or releases the result. A ready result presents **Accept and make live**.

Manual deployments must carry the current exact Artifact and rebound non-secret
configurations forward. The Builder stores them durably with its release; it
does not silently overwrite project-level environment variables. Production
verification also compares Vercel's actual Git source commit with Core provenance.
