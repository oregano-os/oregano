---
document_id: specification.core-workspace-upgrades-v0.1
title: Core-to-Workspace Upgrades v0.1
kind: specification
status: draft
authority: normative
language: en
updated: 2026-08-22
owners:
  - oregano-maintainers
  - product-owner
audience:
  - human
  - agent
availability: planned
relations:
  depends_on:
    - vision.companyos
    - architecture.company-workspace
    - architecture.company-instance
    - architecture.validation-inspection
    - compatibility.index
    - specification.companyos-core-v0.7
    - specification.builder-governance
---

# Core-to-Workspace Upgrades v0.1

This draft defines the future product and implementation contract for moving one
Company Workspace and Company Instance from one exact Oregano Core and Workbench
pair to another. It records requirements for deliberate assessment, migration
proposals, approval, deployment, evidence, and rollback without claiming that an
upgrade command, public release channel, or migration engine exists today.

Stage 1, read-only Upgrade Assessment, is the first proposed build target. Stage
2, Migration Proposal, and Stage 3, Instance Migration Assistance, are deferred
extensions with explicit promotion gates. Approval of this draft would authorize
planning against these requirements; it would not authorize an automatic
Workspace mutation, merge, deployment, or Instance state change.

Normative requirements use stable `CWU-*` identifiers. A behavioral change to an
approved requirement must retain traceability through the applicable Core Change
Plan, compatibility evidence, tests, documentation, and migration guidance.

## 1. Product outcome and limits

**CWU-PROD-001 — Deliberate upgrade.** CompanyOS MUST let a Contributor assess
and eventually propose an upgrade for one exact Company Workspace without
silently changing the Core, Workbench, Workspace, or Company Instance versions
that currently operate.

**CWU-PROD-002 — Safe lag.** Publication or discovery of a newer Core MUST NOT
alter an existing Workspace pin. A Workspace MAY remain on an older supported
pair until its accountable humans approve an upgrade. Security support and
revocation policy MAY prevent a new activation but MUST NOT rewrite a Workspace.

**CWU-PROD-003 — Explicit target.** Every assessment and proposal MUST identify
an exact current Core commit, target Core commit, current Workspace commit, and
the exact Workbench versions involved. Mutable branches, floating tags,
`latest`, and silent fallback are not valid upgrade inputs.

**CWU-PROD-004 — No universal automatic migration.** CompanyOS MUST distinguish
changes that require only a pin update from Workspace file migrations, Company
Instance migrations, and unsupported manual upgrades. It MUST NOT represent all
Core changes as safely automatable.

**CWU-PROD-005 — Initial non-goals.** The initial capability excludes automatic
file mutation, arbitrary release-provided code execution, automatic approval,
automatic merge, production deployment, provider-account mutation, secret
mutation, and durable-state migration.

## 2. Version and authority model

**CWU-VERS-001 — Separate version identities.** An upgrade MUST keep these
identities distinct:

- immutable Core commit;
- exact Workbench version contained by that Core commit;
- implemented CompanyOS specification version;
- immutable Company Workspace commit; and
- immutable deployed artifact and Company Instance environment.

A marketing release label or Git tag MUST NOT replace any required immutable
identity.

**CWU-VERS-002 — Workspace-owned selection.** The Company Workspace owns its
selected Core and Workbench pin through `.companyos/compatibility.yaml`. Core
release publication supplies candidates and evidence but does not grant itself
authority to change that file.

**CWU-AUTH-001 — Core responsibility.** Oregano Maintainers own Core release
evidence, compatibility declarations, supported migration paths, migration
guidance, and the conformance evidence for any Core-owned deterministic
transformation.

**CWU-AUTH-002 — Workspace responsibility.** A Core or module upgrade is a
security-class Workspace change. The Workspace Steward approves the selected
target, the Workspace diff, the consequences, and the rollback plan under the
Company Workspace governance policy.

**CWU-AUTH-003 — Instance responsibility.** A Platform Administrator approves
deployment timing and every environment, provider, secret, durable-state, or
rollback action. A Workspace approval alone MUST NOT authorize an Instance
migration.

**CWU-AUTH-004 — Separation of authority.** An upgrade tool, Oregano Maintainer,
Package, migration artifact, or Agent Contributor MUST NOT approve its own
Workspace proposal or Instance release. Generated evidence is input to human
review, not authority.

## 3. Core release and migration evidence

**CWU-REL-001 — Immutable release evidence.** A selectable target release MUST
identify its exact Core commit and Workbench version and MUST make its release
evidence attributable to Oregano Maintainers. The future public distribution
mechanism MUST preserve integrity and provenance; its signing and publication
design remains an open decision.

**CWU-REL-002 — Material change declaration.** Release evidence MUST describe
changed public contracts, Workspace schemas, validators, standard Tools,
deployment assumptions, Instance contracts, security behavior, and removed or
deprecated behavior that can affect an upgrade decision.

**CWU-REL-003 — Migration path declaration.** For every supported source-to-target
path, Core MUST state whether the path is:

- compatible and expected to require only a reviewed pin change;
- a Workspace migration requiring a reviewed file diff;
- an Instance migration requiring environment or durable-state work;
- a combined Workspace and Instance migration; or
- unsupported and therefore manual or blocked.

The final machine-readable vocabulary and schema are deferred, but an
implementation MUST preserve these distinctions.

**CWU-REL-004 — Evidence, not assertion.** A release MUST NOT claim a supported
migration path without relevant fixtures, validator coverage, migration tests,
known limitations, and rollback or compensation guidance. Empty test references
or prose-only compatibility claims are not sufficient evidence.

**CWU-REL-005 — No arbitrary migration code.** Upgrade assessment MUST NOT
execute lifecycle scripts or arbitrary code obtained from a release. A later
deterministic transformation format requires a separately approved contract,
path and resource boundaries, fixtures, and adversarial tests.

## 4. Stage 1 — read-only Upgrade Assessment

**CWU-ASSESS-001 — Read-only operation.** Stage 1 MUST inspect the exact current
pair, target pair, Workspace files, governance, and available release evidence
without modifying the Workspace, Core checkout, Git history, Company Instance,
or external provider state.

**CWU-ASSESS-002 — Exact checkout verification.** The assessor MUST prove that
the running Workbench comes from the declared target Core commit and that its
reported version matches the target compatibility contract. A syntactically
valid SHA or matching Workbench version alone is insufficient.

**CWU-ASSESS-003 — Impact report.** The assessment result MUST report at least:

- current and target immutable version identities;
- supported, unsupported, and unverified compatibility claims;
- affected contracts and requirement identifiers when published;
- expected Workspace files and Instance concerns;
- required human decisions and approval roles;
- required validation, tests, dry runs, and external checks;
- rollback and compensation constraints; and
- every missing input that prevents a safe proposal.

**CWU-ASSESS-004 — Deterministic result.** Identical material inputs MUST produce
the same machine-readable findings and compatibility verdict. Human judgment MAY
augment the report but MUST remain distinguishable from deterministic evidence.

**CWU-ASSESS-005 — Skipped versions.** A direct upgrade across multiple releases
is supported only when Core publishes and tests that exact path or a complete,
ordered migration chain. Missing, ambiguous, cyclic, revoked, or incompatible
steps MUST fail closed and require manual planning.

**CWU-ASSESS-006 — No selection by discovery.** An update notification,
Registry result, repository default branch, popularity signal, or newest version
MUST NOT select the target. A Contributor must explicitly select the immutable
target before assessment.

## 5. Governed manual upgrade loop

**CWU-FLOW-001 — Proposal boundary.** A real upgrade begins with a Company
Workspace Change Plan and a branch. The approved plan identifies the target
pair, expected Workspace and Instance changes, approvals, validation, tests,
release evidence, rollout, rollback, and open decisions.

**CWU-FLOW-002 — Pair migration.** `core.ref` and `workbench.version` MUST be
updated together. Any required Company Workspace schema, policy, Agent,
Workflow, Tool, grant, or connection declaration change belongs in the same
reviewed proposal or in an explicitly ordered prerequisite proposal.

**CWU-FLOW-003 — Exact-pair CI.** CI MUST check out the target Core by the
declared immutable ref, verify the actual checkout identity, and validate and
inspect the exact proposed Workspace commit with that Workbench. Validation
failure blocks merge and deployment.

**CWU-FLOW-004 — Consequence review.** The proposal MUST distinguish a validator
format change from a company behavior change, authority expansion, effect-risk
change, Instance dependency, and existing-state consequence. Passing structural
validation does not prove business or production readiness.

**CWU-FLOW-005 — Exact-pair release.** Deployment MUST consume only the reviewed
Core and Workspace commits and MUST record the resulting provenance required by
the Company Instance contract. Existing runs do not silently adopt new
definitions.

## 6. Stage 2 — Migration Proposal

Stage 2 is a planned extension, not part of the first implementation target.
Its purpose is to turn proven migration evidence into a reviewable proposal,
never to create authority.

**CWU-PROP-001 — Deterministic proposal.** A Migration Proposal MAY generate a
Change Plan and candidate Workspace diff only from an approved deterministic
migration contract applicable to the exact source and target versions.

**CWU-PROP-002 — Full preview.** Every proposed addition, modification, rename,
and deletion MUST be visible before application. The proposal MUST identify
which changes come from Core migration rules and which require company-specific
human judgment.

**CWU-PROP-003 — Ownership and drift.** The proposer MUST preserve company-owned
content and detect edits, collisions, unexpected file ownership, symlink or path
escape, partial prior migration, and source drift. An ambiguous or destructive
case MUST stop without a partial apply.

**CWU-PROP-004 — Optional Git delivery.** A later implementation MAY create a
bounded branch and pull request after producing the same local proposal. Its
credentials MUST be scoped to that Workspace. Creating a branch or pull request
MUST NOT approve, merge, deploy, or change hosted protection.

**CWU-PROP-005 — No hidden mutation.** A generated proposal MUST remain
reproducible from recorded inputs. It MUST NOT modify secrets, external provider
state, durable runtime state, or another repository as a side effect.

**CWU-PROP-006 — Promotion gate.** Stage 2 requires accepted Stage 1 evidence,
at least one repeated real manual migration class, an approved transformation
contract, plan-integrity and path-safety tests, collision and drift tests, and
evidence that proposal generation can fail without partial effects.

## 7. Stage 3 — Instance Migration Assistance

Stage 3 is a separate deferred capability. It MUST NOT be implied by successful
Workspace proposal generation.

**CWU-INSTANCE-001 — Separate plan.** Instance migration assistance MUST produce
an environment-specific plan distinct from the Workspace diff. Secrets,
credentials, provider account identifiers, and live state remain outside Git.

**CWU-INSTANCE-002 — Preflight and recovery.** Before a stateful migration, the
plan MUST identify backups, recovery evidence, deployment isolation, health
checks, cutover authority, rollback or forward-compensation limits, and the
owner of each manual action.

**CWU-INSTANCE-003 — No generic automatic execution.** Assessment or Workspace
approval MUST NOT automatically execute an Instance migration. Any later
execution support requires a separately approved effect contract, exact-action
authorization, idempotency, evidence, and Platform Administrator control.

**CWU-INSTANCE-004 — Promotion gate.** Stage 3 requires a real operating
Instance need, an approved environment and state migration contract, tested
backup and recovery, dry-run isolation, observable health criteria, and a
separate Core Change Plan.

## 8. Rollback, support, and failure behavior

**CWU-ROLL-001 — Source rollback.** A Workspace rollback restores a previously
reviewed Core and Workbench pin together with the compatible Workspace files.
It MUST NOT mix a new Workspace contract with an incompatible older validator.

**CWU-ROLL-002 — Deployment rollback.** A production rollback points to a
previously recorded immutable deployment artifact. It MUST NOT rebuild old
commits with current dependencies.

**CWU-ROLL-003 — State consequence.** A migration that cannot safely restore
prior durable state MUST declare that limitation before approval and provide a
forward recovery or compensation plan. Source rollback MUST NOT be presented as
state rollback.

**CWU-SUPPORT-001 — Support visibility.** Core release policy MUST eventually
declare supported source versions, deprecation windows, security exceptions,
and removal gates. Until that policy exists, the assessor MUST report support
as unknown rather than infer it.

**CWU-SUPPORT-002 — Failure is non-mutating.** A failed assessment or proposal
MUST leave the current Workspace pin, files, Git history, and Instance state
unchanged. Diagnostics MUST retain enough evidence to reproduce the failure.

## 9. Required acceptance evidence

**CWU-TEST-001 — Stage 1 fixtures.** Acceptance for Stage 1 requires neutral
fixtures for pin-only, Workspace migration, Instance migration, combined,
unsupported, missing-evidence, and revoked-target cases.

**CWU-TEST-002 — Exact identity tests.** Tests MUST reject a mutable ref, wrong
repository, checkout SHA mismatch, Workbench version mismatch, dirty material
input, and a release label that does not resolve to the declared immutable
commit.

**CWU-TEST-003 — Migration-chain tests.** Tests MUST cover one-step upgrades,
supported skipped-version chains, missing intermediate steps, incompatible
paths, and cycles.

**CWU-TEST-004 — Stage 2 adversarial tests.** Before Stage 2 promotion, tests
MUST cover company-owned edits, collisions, rename and delete behavior, path
traversal, symlinks, malicious migration content, repeated proposal generation,
source drift, and failure without partial writes.

**CWU-TEST-005 — Authority tests.** Evidence MUST prove that assessment,
proposal generation, branch creation, and pull-request creation cannot grant an
approval, bypass CODEOWNERS or hosted protection, merge, deploy, or reach
Instance credentials.

**CWU-TEST-006 — Status distinction.** Passing documentation checks or an
Upgrade Assessment MUST NOT be represented as a completed Workspace migration,
validated Company Instance, enforced deployment, or implemented later stage.

## 10. Development stages and promotion gates

| Stage | Planned outcome | Mutating authority | Promotion condition |
|---|---|---|---|
| 1. Upgrade Assessment | Read-only compatibility and impact report for one exact source, target, and Workspace | none | approved requirements, release-evidence contract, deterministic fixtures, and exact-checkout enforcement |
| 2. Migration Proposal | Reviewable Change Plan and Workspace diff; optional bounded branch and pull request | Workspace proposal only | Stage 1 operational evidence plus approved transformation, ownership, drift, and path-safety contracts |
| 3. Instance Migration Assistance | Environment-specific preflight, dry-run evidence, and recovery plan | no implicit execution authority | real operating need plus approved Instance migration, effect, backup, and recovery contracts |

Implementation MUST proceed one stage at a time. Work on a later stage MUST NOT
weaken an earlier stage or convert a proposal into implicit authority.

## 11. Deferred product and implementation decisions

The following decisions remain open and MUST NOT be resolved silently during
implementation:

- public Core and Workbench release channel, signing, and provenance;
- machine-readable release, compatibility, and migration artifact schemas;
- compatibility support windows and security exception policy;
- command names and user experience for assessment and proposal;
- local-only versus hosted release discovery;
- GitHub application, GitHub Actions, or provider-neutral pull-request delivery;
- fleet-level notification and assessment across multiple Company Workspaces;
- whether and when deterministic transformations may be applied locally; and
- the first real operating Instance migration that justifies Stage 3.
