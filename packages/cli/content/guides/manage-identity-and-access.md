---
document_id: guide.manage-identity-access
title: Manage Identity and Access
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-08-22
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
---

# Manage Identity and Access

Use stable identities and explicit active roles. Onboarding assigns only the
minimum required rights and records the responsible approver. Offboarding sets
the identity to inactive and removes rights; it does not delete historical
entries referenced by approvals, evidence, or decisions.

Keep Workspace Steward, Process Steward, Platform Administrator, and legal
ownership distinguishable in policy and evidence. The Platform Administrator
uses separately assignable `repository` and `instance` scopes; one person may
hold both, or a company may split them. A person may also hold more than one
role, but every approval or administrative action records which authority was
exercised.

Contributor status and CODEOWNERS membership are not authority roles. Map each
required Steward to a verified Git identity or team for pull-request routing,
and map Platform Administrators with `instance` scope to the protected
deployment environment. A notification route does not grant the role it
notifies.

The declared review mode determines separation of duties. Default `steward`
mode permits the authorized Steward to approve a checked change they initiated;
optional `independent-review` mode requires a distinct approver. It does not
require a different person for every merge and deployment action. R3/R4 approval
paths retain their stricter effect-specific identity and continuity requirements.

Roster and rights changes are security-class work and require validation of all
workflow human-role references.
