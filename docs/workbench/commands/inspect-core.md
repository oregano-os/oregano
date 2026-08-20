---
document_id: command.inspect-core
title: companyos inspect-core
kind: command
status: implemented
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

# `companyos inspect-core`

Checks the Core documentation control plane, classifies the actual Git diff
through the Core Change Policy, validates its Core Change Plan, and emits the
required North-Star architecture judgments.

```bash
companyos inspect-core --plan .oregano/changes/my-change.yaml
companyos inspect-core --base origin/main --plan auto
```

The command can enforce evidence and classification. It cannot decide whether
an architecture trade-off is good; that remains an accountable review.
