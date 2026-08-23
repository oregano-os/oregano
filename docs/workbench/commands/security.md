---
document_id: command.security
title: companyos security
kind: command
status: implemented
authority: canonical
language: en
updated: 2026-08-23
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
---

# `companyos security`

Checks repository-local governance controls such as the agent entrypoint,
governance policy, protected CODEOWNERS paths, validation and inspection in CI,
and an exact Workbench pin.

```bash
companyos security .
```

Local files cannot prove that hosted Git protection is active. The command
therefore reports that external verification remains separate. The maintained
setup attempts hosted protection automatically and records the result;
unavailable enforcement does not block the Tool-free supervised starter.
