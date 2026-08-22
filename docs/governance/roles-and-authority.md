---
document_id: governance.roles
title: Roles and Authority
kind: governance
status: approved
authority: canonical
language: en
updated: 2026-08-22
owners:
  - oregano-maintainers
audience:
  - human
  - agent
---

# Roles and Authority

## Participation is not authority

CompanyOS Contributor is the umbrella participation term. A Contributor may be
a Human Contributor or Agent Contributor and may work as a Workspace
Contributor or Core Contributor. None of those actor or placement labels grants
approval authority. Authority comes only from the roles below and their active
assignment.

| Role | Authority | Does not imply |
|---|---|---|
| Workspace Steward | Approves protected Company Workspace governance changes | legal ownership or Git administration |
| Process Steward | Reviews behavior of an assigned workflow or SOP | authority over unrelated policies or Core |
| Platform Administrator | Administers technical hosting through separately assignable `repository` and `instance` scopes | business approval authority or permission to rewrite Workspace policy |
| Oregano Maintainer | Changes Oregano Core, schemas, and Workbench releases | authority to decide company-specific policy |

A person may hold more than one role, but systems and reviews must name the
authority being exercised rather than infer it from account privileges.

The Platform Administrator `repository` scope covers Git-host access,
CODEOWNERS, rulesets, branch protection, and hosted merge controls. The
`instance` scope covers runtime hosting, StateStore resources, provider
installations, secrets, deployment, observability, backup, and recovery. One
person may hold both scopes; a larger company may assign them to different
people without creating a new CompanyOS role.

## GitHub mapping

GitHub's `CODEOWNERS` is a technical routing and merge-protection mechanism,
not a CompanyOS authority model. The recommended mapping is:

| Protected path | CompanyOS authority | GitHub mapping |
|---|---|---|
| `.companyos/`, policies, roster, Tools, CI | Workspace Steward | visible team such as `@company/workspace-stewards` |
| bounded workflow or SOP | assigned Process Steward | corresponding visible process team where practical |
| repository rules and access | Platform Administrator with `repository` scope | GitHub admin/custom role; not automatically a CODEOWNERS approval |

One person may initially occupy several roles, but the assignments remain
separate so they can later be delegated without changing the architecture.
The default Workspace `review_mode: steward` requires no second person and no
ruleset bypass. An optional `independent-review` policy may be selected only
when a genuinely distinct authorized reviewer exists.

## Approval, merge, and deployment

Approval, merge execution, and deployment authorization are separate actions:

- a Process or Workspace Steward supplies the required business or governance
  approval;
- a Human Contributor may enable auto-merge or execute a permitted merge after
  every hosted gate passes; CompanyOS defines no separate Merger role; and
- a Platform Administrator with `instance` scope authorizes deployment to a
  named Company Instance while a least-privilege deployment identity performs
  the technical action.

The same human may perform more than one of these actions when assigned the
corresponding authority. In the default Workspace `steward` mode and Core
`maintainer` mode, that human may authorize a checked change they initiated.
An `independent-review` policy adds author/reviewer separation explicitly; it
is not assumed merely because a change is security-class.
