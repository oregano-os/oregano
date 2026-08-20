---
document_id: guide.plan-change
title: Plan a Change
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-08-19
owners:
  - core-maintainers
audience:
  - human
  - agent
availability: experimental
---

# Plan a Change

A formal Change Plan is required for behavior and security changes. The agent
provides the reasoning; the Workbench provides and validates the structure.

The plan records objective, non-goals, placement, change class, affected Vision
principles, expected files, required approvals, validation, tests,
documentation impact, rollback, and open decisions. A plan never grants its
author permission to approve the resulting change.

Use `companyos plan --output <path>` to create a template and
`companyos plan --check <path>` to validate a completed plan.

Inspection discovers a single changed Change Plan automatically. When one pull
request intentionally contains multiple plan files, its description must name
the umbrella plan on a line by itself:

```text
Change-Plan: .oregano/changes/example.yaml
```

A Company Workspace uses the corresponding
`.companyos/changes/example.yaml` path. CI treats the marker only as explicit
selection; the selected plan must still exist, validate, match the actual diff
class, and contain the required approvals. The marker never grants authority.

After a GitHub merge, the target-branch check resolves the uniquely associated
merged pull request and reuses the same marker while inspecting the actual merge
commit. A direct push has no merged pull-request authority and therefore remains
on strict automatic discovery. Ambiguous associations, invalid paths, and
missing plan files fail closed.
