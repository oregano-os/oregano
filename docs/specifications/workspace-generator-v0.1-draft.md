---
document_id: specification.workspace-generator-v0.1
title: Company Workspace Generator v0.1
kind: specification
status: building
authority: normative
language: en
updated: 2026-08-21
owners:
  - core-maintainers
  - product-owner
audience:
  - human
  - agent
availability: experimental
relations:
  depends_on:
    - vision.companyos
    - architecture.company-workspace
    - architecture.security-governance
    - onboarding.company-workspace
    - specification.companyos-core-v0.7
    - specification.core-workspace-upgrades-v0.1
---

# Company Workspace Generator v0.1

This specification defines the first deterministic Workbench path for creating one
valid Company Workspace. It replaces manual copying from a fixture or legacy
company with a maintained, version-matched authoring baseline. The primary
human entrypoint is the interactive Workbench CLI command
`companyos create workspace`. The experimental implementation also provides a
bounded answers-file transport used by the shared Codex and Claude Code
bootstrap runbook.

Normative requirements use stable `CWG-*` identifiers. The experimental local
generator implements Workspace creation only. It does not authorize Git
hosting changes, provider provisioning, deployment, or operating automation.
Those responsibilities belong to the separately planned and confirmed
`companyos setup --profile vercel-neon-slack` state machine; separating the two
keeps an authoring-only request local while allowing the complete agent runbook
to continue through a live supervised starter.

## 1. Product outcome and limits

**CWG-PROD-001 — One maintained entrypoint.** The Workbench MUST provide the
interactive `companyos create workspace` command, which creates the minimum
CompanyOS v0.7 Workspace structure without requiring a Contributor to know
flags or copy a fixture, another company, or files from Oregano Core manually.

**CWG-PROD-002 — Honest initial mode.** Version 0.1 MUST create only an
`authoring-only` Workspace. It MUST NOT invent an operating agent, executable
workflow, Tool grant, connection binding, provider account, approval, or
Instance merely to pass validation.

**CWG-PROD-003 — Local proposal boundary.** The generator writes only inside
the explicitly selected new Workspace directory. It MUST NOT create or mutate
a GitHub repository, hosted ruleset, remote branch, pull request, Core checkout,
Company Instance, provider account, secret, or runtime state.

**CWG-PROD-004 — Version-matched output.** Generated files MUST conform to the
CompanyOS specification, Workbench version, and exact Core checkout that the
generator reports. The command MUST fail rather than write a guessed, floating,
or unverifiable Core pin.

## 2. Interactive Workbench CLI command and intake

The primary Human Contributor entrypoint is:

```bash
companyos create workspace
```

The Workbench CLI routes this command to a deterministic intake
controller backed by the same typed creation library that later non-interactive
CLI and automation modes use. The agent bootstrap is an ordinary Codex or
Claude Code prompt plus a versioned runbook, not a Workbench chat interface,
slash-command host, Builder, Runner, plugin, or operating company Agent.

The CLI asks one focused terminal question at a time. It validates each answer
before advancing and repeats the same question with a concrete correction when
the answer is invalid. The required intake is:

| Order | Stored field | CLI question and behavior |
|---|---|---|
| 1 | `company.name` | Ask for the company display name; there is no default. |
| 2 | `workspace.slug` | Propose a normalized stable slug from the name and require confirmation or correction. |
| 3 | `company.language` | Ask for the primary working language and store its normalized language code; a host-locale suggestion still requires confirmation. |
| 4 | `company.timezone` | Ask for the company timezone and accept only a valid IANA timezone; a local-timezone suggestion still requires confirmation. |
| 5 | `steward.name` | Ask which accountable human is the initial Workspace Steward; there is no default. |
| 6 | `steward.id` | Propose a stable member ID from the Steward name and require confirmation or correction. |
| 7 | `repository.codeowner` | Ask for one GitHub user or team in CODEOWNERS syntax. Syntax is checked locally; hosted identity verification remains manual. |
| 8 | `target_directory` | Propose `<workspace-slug>-companyos` in the selected parent and require confirmation of the safe local target. |

The initial role is fixed as `workspace-steward`; the Contributor is not asked
to design a new role during bootstrap. The CLI MUST NOT assume that the
Steward and CODEOWNER are the same principal. The exact Core repository,
actual checkout commit, and contained Workbench version are derived from the
verified Core checkout and are displayed, not asked as ordinary questions.
The specification version and `authoring-only` mode are generator-controlled
facts.

After intake, the CLI presents one complete preview containing the
normalized answers, exact Core and Workbench identity, planned target, planned
file list, fixed `authoring-only` mode, and validation result. It asks for one
explicit final confirmation before writing. Cancellation or rejection at any
point leaves no generated file or partial target. A future non-interactive CLI
or library mode MAY prefill the same typed fields, but it MUST use the same
validation, preview model, creation library, and evidence contract; it is not
the primary Human Contributor interface for version 0.1.

The implemented agent transport accepts one YAML or JSON answer file through
`--answers`, one explicit parent through `--parent`, and exactly one of the
non-mutating `--preview` or hash-bound `--confirm` modes. The runbook requires the
agent to ask the same questions in the same order, mirror the answers, show the
CLI preview, and obtain explicit human confirmation before it submits that
preview's hash. The file contains no secrets and the CLI treats every value as
bounded data.

The generator MUST NOT request or write Slack tokens, provider secrets,
database URLs, Vercel credentials, model credentials, or other secret values.
Provider identities may be added later through a governed roster change and
are required before the corresponding operating capability is approved.

The generator MUST declare `review_mode: steward` with zero required GitHub
approvals, non-mandatory CODEOWNER review, and no bypass. This is a complete
operating-capable review contract, not a temporary bootstrap exception.

## 3. Canonical generated baseline

Version 0.1 produces exactly the minimum authoring structure:

```text
company.md
AGENTS.md
.gitignore
.companyos/
  compatibility.yaml
  governance.yaml
  repository-protection.yaml
  changes/
.github/
  CODEOWNERS
  workflows/
    check.yml
handbook/
  index.md
  roster.md
policies/
  risk-levels.md
  data-retention.md
agents/
  builder/
    instructions.md
workflows/
  .gitkeep
schedules/
  .gitkeep
connections/
  .gitkeep
```

`handbook/roster.md` contains the initial human Steward record. The Builder
entrypoint is `agents/builder/instructions.md`. Its YAML frontmatter contains a
description, the smallest authoring-only `scope`, and an empty `tools` grant
list. It contains no `SOUL.md` or separate `scope.md`.

The generated governance protects its own controls, agent instructions,
roster, policies, connections, Company Tools, GitHub files, and Company entry
points. The repository-protection contract begins with hosted verification
`pending`; generated files never claim that GitHub has applied it.

The generated GitHub check is rendered from `.companyos/compatibility.yaml`,
checks out the exact Core ref, and runs the pinned Workbench validation,
inspection, security, and onboarding commands. Shared actual-checkout identity
verification and broader Core test execution remain later hardening work.
Version 0.1 MUST NOT generate a production deployment workflow for an
`authoring-only` Workspace.

## 4. Determinism and write safety

**CWG-SAFE-001 — No overwrite.** The command MUST refuse a non-empty target
directory. A later merge or repair mode requires a separate approved contract.

**CWG-SAFE-002 — Path containment.** The command MUST reject path traversal,
symlinked targets or parents that escape the selected root, device files, and
ambiguous normalized paths.

**CWG-SAFE-003 — Atomic materialization.** The generator MUST render and
validate the complete candidate in a temporary sibling directory before one
atomic final placement. A failure leaves no partial Workspace.

**CWG-SAFE-004 — Deterministic content.** Identical normalized inputs and the
same exact Core and Workbench pair MUST produce byte-identical files. Ambient
usernames, local paths, current time, caches, environment secrets, network
results, and unrelated repository state MUST NOT enter generated content.

**CWG-SAFE-005 — Preview.** The mandatory pre-confirmation preview MUST return
the complete planned path list, normalized non-secret inputs, exact Core and
Workbench identity, and resulting validation diagnostics without creating the
target. The underlying typed library MUST also support a non-mutating dry-run
for tests and future automation surfaces.

**CWG-SAFE-006 — Postcondition.** Before final placement, the candidate MUST
pass Workspace validation and security checks. Onboarding MUST contain no local
errors and may report only the expected hosted and Instance steps as `manual`
or `deferred`.

**CWG-SAFE-007 — Answers remain data.** Intake values MUST be Unicode-normalized,
bounded, validated by field type, and safely encoded into YAML, Markdown,
CODEOWNERS, and paths. Control characters, unexpected multiline values, and
content that would escape the intended field MUST be rejected. An answer is
never interpreted as an Agent instruction or template fragment.

## 5. Exact Core checkout prerequisite

The generator depends on the same checkout identity verifier required by the
Core-to-Workspace Upgrade contract. In `core-checkout` mode, a shared
deterministic Workbench function must compare:

- the configured `core.repository` with the normalized actual Git remote;
- the configured or proposed `core.ref` with `git rev-parse HEAD`;
- the configured Workbench version with the running Workbench version;
- the checkout's Git availability and material dirty state; and
- the Core repository root used to load schemas, Guides, templates, and code.

A matching Workbench version or a syntactically valid SHA is not sufficient.
Several commits may contain the same Workbench version, and a Contributor can
run the right CLI version from the wrong repository or checkout. Without actual
identity verification, validation may approve one pair while deployment builds
another.

The shared verifier is a prerequisite library, not generator-specific logic.
The generator, `validate`, `onboard`, Upgrade Assessment, company sync, and
deployment preflight MUST consume the same implementation with context-specific
cleanliness requirements.

## 6. Staged implementation plan

The experimental implementation completes the local typed intake, rendering,
atomic materialization, validation, and bootstrap-verification slice. The
maintained live starter consumes this result through a different CLI command
and confirmation contract; it does not weaken `CWG-PROD-003`. Broader shared
checkout identity reuse, upgrade paths, signed public distribution, and generic
Company Instance provisioning remain later stages.

### Stage 0 — Contract alignment

- make `handbook/roster.md` and `agents/<agent-id>/instructions.md` canonical;
- keep `scope` and `tools` in instruction frontmatter;
- remove `SOUL.md` and separate `scope.md` from active contracts;
- maintain one neutral expected-output fixture.

### Stage 1 — Shared checkout identity verifier

- implement a non-mutating `core-checkout` library in the Workbench;
- normalize supported SSH and HTTPS Git remotes to owner/repository identity;
- emit stable diagnostics for missing Git, wrong repository, wrong commit,
  Workbench mismatch, and dirty material input;
- use temporary Git fixtures and no network calls;
- integrate it first into explicit deployment preflight and Upgrade Assessment,
  then into generator and co-checkout validation.

### Stage 2 — Typed intake and interactive CLI command

- define one typed `CreateWorkspaceInput` schema for every required answer and
  every derived Core or generator-controlled fact;
- implement a deterministic one-question-at-a-time intake state machine with
  field-level validation, correction, cancellation, preview, and confirmation;
- route `companyos create workspace` through a thin CLI adapter to that state
  machine and keep filesystem mutation behind confirmed materialization;
- keep question state and normalized non-secret answers inspectable and exclude
  them from runtime or company durable state; and
- prove that prefilling or a future automation adapter cannot skip required
  validation or final authorization.

### Stage 3 — Pure rendering library

- define typed normalized generator inputs;
- render an in-memory path-to-content map from versioned templates;
- keep template data separate from filesystem effects;
- test byte-stable output through golden snapshots;
- expose the same library to the future typed Builder Workbench surface.

### Stage 4 — Safe filesystem materialization

- connect confirmed intake to dry-run, path checks, temporary rendering,
  validation, and atomic placement;
- refuse overwrite and clean temporary output after failure;
- return structured creation evidence to the CLI; and
- show the next accountable manual steps rather than performing them.

### Stage 5 — Golden onboarding proof

- drive `companyos create workspace` through its complete question sequence
  and create a Workspace in a temporary directory in CI;
- initialize a temporary local Git repository only in the test harness;
- prove validation, security, onboarding, and exact-pin checks;
- prove that no operating files, deployment workflow, secrets, or hidden
  provider assumptions were generated;
- compare the generator output with the maintained canonical baseline.

Object generators for agents, workflows, Tools, connections, or Change Plans
are later independent stages. They MUST NOT be hidden inside the initial
Workspace generator.

## 7. Required tests and acceptance

Acceptance requires at least:

- invocation through `companyos create workspace`, exactly one focused terminal
  question at a time, stable ordering, immediate answer validation, and
  correction without losing already confirmed answers;
- required intake for company name, confirmed stable slug, language, timezone,
  Steward name and ID, CODEOWNER, and safe target directory;
- proof that Core identity, specification version, role, and `authoring-only`
  mode are derived or fixed rather than requested as unconstrained answers;
- cancellation and rejected final confirmation with zero filesystem writes;
- a complete preview before confirmation and creation evidence afterward;
- safe encoding of names and identifiers containing punctuation and rejection
  of control characters, multiline injection, and template or frontmatter
  escape attempts;
- one English and one German-working-language Workspace with different IANA
  timezones and Steward identities;
- deterministic byte-identical output for repeated normalized inputs;
- exact expected paths with no `SOUL.md`, `scope.md`, operating agent, workflow,
  Tool grant, connection binding, deploy workflow, or secret file;
- rejection of non-empty targets, traversal, symlinks, missing required inputs,
  invalid slugs, invalid languages, invalid timezones, invalid CODEOWNERS
  principals, mutable Core refs, wrong repository, wrong checkout SHA, dirty
  material input, and Workbench mismatch;
- failure without partial output for rendering or validation errors;
- a generated Workspace that passes `validate` and `security` and whose
  onboarding result is locally ready for hosted setup;
- stable human and JSON diagnostics; and
- proof that generator execution performs no network or provider mutation.

## 8. Deferred decisions

The following remain open beyond the implemented generator slice:

- whether a local `package.json` is generated before the Workbench has a public
  signed distribution;
- the exact stable member-ID format and minimum authoring-only identity fields;
- whether optional local `git init` belongs in a later explicit flag;
- whether the first public template is embedded in the Workbench package or
  loaded from a versioned Core resource bundle; and
- the general Company Instance deployment repository or Workspace-owned CI
  model beyond the bounded `vercel-neon-slack` starter profile.

## 9. Adjacent live-setup boundary

The live setup profile may call the generator library and local bootstrap
verifier, but it MUST preserve their exact preview and atomic-write evidence.
It then creates a separate non-secret setup plan whose hash binds every external
resource name, explicit create-or-adopt mode, cost or
consent gate, and intended production target. External mutation starts only
after that second plan is confirmed.

The transition from `authoring-only` to `operating` is also separate: a pure
operating-starter renderer produces a complete preview and confirmation hash;
the resulting Workspace security change is proposed in GitHub and requires the
CompanyOS check plus the Workspace Steward's exact merge confirmation. Local
generation success never substitutes for that authorization, provider consent,
deployment authorization, or `companyos verify-live` evidence.
