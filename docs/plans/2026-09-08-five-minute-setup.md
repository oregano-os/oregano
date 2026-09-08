---
document_id: plan.five-minute-setup
title: Five-Minute Standard Setup
kind: plan
status: draft
authority: informative
language: en
updated: 2026-09-08
owners:
  - oregano-maintainers
audience:
  - human
  - agent
relations:
  depends_on:
    - onboarding.setup-options
    - command.setup
    - command.verify-live
    - architecture.company-instance
    - architecture.boundaries
    - specification.company-instance-release-promotion-v0.1
    - governance.agent-agreement
    - governance.versioning
    - guide.prepare-instance
---

# Five-minute standard setup

## 1. Decision and implementation status

The selected product direction is one standard journey: **connect accounts,
confirm one understandable summary, use Oregano in Slack**. Codex and Claude
Code start the same installer and explain its output. The CLI owns the flow.

This plan defines the implemented experimental standard journey. The coordinated
implementation record is
`.oregano/changes/2026-09-08-standard-setup-implementation.yaml`.
Packages 1–6 are implemented in the working tree; package 7 has regression and
timing-report tooling, but requires fresh external live runs before qualification.
The release is not published by this implementation, and five minutes is not an
achieved timing claim. The old explicit profile and state readers remain for
existing installations, deliberate adoption and advanced configuration.

The Vercel prerequisite and setup-options records remain their earlier evidence;
they have not been rewritten as if they shipped the entire simplification.

## 2. What becomes simpler

| Area | Required standard behavior |
|---|---|
| Entry | One short release-matched prompt for Codex or Claude Code starts the same CLI flow. The agent does not assemble a sequence from a long runbook. |
| Company | Suggest the connected Slack workspace name when available and unambiguous. Otherwise request one company name. Show language and timezone as editable defaults in the same summary. |
| Responsible person | Suggest the authenticated human from verified account data. Ask only for missing or conflicting identity information; show the person in the summary. |
| Technical names | Generate repository, project, database, directory, and internal IDs. Resolve name availability before presenting the summary. |
| Accounts | Reuse valid logins. Choose automatically only when there is one eligible account/team or an exact saved selection. Ask only for actual ambiguity. |
| Infrastructure | Default to GitHub, Vercel Pro or Enterprise, Neon/Postgres, and Slack. Keep supported overrides accessible under Advanced without an initial simple/advanced question. |
| Model | Use the release-maintained Gateway route and exact standard model. Offer model changes or a dedicated provider key later or on explicit advanced request. |
| Authorization | Show one summary covering resources, responsible person, region, possible charges, the starter, and the first production deployment. One human confirmation authorizes that scope. |
| Progress | Use short user-language status messages. Show commands, internal phases, receipts, and debugging detail only on request or when useful for an error. |
| Recovery | Retry transient failures and resume automatically. Involve the human only for missing authentication, required provider consent, an actual conflict, or a changed decision. |

Default precedence is explicit user choice, an exact saved setup selection,
verified provider metadata, then the release-maintained standard. Device
locale and timezone may be suggestions, not proof of company policy. Display
them together for correction rather than interviewing about each value.

Do not infer that a Slack workspace name is a legal company name. It is the
editable display name for the new Workspace. Do not assume that a matching
email proves that two provider identities belong to the same human. Resolve
the canonical IDs and show the proposed responsible person once.

The summary uses familiar words. A user must not need to understand
Workspace Steward, Artifact, ToolSet, Core pin, readiness, IDs, or hashes.
Their underlying records remain available in technical details.

## 3. What disappears from fresh installation

| Existing step | Required replacement |
|---|---|
| Eight-question interview | Automatic defaults with at most one free-text field when accounts are unambiguous. |
| Separate slug, ID, folder, language, and timezone confirmations | One editable overview; no name-by-name confirmation. |
| Four create/adopt decisions | Create new resources by default. Adopt only on an explicit advanced request. |
| Approval for local file generation | Included in the requested setup; draft generation and local checks run automatically. |
| First publish an authoring-only Workspace | Generate the complete operating starter as the initial version. Local authoring remains an explicitly selected separate feature. |
| Separate starter activation confirmation | The starter is already described in the single summary. |
| Initial activation PR and manual merge approval | A checked fresh-initialization receipt replaces this intermediate PR. Later Workspace changes retain their applicable governance. |
| Additional first-deployment confirmation | Include the initial deployment in the same bounded setup decision. |
| Model/provider consultation | A maintained Gateway default; no standard-path route or key interview. |
| User-maintained YAML, state paths, and confirmation hashes | The CLI creates, locates, and resumes its private session state. The agent transports machine responses internally. |
| Repeating checks of identical local inputs | Reuse a result bound to the exact release, template, configuration, and file digests. Recheck affected inputs when they change. |
| Technical completion report | Say that Oregano is ready and provide its verified Slack link; keep detailed evidence available separately. |

Do not retain the old five approvals and merely have the coding agent
manufacture their hashes. Implement one actual authorization contract for
fresh setup, and teach the verifier to recognize its evidence.

Do not turn Advanced into another prerequisite. It contains only implemented
and documented options such as explicit resource adoption or supported model
recipes. Other infrastructure providers remain unavailable until implemented
and qualified; another Markdown guide alone does not make them installable.

## 4. What remains

| Requirement | User experience and implementation |
|---|---|
| Accounts and necessary access | Reuse existing logins or open the required provider login. |
| Provider consent | The human accepts actual provider permissions and terms in the browser. These are not extra Oregano confirmations. |
| One Oregano setup decision | Review the concrete overview and choose Set up. |
| Named responsibility | The proposed responsible person is visible and editable in that overview. |
| Cost clarity | Show Vercel Pro, database and model usage, region, and relevant billing links once before resource creation and deployment. Include the Vercel check already implemented. |
| Credential and resource protection | Keep credentials out of chat/Git; preserve existing resources. A real conflict gets a specific diagnostic, not a generic safety questionnaire. |
| Version and function verification | Verify the release, initial files, deployment, model response, and persistence automatically. |
| A real Slack exchange | Open Oregano and send an ordinary first message. Correlate the authorized human's message and real model response internally. |
| Later company capabilities | Add knowledge, data sources, business Tools, and automation when requested after setup. |

The initial Agent remains supervised and has no business Tool grants.
Knowledge import, Builder activation, sources, and unattended workflows do not
become hidden prerequisites for the first Slack response.

An account signup, required Vercel upgrade, or unavailable Slack administrator
can prevent immediate completion. Explain the actual remaining action. Do not
promise to remove provider authentication with a better prompt. A managed
Oregano hosting service would be a separate product and is outside this plan.

## 5. CLI-owned flow and authorization

The proposed standard entry is `companyos setup` with no required answers,
profile, Workspace, or state arguments. The agent invokes it after resolving
one exact release. The same entry resumes an unfinished session in that setup
folder. Existing explicit low-level commands remain available for legacy and
advanced use. These defaults are implemented by the standard session; release publication
and cold live qualification remain pending.

The state machine owns this sequence:

1. **Prepare:** resolve one immutable release, acquire its verified installer,
   discover an existing setup session, and reuse available prerequisites.
2. **Connect:** inspect existing logins and eligible accounts, obtain necessary
   browser authentication, and read the selected Vercel team's plan.
3. **Review:** derive defaults, inspect collisions, generate a local starter
   preview, and show one editable resource/cost/responsibility summary.
4. **Set up:** after the single human decision, create the authorized resources,
   complete any required provider consent, resolve exact Slack identity,
   materialize and check the initial operating Workspace, publish it, prepare
   the database, build the exact deployment, and deploy it.
5. **Use:** verify current health, open Oregano in Slack, observe the first
   real exchange, verify persistence, and report success.

The current Slack adapter resolves the human after connector creation. Do not
claim that the Slack name or identity is always available during read-only
discovery. Reuse it before Review only when authenticated, read-only metadata
already supplies it. Otherwise use the single company-name fallback and bind
the subsequently verified Slack principal to the confirmed installer. A new
connector must not be created before the resource/cost authorization merely
to avoid that one input. If provider identity is genuinely inconsistent, ask
for correction rather than silently appointing another responsible person.

The CLI exposes structured progress, missing-input, browser-action, review,
recovery, and completion events. Both agents render the same pending event
and submit the human's answer to that session. They do not choose new phases,
invent missing answers, or repeatedly ask to run routine commands. The
machine transport may contain revision IDs and digests; the human sees the
summary and one confirmation, not YAML or hashes. A global unattended `yes`
flag is not a substitute for the human's response.

The authorization receipt binds:

- the authenticated responsible human and selected provider account scopes;
- the immutable release, starter template, derived company configuration,
  model recipe, region, resource names, and create-only mode;
- the disclosed subscription/usage basis and the initial deployment scope;
- the reviewed summary revision, human response, and setup session identity.

Provider-assigned IDs and build output hashes are recorded after creation and
linked to that receipt through deterministic inputs and mutation receipts.
The initial approval must describe this derivation; it cannot pretend to
approve a not-yet-existing output hash. Check the exact resulting commit and
Artifact before deployment. A changed owner, region, model, cost basis,
template, authority, or target invalidates the affected approval and requires
an updated summary. Ordinary retries and newly observed provider IDs do not.

## 6. Fresh initialization, existing systems, and evidence

The new route applies only to a fresh installation into new resources.
Record that classification before mutation and retain create intents and
authoritative receipts. An empty repository found by name is not proof that
this installer created it. Never overwrite or adopt a colliding resource.
Names may use deterministic available suffixes before Review; a race after
confirmation is a real conflict, not permission to switch targets silently.

Generate one complete, valid operating Workspace from the confirmed starter
template and resolved identity. There is no published authoring-only commit,
activation version bump, activation PR, or merge approval. A local temporary
rendering stage is an implementation detail and does not create another user
checkpoint.

Before first deployment, validate the generated tree and exact initial commit,
retain the required CompanyOS check result, and attempt the existing hosted
protection baseline for the new repository. Establish protection for later
changes without requiring a PR against a nonexistent prior operating version.
If an organization has stricter controls that prevent direct initialization,
honor them and report the actual constraint; do not use admin bypass.

Add a versioned `fresh-initialization` evidence variant to the existing setup
state and final verifier. It proves the single setup decision, new-resource
ownership, complete initial Workspace, checks, exact deployment, and Slack
exchange. It replaces the legacy merge receipt only for that variant; it must
not fabricate a PR URL, merge SHA, or approval event.

Existing installations, adoption, and later production changes continue to
use their applicable review and deployment process. Preserve readers and
resume behavior for current state versions. Do not silently reinterpret an
unfinished legacy setup as freshly authorized. New state writes use an
explicit schema version and flow kind; older clients must reject unsupported
states with useful guidance. Resume through a changed Core release requires
compatibility handling, not a silent template/model change.

Use the existing intents and receipts for bounded retry, backoff, and provider
reconciliation. Never blindly retry a create or deploy after an ambiguous
provider response. Recover its receipt, or report the exact unresolved action.
Recovery does not delete and restart the company setup.

Reuse checks only when their actual inputs are unchanged. Cache immutable
local validation by digests; keep live account, plan, target, and deployment
evidence current at the relevant effect/completion boundaries. This removes
duplicated work without making a stale provider response permanent authority.

## 7. Implementation packages and order

Each package below requires an implementation Change Plan with its actual
files and tests. They form one delivery; completing only the entry prompt or
documentation does not satisfy the standard setup requirement.

| Order | Work | Principal surfaces | Completion evidence |
|---|---|---|---|
| 1 | Establish discovery, defaults, release acquisition timing, and the standard session entry. | `packages/cli/src/cli.mjs`, `packages/cli/src/setup/`, release manifest and asset generation. | One eligible account requires no account question; at most one company-name field; stable names and same-session resume. A full cold-start timing trace identifies acquisition/build bottlenecks. |
| 2 | Implement the editable summary and one scoped human decision, with exact state/version handling. | `packages/cli/src/live-setup.mjs`, setup state and provider contracts, proposed standard-session module under `setup/`. | No external creation before confirmation; one decision covers the first deployment; changed scope cannot reuse it. |
| 3 | Generate and qualify the initial operating Workspace directly. | `packages/cli/src/workspace-generator.mjs`, `operating-starter.mjs`, Workspace validation and initial GitHub publication. | No authoring-only published baseline, activation PR, or activation confirmation; a valid initial commit with named responsibility and check evidence. |
| 4 | Connect the existing provider lifecycle to the new flow and complete automatic recovery. | Live setup and the Vercel/Neon/Slack profile, database prepare, Artifact build/deployment, state receipts. | New-resource creation, automatic Vercel detection, database preparation, and first deployment resume without duplicate resources or another unchanged-scope decision. |
| 5 | Implement ordinary-message Slack proof, plain-language progress, and fresh-initialization verification. | `packages/cli/src/live-database-proof.mjs`, `packages/runner-vercel/src/lib/setup-verification.ts`, setup verifier and tests. | A real authorized user message, selected-model response, and persistence are correlated to the exact setup/deployment without a user-entered nonce. |
| 6 | Deliver the fast release installer and synchronized documentation. | `scripts/prepare-release-assets.mjs`, `.github/workflows/release.yml`, `release-manifest.json`, installation entrypoints, required canonical documents. | Checksummed release assets, one source for standard profile/model metadata, equal Codex/Claude behavior, and no full developer dependency installation on the standard client path. |
| 7 | Qualify the complete release on fresh accounts/resources and measure the user journey. | CLI/Runner regression tests, release installation fixtures, private live receipts, public aggregate timing report. | The acceptance criteria below pass; only then advertise the simplified setup and its qualified timing. |

The acquisition prototype starts in package 1, not after the rest ships.
Package 6 produces a release-built installer payload containing the required
Workbench/provider tooling and deployment inputs for declared supported
platforms. Preserve exact Core provenance and reproducible builds; do not
discard release verification to save time. An npm publication is not required
by this plan. Source/developer installation can remain an advanced path.

Measure remote Runner build/deployment and GitHub checks as part of the same
critical path. Moving a dependency installation to Vercel does not remove its
time from the five-minute result. Perform independent reads or preparation
concurrently where useful; keep effects and dependent operations ordered.

Read the standard model/profile from one release-matched registry/manifest
source and generate the installer metadata from it. The existing mismatch
between runbook, CLI routes, and release assets must be resolved for advertised
choices. Do not hard-code a second model recommendation in the short prompt
or advertise an unqualified advanced route.

## 8. Required contract and documentation changes

The current release/promotion specification explicitly separates merge and
deployment confirmations and its implemented subset requires the activation
PR. The current runbook and verifier enforce those rules. The implementation
must update them with the narrow fresh-initialization contract described here.
Simply telling an agent to ignore them would not implement this plan.

Update these surfaces together with executable behavior:

- `INSTALL-COMPANYOS.md`, `BOOTSTRAP_FOR_AGENTS.md`, and the short prompts in
  `README.md`: short entry, same installer, one pending human decision.
- Onboarding index, Company Workspace onboarding, and setup choices: new
  standard, explicit advanced/adoption/local-authoring paths, actual status.
- `companyos setup`, `verify-live`, `create workspace`, `bootstrap`, and
  `onboard` documentation and affected command behavior: internal checkpoints
  must agree about direct operating initialization and legacy use.
- Company Instance and system-boundary architecture, release/promotion
  specification, and any affected governance text: one initial authorization
  with fresh-initialization evidence; later governance remains scoped.
- Prepare-an-Instance Guide, packaged Guides, generated documentation,
  release metadata, release qualification, and current status.

Classify the release under the versioning policy once the final compatibility
surface is known. Keep the old explicit CLI/state path working where possible;
any required consumer migration needs the corresponding release classification
and migration instructions. Do not bump a version merely for this plan.

## 9. Acceptance and five-minute measurement

The standard route is complete only when all these user-visible criteria pass:

1. At most one free-text input when account identity and selection are clear;
   zero is possible when the company display name is already available.
2. Exactly one Oregano setup confirmation, including the first deployment,
   plus necessary provider authentication/consent. No local-file, activation,
   initial merge, model-choice, or second deployment confirmation.
3. No technical configuration questions and no simple/advanced mode interview.
4. No commands, YAML, state paths, IDs, hashes, or nonces that the human must
   type after the start prompt.
5. The real first model-backed Slack response appears within 300 seconds for
   the qualified existing-account scenario, including all technical waits.
6. Current deployment health and persisted conversation evidence pass; success
   is not a simulated reply or an authoring-only checkpoint.
7. Both Codex and Claude Code use the same entry and event contract. Unsupported
   features remain clearly marked rather than offered as working setup choices.

Measure elapsed wall time from sending the start prompt in a new setup folder
until the first real Slack response is visible. Include agent startup, release
discovery and download, required tool acquisition, login/consent interaction,
the one confirmation, resource creation, checks, database preparation, build,
deployment, retries, and Slack interaction. Also record final persistence
verification and total completion time. Do not restart the clock after
dependencies are installed or subtract technical waiting time.

The qualifying scenario has existing eligible GitHub and Slack accounts, an
already Pro/Enterprise Vercel team, required installation rights, a supported
machine and network, and a present human who completes requested provider
actions. Start with a cold Oregano/tooling cache; existing ordinary provider
logins may be reused. Account creation, a paid-plan upgrade, an administrator
approval queue, or provider outage is a separately reported scenario, never
an omitted portion of a supposedly successful timed run.

Engineering allocation for the initial 300-second budget, to be verified by
measurement rather than represented as an achieved result:

| Work | Budget |
|---|---:|
| Agent/release discovery and cold installer acquisition | 40 seconds |
| Account discovery/authentication and one summary decision | 60 seconds |
| Resource creation, provider consent, and database preparation | 60 seconds |
| Initial checks, build, deployment, and current health | 110 seconds |
| Open Slack, exchange the first message, and verify persistence | 30 seconds |
| Total | 300 seconds |

Record per-phase durations, Oregano question/confirmation counts, provider
actions, cold/warm cache state, host permission prompts, platform, release,
agent harness, and failure/retry details without credentials. Host-mandated
permissions are reported separately; they must not be mistaken for questions
introduced by Oregano. Use at least five cold runs per harness on each
advertised platform, report every result plus median and maximum, and require
the qualifying runs to meet the target before making the five-minute claim.
Warm-cache measurements are additional evidence, not a replacement.

Regression coverage must include:

- automatic defaults, missing metadata, multiple eligible accounts, and
  conflicting identities without a fabricated responsible person;
- no mutations before confirmation; scope changes, stale decisions, duplicate
  responses, and cancellation without a hidden deployment;
- absence of the five old human gates in fresh setup, and valid initial
  evidence without fake PR/merge fields;
- Hobby, Pro, Enterprise, inaccessible plan evidence, and downgrade on resume;
- collisions and organization controls, interrupted creates/deployments,
  receipt reconciliation, safe retries, and unchanged-scope resume;
- old state versions, explicit adoption, local authoring, and later governed
  changes without a fresh-install authorization shortcut;
- release/default metadata consistency, installer integrity, and equal
  Codex/Claude user journeys;
- a genuine first Slack reply, exact identity/deployment/model correlation,
  persistence failure, and no success before the required evidence exists.

Use the existing live-setup, Workbench, and Runner setup-verification tests and
add focused standard-session/release tests where needed. Synthetic tests cover
the contracts; live release runs establish provider compatibility and timing.

## 10. Delivery status and rollback

Packages 1–6 are implemented: default entry and discovery, one scoped decision,
fresh operating initialization, provider lifecycle/recovery, natural Slack
proof and verification, and checksummed release installer plus documentation.
Regression coverage includes a simulated complete flow, duplicate responses,
cancellation, account/scope changes, checks and provider interruption, legacy
states, relocated payload dependencies and release integrity. No test receipt
is represented as external live evidence.

Package 7 is partially complete. The CLI can export a non-secret timing report
only after live completion via `--timing-report <file> --harness codex|claude-code
--cache cold|warm`; preserve the original `--started-at` prompt timestamp. Record
provider and host interactions alongside the session's phase timestamps. Combine
reports in a JSON array and run `node scripts/qualify-standard-setup.mjs
<runs.json> <aggregate.json>`. Qualification rejects missing/duplicate runs,
warm or simulated evidence, excess questions/decisions, mixed releases, missing
verification and first responses beyond 300 seconds. At least five cold runs
for each harness on each advertised platform must pass. Those real account runs
and a published matching release remain outstanding.

This is a new user-facing initialization/authorization contract, classified as
MINOR under the pre-1.0 versioning policy. Assign the actual version in the
separate reviewed release change. Existing explicit setup states require no
migration; unfinished schema-5 sessions must use their original compatible
release. Do not backport them into the legacy state shape.

Rollback selects the last compatible release for future installations and
preserves existing session/resource receipts. An unfinished new-format setup
uses a compatible recovery path; it is never deleted and re-created through
the legacy installer. Reverting code does not undo created resources,
subscriptions, database changes, or an already completed first deployment.
