---
document_id: onboarding.company-workspace
title: Onboard a Company Workspace
kind: guide
status: approved
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
    - onboarding.index
    - governance.roles
    - guide.configure-repository-protection
    - architecture.company-instance
---

# Onboard a Company Workspace

## Agent-guided complete starter setup

Codex and Claude Code share the verified release installer and the same
`companyos setup` session. The human pastes the short prompt and sees connected
accounts, one editable setup summary, necessary provider actions, and the Slack
link. Technical defaults and evidence are managed by the CLI. One setup decision
includes the first deployment; the direct fresh initializer produces the whole
operating Workspace at `0.1.0` with one named Steward and no business Tools.

The installer does not publish an authoring-only intermediate version or ask
for an activation PR, merge, or second deployment decision. Required checks
still run on the initial commit. A real first Slack reply and Neon persistence
must pass before `complete`. The source implementation is experimental and
awaits fresh cold-run qualification; see [setup choices](setup-options.md).

The reference checklist below describes the resulting account, Workspace and
governance contract. It is not a questionnaire to repeat during standard setup.
For an existing Workspace or explicit adoption use the advanced profile and
its existing change process. Local authoring via `create workspace` still yields
an authoring-only Workspace; `bootstrap verify` remains its local checkpoint.
The bundled release tools use exact versions without replacing global tooling.
Provider-created skills and local OIDC files are contained in a private temporary
CLI directory and removed after use, including failed commands. Only the
non-secret project link is retained for deployment. The subsequent health
check uses a provider-confirmed production alias and checks the exact deployment
ID; it neither disables deployment protection nor creates bypass credentials.

### Candidate initialization

An explicitly selected unpublished installer candidate initializes the same
operating Workspace and records its candidate identity in the setup decision
and initialization receipt. A candidate creates its own session-named Slack
connector, allowing a separate test alongside an existing company installation.
Its first GitHub check uses pinned source and a
frozen dependency install; it does not depend on a release tag. See
[testing before release](../workbench/commands/setup.md#test-an-unpublished-candidate).

## 1. Verify external account prerequisites

Use individual human identities; never share one provider login between
Contributors. The company or its appointed custodian must retain billing,
recovery, and administrator access instead of depending on a Contributor's
personal account.

| Layer | Maintained reference setup | Required when | Acceptance |
|---|---|---|---|
| Git hosting and review | One GitHub user account and private repository | Every Workspace | The human creates a GitHub user account if they do not already have one. They select their own username for a personal repository or an existing organization only when their company already uses one. The setup never requires a new organization or paid GitHub plan. GitHub Free is sufficient for the supervised starter. A Platform Administrator with `repository` scope retains admin and recovery access. The setup applies hosted protection when available and reports whether GitHub enforces it. |
| Core checkout | GitHub credential or deploy key with read access to Oregano Core | Current co-checkout mode | CI can fetch the immutable Core commit without giving the Company Workspace write access to Core. |
| Runtime hosting | Vercel Pro or Enterprise team/project | Before deploying an operating Instance | The Platform Administrator controls the project, deployment identity, environment separation, secrets, logs, and rollback. A conforming alternative host may replace Vercel. |
| Model execution | Gateway access, a supported cloud-provider account and dedicated key, or an explicitly reachable compatible endpoint | Before deploying a model-backed Instance | The explicit recipe and exact route-prefixed model are selected, billing and data terms are accepted, and a deployed model-backed smoke test succeeds. A required key is entered only in the runtime host secret UI. |
| Durable state | Neon/Postgres account/project | When the Instance requires durable state | The Platform Administrator controls isolated databases, credentials, backup, retention, and recovery. A conforming StateStore may replace Neon. |
| Connected systems | For example Slack or Monday provider connections | Only when declared by an approved connection or Tool grant | Each connection has a named owner, minimum access, revocation path, and no secrets in Git. |

For the maintained hosted Monday Connector, the Instance declaration pins the
reviewed account, authenticated member, external-Agent kind and provider Agent
subject in `credential_identity`; `actor_id` equals that member ID. Obtain these
values from the completed external-Agent qualification receipt. Each retained
Artifact needs its own reviewed configuration; a missing identity blocks access.
The host rechecks the same credential and current resource permissions before
invocation. This external check remains `manual` in local onboarding and does
not make the Workspace a credential or provider-identity authority.

Local authoring does not require Vercel, Neon, Slack, Monday, or a model-provider
account. The maintained complete starter requires a Vercel Pro or Enterprise
team, detected automatically before hosted resource creation, and consent
to create or adopt a Neon Marketplace resource, permission to install the Slack
app in a selected Slack workspace, and access to the selected model route.
Oregano manages background scheduling. Hobby requires a human upgrade through
the returned billing link followed by resume; no cron-frequency selection is
part of onboarding.
Gateway uses the Vercel deployment identity. Direct recipes bypass Gateway;
the human enters the provider key only under its documented Sensitive
Production variable in the Vercel project UI. The agent opens or prints the correct authentication flow and waits; the
human never pastes a password, provider token, database URL, or private key into
chat.

## 2. Assign accountable roles

Name the human who is accountable for the company's Workspace, approvals, and
rules (the **Workspace Steward**; in the German runbook: "ist gleich Workspace
Steward"). The maintained starter needs only this one person. The same person
may also act as Platform Administrator with `repository` and `instance` scopes;
every action still states which authority is being exercised. Organizations
that later want separation of duties may explicitly select
`review_mode: independent-review` and appoint additional Stewards, but that is
not an installation prerequisite.

## 3. Establish the Workspace contract

The standard initializer fills this contract and its operating starter together.
The empty authoring-only baseline below applies to the separate local generator.

Create the Spec-defined directory tree and the required entrypoints. The
minimum governed repository includes `company.md` with an exact
`workspace_version`, `AGENTS.md`, handbook, policies, the Builder Agent
entrypoint, and empty `workflows/`, `connections/`, and `schedules/`
directories. Do not create an operating agent or workflow until the company
has approved one.

Add these machine-readable control files:

- `.companyos/governance.yaml` — roles, change classes, and approvals;
- `.companyos/compatibility.yaml` — exact Core version, immutable Core commit,
  and exact Workbench version;
- `.companyos/repository-protection.yaml` — intended Git workflow and hosted-hardening baseline;
- `.github/CODEOWNERS` — technical reviewer routing;
- `.github/workflows/check.yml` — validation and inspection.

## 4. Pin the exact Core

For the current co-checkout mode, `core.version` must equal the exact Core
version in the checked-out Core repository and `core.ref` must be a
40-character commit SHA, never `main`, another branch, or a floating tag. CI
reads the reference before it checks out Oregano Core. The Workbench version in
the same file identifies the validator contract contained by that Core commit.
Run `companyos versions .` and require exact matches; validation fails closed
when the versions differ.

A future published Workbench package may remove the local Core-checkout
requirement. It must not silently replace the immutable compatibility pin.

## 5. Run local onboarding

From the pinned Workbench environment run:

```bash
companyos onboard .
companyos versions .
companyos validate .
companyos security .
```

Resolve every error. `manual` means the required fact lives outside the
repository; it does not mean the requirement is optional.

## 6. Apply GitHub protection automatically when available

The maintained setup makes one automatic attempt to apply the declared
protected-`main` baseline. It accepts an existing baseline that is at least as
strict and never overwrites existing protection. When GitHub enforces the
baseline, setup records `enforced`; when the account or repository does not
provide the feature, setup records `advisory` and continues. This is detected
state, not a user-selected installation mode, and the agent never asks for a
GitHub upgrade.

Fresh setup waits for the initial commit's `check` under its single setup
decision. The explicit legacy/adoption flow creates an operating pull request
and retains the Workspace Steward's exact merge confirmation. GitHub enforcement adds protection against accidental
direct pushes, force pushes, and deletion. It becomes a prerequisite only
before an unattended agent receives repository write, merge, or deployment
authority. Follow the version-matched [repository protection
Guide](../workbench/guides/configure-repository-protection.md) for the recorded
status and professional organization controls.

## 7. Complete an existing authoring Workspace when requested

An authoring-only request stops here. To activate an existing authoring Workspace, plan and
execute `companyos setup --profile vercel-neon-slack` with its non-secret
answers file and ignored, mode-0600 state file. The profile performs GitHub,
Vercel, Neon, and Slack setup only after explicit create-or-adopt selection,
provider consent, and the applicable confirmation hash. It never places a
provider credential in Git or setup state.

The profile is assembled from private typed adapters for the source-host,
runtime-host, state-service, and communication roles. Its maintained bindings
are GitHub, Vercel, Neon/Postgres, and Slack. Those bindings are Workbench setup
policy, not Core runtime dependencies and not a public provider extension API.
A future Hetzner, Docker, Railway, Supabase, or other provider path must satisfy
the same role contract through a separately qualified adapter and profile.

For a new Instance, the selected database normally does not exist before this
setup. The State Service phase therefore creates or explicitly adopts one
resource and binds its `DATABASE_URL` only in the runtime secret environment.
The next phase runs `companyos database prepare` through that runtime profile.
Prepare detects an empty, older, or current database and selects `bootstrap`,
`upgrade`, or read-only `verify`; callers do not have to guess which lifecycle
operation applies. It creates or upgrades `companyos`, `companyos_knowledge`,
and `companyos_records`, records the exact version-manifest entry, and performs
read-only qualification before setup may continue. Setup records only the
selected operation, previous manifest versions, and non-secret manifest,
feature, object-count, provider-resource, and timestamp evidence. The
maintained Vercel path uses
`vercel env run`; this is an adapter detail rather than a requirement for other
runtime hosts.

The current additive manifest is `companyos-postgres@1.9.0`, succeeding the
immutable `1.8.0`, `1.7.0`, `1.6.0`, `1.5.0`, `1.4.0`, `1.3.0`, `1.2.0`, `1.1.0`, and `1.0.0` definitions. It qualifies 67
required Knowledge tables and 14 Record Source and Sprint tables, including stable groups, durable Source Events, ACL
snapshots, pipeline receipts, completed watermarks, lifecycle requests, an
integrity-linked change stream, durable synchronization leases, compounding
receipts, review-only Claim-pair proposals, explicit grading requests,
model-task results, spend reservations, execution ledger rows, rebuildable
Retrieval V3 projections, payload-free benchmark and rollout receipts, and
atomic Sprint event, state, decision, and intent records. Unresolved
existing Source and Claim evidence remains under the reserved quarantine
policy. Applying schema never grants access by itself; runtime subject
resolution and authorization conformance remain mandatory.

Knowledge Source activation follows database preparation; it is not a database
migration step. A new setup may begin with no database at all: the State
Service first creates or adopts the PostgreSQL resource, `database prepare`
creates the current schemas, and read-only verification qualifies them. Only
then may setup install a SecretRef-only Source binding, deploy its runtime
handlers, obtain provider qualification evidence, change the binding to
`active`, run the initial backfill, and verify aggregate object and watermark
state. Each runtime profile supplies its own secret and scheduler adapters; the
Source contract itself does not require Vercel.

Before each external create operation, setup writes a non-secret intent to the
state file; after the provider returns an immutable identity, setup records an
immutable receipt immediately. Resume reconciles any unresolved intent by that
identity and refuses an ambiguous name-only match. Adoption verifies that the
existing Vercel project uses `packages/runner-vercel` as its root and that
existing production environment values do not conflict; setup does not force
or overwrite either setting. Provider errors preserve existing resources and
return actionable, redacted diagnostics.

The Slack binding has the fixed logical Connector UID `slack/oregano`, requests
the minimum identity authorization needed to resolve the consenting human, and
keeps the visible Agent name `Oregano` for every Company Workspace. The
Company Workspace name and provider-internal resource names do not alter that
identity.

The profile is deliberately narrow: it installs one supervised, Tool-free
Slack assistant and records readiness as `validated`. It does not implement the
general Preview or Effect Lane orchestrator, authorize unattended execution, or
establish `enforced` readiness. Any later operating change follows the
[Company Instance Release and Promotion
contract](../specifications/company-instance-release-and-promotion-v0.1-draft.md).

## 8. Acceptance

Onboarding is locally ready when `companyos onboard` has no errors. The complete
starter is ready only when `companyos verify-live --state <file>` succeeds with
scope `live-starter-instance`: the repository is private, the exact initial
commit and fresh setup decision (or legacy checked merge) are recorded, current
Vercel health matches the exact Artifact and version pair, and an authorized
Slack exchange has model-response and persistence evidence. Fresh setup uses
an ordinary first message; legacy states retain their exact nonce-bound reply. Verification also requires the
immutable receipts for the exact provider resources used by the deployment and
fails closed on an unresolved setup intent. Hosted GitHub protection is
reported separately as `enforced` or `advisory`; either status is valid for
this Tool-free supervised starter. This is bounded evidence, not certification
of future Tools, unattended workflows, or generic production enforcement.

## 9. Add Company Knowledge when needed

1. Write reviewed OKF concepts under `handbook/` and update
   `handbook/index.md` in the same change.
2. Keep unverified source material in `brain/inbox/`; exclude credentials.
   Personal or otherwise sensitive raw input remains in administrator-only
   quarantine until policy mapping and human review are complete.
3. Run `companyos knowledge inspect .` and `companyos knowledge review .`.
4. Permit `knowledge.search`/`knowledge.get` and optionally
   `knowledge.traverse`, grant the corresponding standard Tools to selected
   Agents, and bind those Capabilities to
   `oregano/knowledge-postgres@3.0.0` in the Instance.
5. Build the control Artifact and separate Knowledge Bundle, then stage,
   verify, and activate the bundle through the existing `DATABASE_URL`.
6. Prove one cited query, one exact get, one explicit zero-result gap, and one
   negative access case for every declared authorization group.

7. Optionally add one reviewed repository Source requirement, bind
   `oregano/github-repository-source@1.0.0` through an `env:NAME` SecretRef,
   verify it, and run an explicit sync. Treat every resulting envelope as raw
   review input.
8. Run a retrieval regression ledger and record backup/rebuild evidence before
   relying on hybrid or source-backed operation.

Declare stable `groups` on roster members. A new Workspace assigns its Steward
to `companyos:knowledge-admin`; keep that group tightly held because it may
review quarantined candidates. Restricted OKF uses `visibility` plus
`allowed_groups` or `allowed_principals`. Never use display names, paths, tags,
or prompt text as access control. A sensitive Source Connector remains disabled
until its external-principal and provider-ACL mappings pass negative conformance
tests, even when the Core authorization tests pass.

## Builder availability and live adoption

A valid Workspace Builder definition expresses desired availability. The Instance
supplies the actual coding and repository access; a redundant `builder.enabled`
flag is unnecessary. Route conversations with an explicit binding or an authorized
handoff from the normal company Agent. Reading and clarification remain possible
before coding access is ready.

Configure each company's requester or Steward acceptance rules and deployment
delegation in `.companyos/governance.yaml`. Preserve security and independent-review
requirements. A resolved implementation request starts isolated coding without a
second start confirmation. A checked result needs its authorized acceptance before
release; the same human may accept and release in one action when holding both roles.

Use the version-matched [Operate the Builder](../workbench/guides/operate-builder.md)
Guide to bind the shared qualified image, selected coding profile, service App,
repository installation and production executor. One image contains CLI and Guides;
coding and trusted operations use separate executions. Reuse existing production
apps and connections. No Preview or second app is required for simple changes.

The maintained initial release profile combines Workbench checks, protected CI,
human acceptance, staged production health and exact live verification. Other test
strategies and data migrations require qualified evidence/execution before automatic
release. Missing hosted enforcement or provider rights must be reported explicitly;
neither a Workspace declaration nor a passing local test supplies those rights.
