---
document_id: onboarding.company-workspace
title: Onboard a Company Workspace
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-08-24
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

Codex and Claude Code share the Release-matched `INSTALL-COMPANYOS.md` runbook;
`BOOTSTRAP_FOR_AGENTS.md` is its compatibility entrypoint. No harness plugin,
MCP server, hook, or OpenClaw component is required. The human pastes one
prompt into the ordinary coding-agent chat. The agent asks one bounded question
at a time, explains what will happen before each provider step, shows complete
plans, and waits for the human at authority boundaries.

The generated Workspace is deliberately `authoring-only`;
`companyos bootstrap verify <workspace>` is only the local checkpoint. The
maintained `vercel-neon-slack` setup profile then creates or adopts explicitly
named resources, moves the Workspace to one supervised operating starter
through a checked, Steward-confirmed pull request, deploys an immutable Artifact,
and requires a real Slack round trip persisted in Neon. Completion is
`companyos verify-live`, not local generation.

The release manifest and root `package.json` pin the exact pnpm version. The
agent invokes that version through npm's temporary package cache and verifies
it before the first locked dependency installation. It does not install,
replace, unlink, or force-link a global pnpm executable. The setup root,
Oregano checkout, Workspace, answers, and state file are resolved to absolute
paths before Workbench commands run, so changing pnpm's working directory
cannot redirect an input.

## 1. Verify external account prerequisites

Use individual human identities; never share one provider login between
Contributors. The company or its appointed custodian must retain billing,
recovery, and administrator access instead of depending on a Contributor's
personal account.

| Layer | Maintained reference setup | Required when | Acceptance |
|---|---|---|---|
| Git hosting and review | One GitHub user account and private repository | Every Workspace | The human creates a GitHub user account if they do not already have one. They select their own username for a personal repository or an existing organization only when their company already uses one. The setup never requires a new organization or paid GitHub plan. GitHub Free is sufficient for the supervised starter. A Platform Administrator with `repository` scope retains admin and recovery access. The setup applies hosted protection when available and reports whether GitHub enforces it. |
| Core checkout | GitHub credential or deploy key with read access to Oregano Core | Current co-checkout mode | CI can fetch the immutable Core commit without giving the Company Workspace write access to Core. |
| Runtime hosting | Vercel account/team/project | Before deploying an operating Instance | The Platform Administrator controls the project, deployment identity, environment separation, secrets, logs, and rollback. A conforming alternative host may replace Vercel. |
| Model execution | Vercel AI Gateway access in the runtime team | Before deploying a model-backed Instance | The selected model is permitted for the team's billing tier, usage budget and data terms are approved, and a deployed smoke test succeeds. |
| Durable state | Neon/Postgres account/project | When the Instance requires durable state | The Platform Administrator controls isolated databases, credentials, backup, retention, and recovery. A conforming StateStore may replace Neon. |
| Connected systems | For example Slack or Monday installations | Only when declared by an approved connection or Tool grant | Each installation has a named owner, minimum scopes, revocation path, and no secrets in Git. |

Local authoring does not require Vercel, Neon, Slack, Monday, or a model-provider
account. The maintained complete starter does require a Vercel account, consent
to create or adopt a Neon Marketplace resource, permission to install the Slack
app in a selected Slack workspace, and access to the selected Vercel AI Gateway
model. The agent opens or prints the correct authentication flow and waits; the
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

In both outcomes the installer creates the operating change through a pull
request, waits for the `check`, and requires the Workspace Steward's exact
merge confirmation. GitHub enforcement adds protection against accidental
direct pushes, force pushes, and deletion. It becomes a prerequisite only
before an unattended agent receives repository write, merge, or deployment
authority. Follow the version-matched [repository protection
Guide](../workbench/guides/configure-repository-protection.md) for the recorded
status and professional organization controls.

## 7. Run the maintained live starter when requested

An authoring-only request stops here. For the complete starter runbook, plan and
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
scope `live-starter-instance`: the repository is private, the required check
and explicit Steward merge authorization are recorded, current Vercel health
matches the exact Artifact and version pair, and a nonce-bound human Slack
message plus the exact Oregano reply `Setup-Test <nonce> successful.` are
persisted in Neon in the same conversation. Verification also requires the
immutable receipts for the exact provider resources used by the deployment and
fails closed on an unresolved setup intent. Hosted GitHub protection is
reported separately as `enforced` or `advisory`; either status is valid for
this Tool-free supervised starter. This is bounded evidence, not certification
of future Tools, unattended workflows, or generic production enforcement.
