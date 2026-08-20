---
document_id: onboarding.company-workspace
title: Onboard a Company Workspace
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-08-20
owners:
  - core-maintainers
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
through an independently reviewed pull request, deploys an immutable Artifact,
and requires a real Slack round trip persisted in Neon. Completion is
`companyos verify-live`, not local generation.

## 1. Verify external account prerequisites

Use individual human identities; never share one provider login between
Contributors. The company or its appointed custodian must retain billing,
recovery, and administrator access instead of depending on a Contributor's
personal account.

| Layer | Maintained reference setup | Required when | Acceptance |
|---|---|---|---|
| Git hosting and review | One GitHub user account and private repository | Every Workspace | The human creates a GitHub user account if they do not already have one. They select their own username for a personal repository or an existing organization only when their company already uses one. The setup never requires a new organization. The maintained private protected path currently requires GitHub Pro for a personal repository or GitHub Team/Enterprise for an organization. A Platform Administrator with `repository` scope has admin access and the selected plan actually enforces the declared protection. |
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
Steward"). Name a second real person with a distinct GitHub account for the
independent operating-change review. The maintained starter appoints this
person as a second Workspace Steward with the roster's declared R1-R4 approval
and business/personal-data visibility; explain that authority and obtain their
consent. A second account controlled by the first person is not independent.
Also name a Platform Administrator with `repository` and `instance` scopes. One
person may initially be both Workspace Steward and Platform Administrator, but
the operating security change still requires the separate reviewer and every
action states which authority is being exercised.

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
- `.companyos/repository-protection.yaml` — required hosted Git baseline;
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

## 6. Apply GitHub protection

The Platform Administrator with `repository` scope maps the intended Workspace
or Process Steward to the CODEOWNERS user or team and applies the declared
ruleset to `main`. Follow
the version-matched [repository protection Guide](../workbench/guides/configure-repository-protection.md).
The branch author cannot self-certify this hosted control.

If only one Workspace Steward exists, do not manufacture review independence
with a second self-owned account. An `authoring-only` Workspace may use
the Guide's named PR-only bootstrap exception until an independent reviewer is
appointed. The onboarding report keeps that limitation visible, and
`workspace_mode: operating` rejects it.

## 7. Run the maintained live starter when requested

An authoring-only request stops here. For the complete starter runbook, plan and
execute `companyos setup --profile vercel-neon-slack` with its non-secret
answers file and ignored, mode-0600 state file. The profile performs GitHub,
Vercel, Neon, and Slack setup only after explicit create-or-adopt selection,
provider consent, and the applicable confirmation hash. It never places a
provider credential in Git or setup state.

The profile is deliberately narrow: it installs one supervised, Tool-free
Slack assistant and records readiness as `validated`. It does not implement the
general Preview or Effect Lane orchestrator, authorize unattended execution, or
establish `enforced` readiness. Any later operating change follows the
[Company Instance Release and Promotion
contract](../specifications/company-instance-release-and-promotion-v0.1-draft.md).

## 8. Acceptance

Onboarding is locally ready when `companyos onboard` has no errors. The complete
starter is ready only when `companyos verify-live --state <file>` succeeds with
scope `live-starter-instance`: the repository is private and protected, the
independently reviewed operating change is merged, current Vercel health
matches the exact Artifact and version pair, and a nonce-bound human Slack
message plus Oregano response are persisted in Neon. This is bounded evidence
for the supervised starter, not certification of future Tools, unattended
workflows, or generic production enforcement.
