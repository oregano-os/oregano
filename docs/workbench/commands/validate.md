---
document_id: command.validate
title: companyos validate
kind: command
status: implemented
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

# `companyos validate`

Runs deterministic, LLM-free, non-mutating checks against a Company Workspace.

```bash
companyos validate .
companyos validate . --format json
```

Errors fail the process. Warnings identify valid but incomplete or risky
states. Validation checks Company Tool contract fields, restricted Tool source,
credential indicators, grant references, and Workspace structure. Exact
Capability availability and the final ToolSet are resolved by `companyos build`
because they also require a Company Instance declaration.
