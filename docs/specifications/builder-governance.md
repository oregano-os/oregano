---
document_id: specification.builder-governance
title: Builder Governance Specification
kind: specification
status: draft
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
    - specification.companyos-core-v0.7
    - architecture.security-governance
    - governance.roles
---

# Builder Governance Specification

The Builder Agent changes a Company Workspace from an authorized human request.
It is not yet implemented. This English draft preserves the useful Builder
design while aligning it with the repository split and the stronger Workbench
governance model.

## 1. Scope and authority

The Builder lives under `agents/builder/` in the Company Workspace. It is a
company actor, not a Core developer. It MAY propose changes only inside that
Workspace and MUST NOT edit Oregano Core, Instance infrastructure, secrets,
runtime state, approval evidence, or hosted repository rules.

Any active roster member MAY submit a request. A request is not authority. The
Builder may create a branch, Change Plan, diff, and dry-run evidence, but the
governance class determines who reviews and approves it.

The old term “owner” is replaced by Workspace Steward for Workspace governance
and Process Steward for bounded process behavior. Legal ownership grants no
implicit technical right.

## 2. Change matrix

| Change | Minimum class | Required authority |
|---|---|---|
| Handbook or non-behavioral operational content | content | assigned Process Steward |
| Existing SOP/Skill behavior | behavior | assigned Process Steward |
| Workflow steps, criteria, order, or schedule | behavior; security if authority/effect changes | Process Steward plus Workspace Steward where security applies |
| New workflow | security | Workspace Steward and responsible Process Steward |
| Agent scope or instructions | behavior; security when authority/data expands | Process Steward or Workspace Steward by effect |
| Company Tool, grant, connection, roster, or policy | security | Workspace Steward; plus independent review only when Workspace policy requires it |
| Builder, governance, CODEOWNERS, CI, or protected paths | security | Workspace Steward under the declared review mode |
| Core/module upgrade | security and Instance release | Core release evidence, Workspace Steward, Platform Administrator |

A change inherits the highest class of every file and effect it touches. Diff
classification overrides a lower class claimed by the author.

## 3. Change loop

```text
verified request
  → Change Plan
  → branch and bounded diff
  → deterministic validation
  → isolated replay/dry-run where available
  → consequence summary and evidence
  → required Git-host check and human authorization
  → merge
  → exact-pair deployment
  → verification or compensation
```

The requester chooses deployment timing when policy permits. Existing runs do
not silently change definitions; the Instance records version pinning and
migration behavior.

## 4. Defense in depth

1. **Workbench boundary:** normalized paths, governance class, forbidden
   imports, scope, and Change Plan are checked after model output.
2. **Repository boundary:** CODEOWNERS, protected branches, the declared review
   mode, no force push, and no Contributor bypass rights.
3. **CI boundary:** the real diff is classified against the base revision;
   validation, inspection, tests, and documentation checks must pass.
4. **Runtime boundary:** unattended enforcement mounts only compiled write
   scopes and never grants the Builder production secrets or protected state.

Agent instructions are useful behavior guidance but are not a security
boundary. A claim written into a plan or approval file is not proof that the
required Git-host check or human merge confirmation occurred.

## 5. Workbench access by actor type

All Contributors and CI use the same Workbench contracts and validation engine;
only the interface differs:

| Actor | Required Workbench interface |
|---|---|
| Human Contributor | version-pinned `companyos` CLI |
| General Agent Contributor | version-pinned `companyos` CLI in its bounded development environment |
| CI | non-interactive CLI with explicit Workspace, base revision, and automatic Change Plan discovery |
| Builder Agent | typed, least-privilege Workbench Tools or SDK backed by the same implementation |

The Builder Agent's intended Tool surface is
`workbench.guide`, `workbench.create_change_plan`,
`workbench.validate_change_plan`, `workbench.inspect_diff`,
`workbench.validate_workspace`, and `workbench.security_preflight`. It MUST NOT
receive an unrestricted shell merely to invoke the CLI. A proposal-mode
prototype MAY invoke the CLI inside a restricted sandbox until the typed
interface exists, but that is transitional implementation, not a security
boundary.

The CLI and Builder Tool surface MUST NOT contain separate validation logic.
Both call the same versioned Workbench library so CI, Human Contributors, Agent
Contributors, and the Builder Agent cannot obtain different governance results.

## 6. Tool discovery

The Builder discovers capabilities only through the resolved catalog of the
exact Core revision. It does not infer Tool availability from model knowledge
or browse implementation code. Its read-only discovery operations list
available Tools, describe a Tool, list an agent's resolved grants, and preflight
a proposed grant.

For a requested capability it checks, in order: existing grants; installed
standard Tools; scopes and connections; approved module upgrades; a bounded
Company Tool; then a reported missing Core capability. It never writes a direct
provider integration as a workaround.

## 7. Pilot and graduation

The initial Builder mode is proposal-only: a Human Contributor performs the
merge and deployment after review. Increased automation requires 10–20 accurately
predicted real changes and advances from content to behavior to security only
through a separate approved decision. Production auto-merge is not part of
this draft.

## 8. Required evidence and tests

- prompt injection from company data cannot become a Builder instruction;
- path traversal, symlink, rename, and partial-apply attempts cannot reach
  protected paths;
- actual diff class cannot be understated by the plan;
- security approval follows the declared `steward` or `independent-review` mode;
- denied and failed proposals leave no partial branch effect;
- dry-run cannot reach production providers or state;
- merge/deploy uses the exact reviewed commit pair;
- rollback restores definition and separately tracks compensation for effects.

## 9. Open decisions

- appoint Process Stewards and Workspace Stewards for each pilot Workspace;
- choose the isolated preview data and provider topology;
- define authenticated external approval evidence for future automated merges;
- implement the catalog/resolver before Tool discovery or grant changes;
- approve the exact graduation metrics beyond proposal-only mode.
