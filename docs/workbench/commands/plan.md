---
document_id: command.plan
title: companyos plan
kind: command
status: implemented
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

# `companyos plan`

Creates or validates a machine-readable Change Plan.

```bash
companyos plan --output change-plan.yaml --placement workspace
companyos plan --output .oregano/changes/change.yaml --placement core
companyos plan --check change-plan.yaml
```

Creating a plan is the only mutating action and refuses to overwrite an
existing file. Behavior and security changes require explicit approval roles
and documentation impact. The generated version 2 template also requires an
architecture assessment: four-boundary responsibility placement, a decision
and reason for every governed existing-mechanism family, boundary assertions,
and a Core reusability rationale. A Core template automatically selects
`synthetic-only` public fixtures; a Workspace or Instance template selects
`not-applicable`.
