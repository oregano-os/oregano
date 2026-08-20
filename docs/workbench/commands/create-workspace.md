---
document_id: command.create-workspace
title: companyos create workspace
kind: command
status: implemented
authority: canonical
language: en
updated: 2026-08-20
owners:
  - core-maintainers
audience:
  - human
  - agent
availability: experimental
relations:
  implements:
    - specification.workspace-generator-v0.1
    - onboarding.company-workspace
---

# `companyos create workspace`

Interactive human use:

```bash
companyos create workspace
```

Agent-runbook use:

```bash
companyos create workspace \
  --answers .companyos-bootstrap/answers.yaml \
  --parent . \
  --preview \
  --format json

companyos create workspace \
  --answers .companyos-bootstrap/answers.yaml \
  --parent . \
  --confirm <confirmation_hash> \
  --format json
```

The interactive form asks one validated question at a time, presents the
complete result, and requires confirmation. Codex and Claude Code use the same
typed creation library by collecting the interview in chat, writing only the
eight non-secret answer fields, running `--preview`, showing that result to the
human, and passing the preview's confirmation hash only after explicit
confirmation. A changed answer, Core revision, target, mode, or file plan
invalidates the hash and requires a new preview.

The command derives the Core repository, immutable commit, and exact Workbench
version from a clean Oregano Core Git checkout. It refuses a dirty or
unverifiable checkout rather than pinning code that differs from the rendered
Workspace.

Creation produces the minimum `authoring-only` Workspace. It renders and
validates a temporary sibling before atomic placement, refuses an existing or
ambiguous target, and performs no network or provider mutation. The answer file
must contain exactly these fields:

```yaml
company_name: Example Company GmbH
workspace_slug: example-company
language: de
timezone: Europe/Berlin
steward_name: Anna Example
steward_id: anna-example
codeowner: "@anna"
target_directory: example-company-companyos
```

Interview values are normalized, length-bounded, field-validated, and encoded
as data. They are never executed as instructions or templates.
