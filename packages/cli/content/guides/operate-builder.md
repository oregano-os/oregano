---
document_id: guide.operate-builder
title: Operate the Builder
kind: guide
status: building
authority: canonical
language: en
updated: 2026-09-10
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
non-secret declaration stored at `.companyos/instance.yaml` in the Company
Workspace is shown below. It is protected by `.companyos/**` security review.
See [the configuration reference](../../reference/instance-configuration.md)
for discovery and the boundary between source and deployment copies:

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

The maintained Runner wires **Go Live** when both company policy
and the trusted Instance release binding are present. A human who holds both
acceptance and deployment authority needs one action. Otherwise a checked draft
remains available; split-actor acceptance/deployment is not yet implemented.
A request, live-trial preference or Preview choice never grants release authority.

The initial automatic release profile supports `test.strategy: auto`: independent
Workbench validation, protected CI, human result acceptance, staged production
health and final live verification. These checks do not claim functional simulation
or provider test effects. A general simulation, live trial or migration needs its own qualified evidence
adapter. The connected profile below supplies its own exact test evidence.

## Bind trusted production release

The compiler reads `.companyos/instance.yaml` from the exact checked Workspace
commit and compares it with the running Artifact configuration digest. No YAML
copy is supplied through the environment. Keep these host values in the Company
Instance:

- `COMPANYOS_BUILDER_RELEASE_BINDING_BASE64`: base64 JSON containing `projectId`,
  `teamId` and the existing `productionUrl` for the maintained Vercel host.
- `COMPANYOS_VERCEL_RELEASE_TOKEN`: the service credential for that deployment
  project. It is not supplied to the coding process.
- The existing automation bypass secret, if deployment protection requires it
  for the staged health probe. Do not disable protection or create bypass access
  implicitly during a probe.

The GitHub App requires Contents and Pull requests write, plus Checks and
Administration read for release inspection. Customers select the exact repository.
Existing branch protection remains enforced. An unprotected private target uses
Core's exact non-forcing fast-forward and human-confirmed merge path; it requires
no paid hosting plan. The default target is `main`; explicitly bind a different
verified company target where applicable. Company repository pushes must not
independently activate a new production Artifact.

The trusted host reuses the exact current Core deployment as the build source.
It compiles the merged Workspace in a separate offline sandbox, builds with the
existing production environment and rebinds the exact Artifact and retained
non-secret Records/Workflow configurations, then checks staged health before
promoting. The compiler retains the complete Artifact in the existing prepared
Instance database and verifies it before staging `COMPANYOS_ARTIFACT_HASH`.
It clears the old inline Artifact environment value so full company context
does not consume the hosting environment budget. Startup awaits that exact
Artifact and verifies content and environment before handling requests. It creates no Preview app and copies no
production secrets into Preview. Domain promotion and a second exact live health
probe complete the release. Preserve the final Artifact hash in Instance deployment
configuration and retain its database content when an operator performs a later manual deployment; a Workspace
merge alone never publishes it.

Production-target staging may receive scheduled worker calls before domain
promotion. Core workers therefore read the exact deployment identity from the
primary production health endpoint before advancing any scheduled work. The
release binding's `productionUrl` takes precedence; other hosted production
workers use Vercel's `VERCEL_PROJECT_PRODUCTION_URL`. Unavailable identity fails
closed, and staged or superseded deployments do no work. Qualification endpoints
remain separate, protected, fixed-fixture operations. Verify the actual primary
domain rather than inferring it from an automatically generated alias.

Hosted provider orchestration must import only the remote validator. Local
Workbench validation and checkout metadata stay inside their separate trusted
execution; a successful build alone is not proof of hosted cold-start behavior.

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
   immediately. The acknowledgement confirms receipt only. The same card announces
   that coding is running only after a job-bound worker start receipt. Use
   **Cancel build** while waiting or running if necessary.
4. The trusted worker independently checks the diff and Workbench result, then
   publishes the exact outer proposal. Coding-agent claims are not evidence.
5. If a connected test was agreed, Core runs the unmerged version on the selected
   test resources. For an interactive Agent test, open the test channel and start
   a fresh thread. Mention the app where required. New threads use the selected
   build; existing threads retain their version. **Request Changes** opens the
   revision conversation without treating questions as development.
6. With the qualified release binding and passed checks, the authorized human
   accepts the result using **Go Live**. The coordinator merges,
   builds, checks, promotes and verifies the exact pairing.
7. The terminal card says live only after the production deployment and health
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
policy, protected and exact fast-forward inspection, ambiguous merge/deploy reconciliation,
separate staging and promotion, and actual Postgres persistence, concurrent saves
and expired leases. The initial Stage-0 Slack-to-draft tests predate this release
path and do not qualify its new image or production executor.

Each Company Instance still needs its selected App installation and scopes, a
qualified merge strategy, model/worker qualification, staged production health access,
and a bounded request-to-live proof. Record those private receipts with exact Core,
Workspace, image, Artifact and deployment identities. Local tests never substitute
for these provider and human acceptance steps.


## Release configuration and continuity

Core 0.6.0 introduces Workspace-declared Builder availability and the optional
`builder.release` company policy. Workbench 0.1.0-experimental.16 distributes the
matching intake and operations Guides. Remove a legacy `builder.enabled: false`
binding; omit execution bindings to keep conversation-only authoring available.
Previously explicit `enabled: true` bindings remain readable during migration.

The trusted compiler builds the Artifact from the exact Workspace and Core
commits. Handbook Markdown follows the existing scoped material selection in
that Artifact. Releases require no separate Knowledge bundle or snapshot.
General company policy, human release authority, and Instance qualification
continue to govern activation.

Existing Records and hosted Workflow settings are revalidated and rebound to
the exact new Workspace/Artifact while retaining qualified resources, enabled
workflow IDs, schedules and operators. No credentials are copied. Changes to
record sources, connections or the Records identity roster require renewed
qualification; they remain reviewable proposals until that evidence is supplied.
The live profile supports `auto` and the bounded connected test profile below.
General live trials, new provider resources, data migrations and split
acceptance/deployment actors still require a separately qualified path.

The result card displays **Go Live**, **Discard Build**, **Open Test Channel** and
**Request Changes** directly. If CI, test execution or Instance readiness is pending,
Go Live explains the blocker and refreshes evidence without saving a future approval.
A ready action accepts the current exact result; company policy still decides who
can approve and deploy. Discard closes only the unchanged unmerged proposal and
retains its evidence. If closure is uncertain, retry the same discard operation.

Core 0.7.0 and Workbench 0.1.0-experimental.17 support unprotected private
repositories without a paid GitHub plan.
The trusted coordinator advances the target only to the exact single-parent
candidate with `force: false`. Concurrent divergent changes stop the operation
and require refreshed checks and confirmation. A lost response is reconciled
from the exact branch and commit even if GitHub's PR display has not caught up.
Workbench inspection, validation and security checks remain mandatory, and every
observed hosted check must pass. Existing branch protection is preserved through
the protected merge path; permission errors do not trigger a fallback.

The Core release controls Builder operations and production adoption. It does
not prevent manual Git changes on an unprotected branch. Keep automatic
production deployment from company-repository pushes disabled; deployment uses
only the confirmed immutable Artifact. Rollback to an older Core requires
stopping releases from unprotected repositories. Pending old confirmations must
be refreshed because merge-strategy evidence is now part of their digest.

Manual deployments must carry the current exact Artifact and rebound non-secret
configurations forward. The Builder stores them durably with its release; it
does not silently overwrite project-level environment variables. Production
verification also compares Vercel's actual Git source commit with Core provenance.


## Configure and prove a connected functional test

Core 0.8.0 and Workbench 0.1.0-experimental.18 add a bounded connected profile.
Place exact test scopes in the existing non-secret Instance definition:

```yaml
builder:
  # Keep the existing execution, coding_agent and repository bindings.
  test_resources:
    - id: test-channel
      capability: communication.message.publish
      match: { destination_binding: existing-test-channel }
    - id: test-report-item
      capability: work-item.comment
      match: { resource_binding: existing-test-board, work_item_id: "42" }
```

These are fictional values. Use already qualified resources for the company.
The list grants no new provider scope and contains no credentials. The first
profile requires one existing Slack channel for result delivery and supports
single or interactive Agent replies without Tools and immediate operator workflow graphs with bounded
work-item capabilities. It excludes workflow messages, timers, intermediate
human decisions and automatic production-to-test resource remapping.

1. Builder reads the current definitions and Instance capabilities, resolves the
   test and starts coding from the grounded brief.
2. Trusted Workbench checks publish a candidate. Core compiles that exact
   unmerged candidate with the current Core and Instance configuration.
3. Core runs the selected test and updates the one result card. For an interactive
   Agent, users may create fresh threads directly in the configured test channel.
   Each user's new threads use their selected build; existing threads keep their
   candidate and history. The newest request is selected at admission. A build
   that is still preparing never falls back to an older candidate.
4. The requester reviews the actual result. **Request Changes** disables its old
   live action; only an explicit revision request starts another build. Questions
   and screenshot evaluations read the existing result without coding. A separate
   new build is allowed even while older reviews remain open.
5. **Go Live** accepts the exact current completed evidence without a Finish test
   step. **Open Test Channel** opens the existing destination; **Discard Build**
   abandons an unaccepted draft. Requester and deployment permissions still apply.
6. Core merges, compiles production, stages without domain assignment, verifies
   staged health, promotes and verifies the actual live identity. The test digest
   and provider receipts remain associated with that release.

A failed or ambiguous test never enables merge. Do not repeat provider writes to
repair a lost test receipt. Inspect retained session and workflow evidence before
a fresh attempt. An Agent reply test does not prove its handoff or Tool behavior;
a short workflow test does not qualify a timed multi-party process. Complete
pilot evidence includes actual human feedback and acceptance, not just synthetic
fixtures, successful compilation or an operator's asserted principal.


Interactive inactivity defaults to seven days; optionally add
`test_inactivity_days: 7` inside the existing Instance `builder` block (1–90 days).
A paused test retains its draft and history. The user can ask Builder to resume
or select an available older build, then start fresh threads without recoding.
Each build allows twenty conversations with twenty replies each. This does not
change provider access. Result cards identify a build whose selection has since
been replaced. Existing deployments require a qualified Core/image update;
editing these Guides alone does not update a live Instance. Keep old sessions
stopped before rolling back to code that does not understand multi-thread evidence.
