---
document_id: command.package-inspect
title: companyos package inspect
kind: command
status: implemented
authority: canonical
language: en
updated: 2026-08-22
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
relations:
  depends_on:
    - specification.companyos-packages-v0.1
---

# `companyos package inspect`

Inspects one local Package directory without executing code or changing files.

```bash
companyos package inspect ./my-blueprint
companyos package inspect ./my-blueprint --format json
```

The command requires a root `companyos.package.yaml`. It executes the canonical
manifest JSON Schema, evaluates the declared CompanyOS specification range and
Package contract, and validates identity, canonical referenced paths,
type-specific Component entrypoints, permissions, links, regular-file
constraints, lifecycle scripts, a conservative declarative file allowlist,
credential indicators, and the absence of runtime code in a Blueprint.

Agent Components use `agents/<agent-id>/instructions.md`; Workflow Components
use Markdown entrypoints under `workflows/`; Skill Components use `SKILL.md` in
a `skills` directory. JSON output reports the publisher claim, license, local
source, declared and current specification versions, compatibility verdict,
trust tier, Components, requirements, permissions, and explicit support states
for inspection, installation, and activation. The report does not verify the
publisher identity.

`blueprint` is the only fully inspected kind in Contract Foundation Lite.
`tool` and `connector` are recognized and reported as unsupported; they are not
activated, imported, or executed. Errors produce exit code `1`. Inspection
never installs, applies, locks, resolves, grants, binds, or activates a Package.
