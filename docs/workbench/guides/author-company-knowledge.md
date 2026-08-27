---
document_id: guide.author-company-knowledge
title: Author Company Knowledge
kind: guide
status: building
authority: canonical
language: en
updated: 2026-08-25
owners:
  - oregano-maintainers
audience:
  - human
  - agent
relations:
  depends_on:
    - specification.company-knowledge-v0.1
---

# Author Company Knowledge

Create one focused Markdown file under `handbook/` with OKF `type` and
`description` frontmatter. Use a stable descriptive path, ordinary relative
links, and explicit headings. `visibility` defaults to `company`. A restricted
document declares `team`, `restricted_group`, `individual`, or `private` plus
stable `allowed_groups` or `allowed_principals`; optional denied subjects win
over allows. Sensitive or personal documents cannot use `public` or `company`.
Update `handbook/index.md` in the same change.

```yaml
---
type: concept
description: Current payroll policy.
data_class: personnel
personal_data: true
visibility: restricted_group
allowed_groups: [group:people]
---
```

Run `companyos knowledge inspect .`, then the normal Workspace validation and
inspection. Put uncertain meeting notes or imports in `brain/inbox/`; do not
word them as company authority. Raw notes declare `source`, `captured_at`,
`actor`, and `personal_data` frontmatter. Personal raw notes remain in the
administrator-only quarantine until restrictive policy and review evidence
exist. Never put credentials in either location. Treat a path or heading as
identity only, never as access control.
