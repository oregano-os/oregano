---
document_id: command.guide
title: companyos guide
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

# `companyos guide`

Lists and displays Workbench Guides bundled with the installed Workbench
version.

```bash
companyos guide list
companyos guide show start-here
```

The command is read-only. Guide source is canonical under
`docs/workbench/guides/` and copied into the CLI distribution by the
documentation generator.
