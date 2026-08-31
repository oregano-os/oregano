---
document_id: guide.plan-change
title: Plan a Change
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-08-31
owners:
  - oregano-maintainers
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

New plans use Change Plan version 2. Before implementation, the author must:

1. state what Core, Packages or Blueprints, the Company Workspace, and the
   Company Instance each own, including an explicit no-change statement where
   appropriate;
2. review each governed existing-mechanism family and choose `reuse`, `extend`,
   or `not-applicable` with a reason;
3. list genuinely new Core mechanisms only in a Core plan;
4. confirm that Core contains no company values, Git contains no secrets, and
   Core fixtures are synthetic; and
5. explain why Core work is reusable across companies, or why the plan changes
   no Core mechanism.

The governed existing-mechanism catalog currently covers AgentResolver,
ToolSetResolver, ModelRecipeResolver, Company Records, identity and
authorization, timers and business time, approvals/effects/idempotency, and
Capability Contracts/Connectors. This is a mandatory search for reuse, not a
claim that every mechanism applies to every plan.

Use `companyos plan --output <path>` to create a template and
`companyos plan --check <path>` to validate a completed plan.

Version 1 plans dated on or before 2026-08-31 remain valid historical evidence.
They are not rewritten. A later plan must use version 2.

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
