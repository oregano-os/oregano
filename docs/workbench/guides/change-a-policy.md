---
document_id: guide.change-policy
title: Change a Policy
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-08-14
owners:
  - core-maintainers
audience:
  - human
  - agent
availability: experimental
---

# Change a Policy

Policy changes are security-class changes because they can alter authority,
risk, retention, or allowed effects. Create a Change Plan, identify the
Workspace Steward and affected Process Stewards, and state the old and new
rule precisely.

Workspace policy may tighten Core safety defaults but may not weaken them.
Include migration of existing state, evidence retention, rollback limits, and
tests for denied as well as permitted behavior. Never use a policy edit to
retroactively legitimize an action that was unauthorized when performed.
