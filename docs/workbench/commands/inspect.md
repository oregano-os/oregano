---
document_id: command.inspect
title: companyos inspect
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

# `companyos inspect`

Discovers architecture facts and emits the questions required for an
Architecture Fitness Report.

```bash
companyos inspect .
companyos inspect . --plan change-plan.yaml --format json
companyos inspect . --base origin/main --plan auto
```

In CI, `--base <git-ref> --plan auto` classifies every file changed since the
base revision and discovers the single changed plan under
`.companyos/changes/`. An understated class or missing plan for behavior or
security work fails the check.

Inspection does not replace human judgment for protected changes.
