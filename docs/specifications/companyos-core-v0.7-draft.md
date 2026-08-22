---
document_id: specification.companyos-core-v0.7
title: CompanyOS Core Specification v0.7
kind: specification
status: building
authority: normative
language: en
updated: 2026-08-22
owners:
  - oregano-maintainers
audience:
  - human
  - agent
relations:
  depends_on:
    - vision.companyos
    - architecture.overview
    - architecture.boundaries
---

# CompanyOS Core Specification v0.7

This document is the English build target for the next CompanyOS contract. It
consolidates the approved repository split and the new Workbench control plane.
It is marked `building`: requirements in sections already implemented are
testable, while unresolved migration questions remain explicitly listed below.

Normative words `MUST`, `MUST NOT`, `SHOULD`, and `MAY` carry their usual
requirements meaning.

## 1. System model

CompanyOS is the complete system. It consists of:

1. **Oregano Core** — the generic executable platform, schemas, validators,
   governance primitives, runtime adapters, and Workbench distribution.
2. **Company Workspace** — one company's versioned operating model: identity,
   people and agent roles, policies, workflows, knowledge, connections, and
   company-owned Tools.
3. **Company Instance** — one exact Core revision and one exact Workspace
   revision running in a named environment with its infrastructure, secrets,
   configuration, and state.
4. **CompanyOS Workbench** — the supported interface used by people and agents
   to plan, author, validate, inspect, and secure changes.

The open Package ecosystem is a supporting distribution plane, not a fifth
operational authority layer. It distributes Blueprint, Tool, and Connector
Packages against Core-owned contracts. A Package Registry owns no Company
Workspace grant, Company Instance binding, approval, activation, or effect
authority.

Core and Workspace MUST be separate repositories in production. A Workspace
MUST contain company convention and MUST NOT contain generic runtime
infrastructure. Core MUST NOT contain a generated or copied company snapshot as
an authoritative source.

## 2. Operational readiness dimensions

CompanyOS does not assign one global maturity profile to a Workspace. Readiness
is scoped to the artifact and environment that can actually demonstrate it.

A Company Workspace MUST declare exactly one `workspace_mode`:

| Workspace mode | Meaning |
|---|---|
| `authoring-only` | The governed operating model may be authored and reviewed; no operating agent or executable workflow is permitted. |
| `operating` | The Workspace contains at least one operating agent and workflow and may be evaluated for execution against a concrete Instance. |

Every workflow MUST independently declare one `execution_mode`:

| Execution mode | Meaning |
|---|---|
| `supervised` | Execution requires an accountable operator able to observe, stop, and recover the run. |
| `unattended` | Execution may proceed without a continuously present operator only after technical enforcement and runtime evidence are verified. |

Instance readiness is derived, not self-declared. The Workbench evaluates the
exact Core, Workspace, workflow, resolved ToolSet, Instance configuration, and
environment as `declared`, `validated`, or `enforced`. `validated` permits only
the execution modes whose dependencies and controls were checked. `enforced`
additionally requires the runtime to enforce compiled scopes, approval gates,
effect safety, evidence, and recovery contracts.

Legacy `conformance: profile-a|b|c` and `target: profile-*` fields are invalid.
A roadmap target belongs in a Change Plan or product plan, not in the deployed
Workspace contract. No label may substitute for evidence.

## 3. Company Workspace structure

The canonical top-level structure is:

```text
company.md
AGENTS.md
.companyos/
  governance.yaml
  changes/
agents/
  roster.md
  <agent-id>/
    SOUL.md
    scope.md
    tools/
workflows/
policies/
handbook/
connections/
brain/
```

Additional directories MAY be introduced by an approved specification or
Workspace governance. Agents MUST NOT invent an alternative location for data
that already has a canonical home.

`company.md` MUST identify the company, its Workspace schema version, runtime
language, and `workspace_mode`. `AGENTS.md` MUST be a thin agent
entrypoint and MUST link to the canonical governance and Workbench guidance.

Every Workspace MUST declare `.companyos/compatibility.yaml` and
`.companyos/repository-protection.yaml`. In co-checkout mode the compatibility
contract MUST pin an immutable Core commit and exact Workbench version. A
floating branch is not a compatibility contract. The protection contract MUST
declare the minimum hosted ruleset, while provider-side verification remains a
Platform Administrator responsibility exercised through the `repository`
scope.

When Blueprint or Tool Packages are installed, the Workspace MUST version their
exact origin and managed-file or Tool provenance in the Workspace Package lock.
Package installation remains a governed Workspace change and MUST NOT assign
principals, approvals, active grants, Instance bindings, or secrets.

An `authoring-only` Workspace MUST contain no operating agents or executable
workflows. It still keeps the required directory tree and Builder Agent
entrypoint. Validators MUST NOT force placeholder automation merely to make
onboarding pass. Changing to `operating` is a protected operating-model change
and requires at least one valid operating agent and workflow in the same change.

## 4. Roles and authority

CompanyOS separates legal ownership from operational access authority.

- **Workspace Steward** governs the Workspace contract and approves protected
  behavior and security changes.
- **Process Steward** owns a specific business process and its acceptance
  criteria.
- **Platform Administrator** manages technical hosting through separately
  assignable `repository` and `instance` scopes. The `repository` scope covers
  Git access and protection; the `instance` scope covers deployment
  infrastructure, StateStore resources, providers, secrets, and recovery.
- **Oregano Maintainer** governs generic Core behavior.

Role assignments MUST resolve to active identities. A role label MUST NOT imply
legal company ownership unless the company explicitly models that separate
fact. One person MAY hold both Platform Administrator scopes or several roles,
but every action MUST identify the authority being exercised.

A Company Workspace MUST declare `review_mode: steward` or
`review_mode: independent-review`. The maintained default is `steward`: one
Workspace Steward MAY authorize their own security change only through a pull
request after required CI passes and with no repository bypass. The optional
`independent-review` mode MUST require a distinct authorized approver for
security changes. Oregano Core uses `review_mode: maintainer`: one accountable
Oregano Maintainer may authorize a checked Core change without a second person.

## 5. Agents, workflows, and human boundaries

Every operating agent MUST have a stable identifier, purpose, scope, allowed
inputs, allowed outputs, escalation route, and explicit Tool grants.

Every executable workflow MUST define:

- trigger, goal, owner, and process boundary;
- ordered steps and expected outputs;
- human decision points;
- effect risk and approval requirements;
- verification evidence;
- failure handling and rollback or compensation.

Human decisions MUST be modeled as human decisions, not as agent risk levels.
The effect that follows a human decision retains its own R0–R4 classification.

## 6. Risk and approval

| Risk | Meaning | Minimum control |
|---|---|---|
| R0 | Read-only computation | No approval |
| R1 | Reversible internal write | Policy-defined authority |
| R2 | Material but bounded internal effect | Explicit grant and evidence |
| R3 | External, financial, customer-facing, or difficult-to-reverse effect | Approval bound to exact action |
| R4 | Irreversible, high-impact, regulated, or existential effect | Strong human approval and separation of duties |

Risk MUST be assigned to the concrete effect, not merely the workflow or Tool.
An approval MUST bind approver identity, subject, exact payload or payload hash,
risk, expiry, and idempotency key. Any material payload change invalidates the
approval. Approval consumption and effect claiming MUST be atomic for every
unattended effect and for any supervised effect whose failure could duplicate a
material external action.

## 7. Tool and Capability architecture

A **Tool** is an agent-callable operation with a stable ID, contract, risk
metadata, and implementation. A **Capability Contract** is a provider-neutral
Core interface that a Connector may implement and a Tool may require. A Tool is
not itself a provider binding, Package installation, grant, approval, or generic
Capability Contract.

Local Company Tools live in the Workspace. Published Tool Packages use the same
restricted Tool SDK and authority boundary. Connector Packages live in the
Company Instance and MUST NOT introduce provider code into the Workspace.

The effective ToolSet MUST be resolved fail-closed from:

1. the Core capability catalog,
2. Workspace Tool declarations,
3. exact installed Package versions and contracts,
4. the agent's explicit grants,
5. Instance Connector implementations and bindings, and
6. Instance configuration and policy restrictions.

Unknown grants, ambiguous Tool IDs, missing implementations, or unavailable
Instance dependencies MUST fail validation. Workspace Tool implementations MUST
NOT bypass the approved runtime boundary by loading secrets directly, invoking
provider SDKs directly, or making undeclared network calls.

Any executing workflow requires a deterministic ToolSet manifest. Unattended
execution additionally requires its hash in build and execution provenance and
technical runtime enforcement that only the resolved set is callable.

## 8. Identity and retention

Human and agent identities MUST be stable and auditable. Historical identities
referenced by evidence, approvals, or decisions MUST NOT be deleted. Offboarding
MUST deactivate the identity and remove rights while retaining history.

Authorization MUST be derived from current active role assignments and explicit
grants, not from display names or repository authorship. Instance credentials
MUST NOT be committed to Core or Workspace.

## 9. State, evidence, and effects

Version-controlled company convention belongs in the Workspace. Runtime state,
approvals, observations, effect claims, and execution evidence belong to the
Instance's durable stores.

Every controlled effect MUST have:

- an idempotency key;
- a durable lifecycle state;
- an immutable or append-only evidence trail;
- the exact Core and Workspace revisions;
- the resolved ToolSet hash when available;
- outcome and error evidence;
- compensation status where compensation is possible.

Retries MUST NOT create duplicate effects. A completed approval MUST NOT be
reused for a materially different effect.

## 10. Company Instance and deployment provenance

Every deployment MUST identify:

- Instance ID and environment;
- Core revision;
- Workspace revision;
- CompanyOS specification version;
- Workbench version;
- governance hash;
- declared grants hash;
- Workspace Package lock hash when present;
- Instance Package ledger hash when present;
- resolved ToolSet hash when implemented.

Production deployment MUST validate the exact checked-out Workspace before it is
synchronized into the build. Generated company artifacts are build products,
never sources of truth. Production and non-production Instances SHOULD isolate
secrets and durable state; any shared topology requires an explicit risk
decision.

## 11. Workbench and Change Plans

Workbench is the supported development interface for Core and Workspace work.
Its initial command surface is:

```text
companyos guide
companyos plan
companyos inspect
companyos validate
companyos security
companyos docs
```

Behavior and security changes MUST begin with a machine-readable Change Plan.
The plan MUST identify placement, objective, non-goals, change class, expected
files, required approvals, validation, tests, documentation impact, rollback,
and open decisions. Inspection MUST compare the proposed change with the
CompanyOS vision, system boundaries, governance class, and actual changed files.

## 12. Governance invariants

A Workspace governance policy MUST:

- declare that Workspace rules may only tighten Core invariants;
- classify content, behavior, and security paths;
- define required approvals for protected classes;
- protect itself and agent entrypoints as security-class artifacts;
- define whether the Workspace uses Steward approval or independent review;
- remain enforceable outside any individual Agent Contributor.

Repository permissions, required CI, protected branches, and CODEOWNERS SHOULD
enforce the local policy on the hosting platform. Local files alone are not a
security boundary against an administrator with write access.

In `review_mode: steward`, repository protection MUST require zero GitHub
approvals and MUST NOT require CODEOWNER review; the Change Plan and explicit
human merge confirmation record the Steward's authority. In
`review_mode: independent-review`, `two_person_review` means the author plus at
least one independent authorized reviewer, repository protection MUST require
one CODEOWNER approval, and the author MUST NOT be the sole approver.
CODEOWNERS maps paths to technical GitHub owners but does not itself grant
CompanyOS authority.

## 13. Validation and inspection

Deterministic validation MUST cover at least:

- required structure and document metadata;
- identity and role references;
- workflow ownership and human boundaries;
- Tool declarations and grants;
- governance completeness and self-protection;
- secret and forbidden-runtime-access patterns;
- Change Plan completeness;
- documentation registry and links;
- exact build provenance inputs;
- immutable Core and Workbench compatibility pins;
- the declared repository-protection baseline and onboarding files.

Validation is pass/fail contract enforcement. Inspection adds architectural
judgment and MAY require human review. A successful validator does not by itself
prove business correctness, security, or production readiness.

## 14. Documentation and language

Canonical engineering documentation, schemas, code identifiers, commands,
commit-facing metadata, and agent instructions MUST be English. Company runtime
content MAY use the language declared by that Workspace.

The canonical documentation tree is `docs/`. Every active document MUST have
machine-readable status, authority, ownership, language, and audience metadata.
Documentation changes are part of the same change and Definition of Done as the
behavior they describe. Historical root files and migration sources MUST link
to the canonical tree and MUST NOT become competing active truth.

The same-change rule explicitly includes onboarding. Any modification to
required files, setup commands, compatibility, Git protection, CI, or Instance
preparation MUST update the canonical onboarding path and its deterministic
Workbench checks.

## 15. Open migration questions

The following are not silently decided by this draft:

1. Oregano Core, Registry implementation, and public Package license policy;
2. Package publisher identity, signing, transparency, scanning, and revocation mechanisms;
3. Package Registry transport, storage, mirroring, and federation;
4. the complete Core capability catalog and deterministic resolver;
5. the approved production/staging infrastructure isolation topology;
6. normalization of legacy human-step risk notation;
7. line-by-line approval of the remaining German source translations;
8. exact graduation criteria for moving a Company Tool into Core.

These questions are tracked in the Translation Exception Report and MUST remain
visible in inspection until resolved by the appropriate authority.
