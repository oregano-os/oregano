---
document_id: command.validate
title: companyos validate
kind: command
status: implemented
authority: canonical
language: en
updated: 2026-09-09
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
---

# `companyos validate`

When `.companyos/instance.yaml` exists, validation checks its version-1 shape
and non-secret content using the build parser. Unknown top-level fields and
invalid declarations are errors. Absence remains compatible with authoring-only
and unmigrated Workspaces; a normal build requires the file. Full Agent, Tool
and Capability resolution still happens during build. See
[the format reference](../../reference/instance-configuration.md).

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

Workflows with `steps:` also receive generic authoring checks: strict option
sets, input and reference types, Tool grants and minimum risk, ordered prose
markers, acyclic control flow, literal config v2 and schedule references.
`WF001` identifies semantic or schema errors and `WF002` identifies a file or
parsing failure. Prose-only workflows keep their existing validation path.
Validation does not prove compilation, runtime enforcement, provider coverage
or a completed workflow. The executable authoring fixture is available at
`packages/testkit/fixtures/lindenhof-studio`.
