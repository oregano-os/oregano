---
document_id: guide.author-package
title: Author a CompanyOS Package
kind: guide
status: approved
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
    - architecture.ecosystem-packages
---

# Author a CompanyOS Package

Contract Foundation Lite supports local read-only inspection of Blueprint
Packages. Use one Package for a versioned distribution and one or more Agent,
Workflow, or Skill Components inside it.

## Start with the boundary

Use a Blueprint only for declarative, portable content. Keep company principals,
active grants, approvals, provider bindings, real secrets, and runtime code out
of the Package. Company-specific values belong in a reviewed Company Workspace
overlay. Accounts, SecretRefs, provider adapters, and deployments belong to the
Company Instance.

If the contribution needs restricted code, it is a future Tool Package. If it
implements a provider, it is a future Connector Package. Both kinds are
recognized by the current Inspector but intentionally unsupported.

## Create the manifest

Add `companyos.package.yaml` at the Package root:

```yaml
schema_version: 1
id: example.publisher/sprint-agent
version: 0.1.0
kind: blueprint
name: Sprint Agent
description: Portable declarative sprint coordination material
license: Apache-2.0
publisher:
  id: example.publisher
compatibility:
  companyos_spec: ">=0.7 <0.8"
  package_contract: "1"
components:
  agents:
    - agents/sprint/instructions.md
  workflows: []
  skills:
    - skills/sprint-sop/SKILL.md
requires:
  tools: []
  capabilities: []
permissions:
  runtime_code: false
  network: []
  secret_refs: []
tests:
  fixtures: []
```

Every referenced path must be relative, remain inside the Package root, exist,
and identify a regular file. Blueprint trees cannot contain symbolic links,
hardlinks, executable files, runtime source extensions, lifecycle scripts,
network permissions, secret permissions, embedded credential indicators,
hidden control directories, or file types outside the declarative allowlist.
Agent Components use `agents/<agent-id>/instructions.md`; Workflow Components
use Markdown entrypoints below `workflows/`; Skill Components use `SKILL.md` in
a `skills` directory. Use `>=0.7 <0.8` only when the Package genuinely supports
the complete declared range; inspection evaluates it against the current Core
specification implementation.

## Inspect before review

```bash
companyos package inspect ./path-to-package
companyos package inspect ./path-to-package --format json
```

An inspection result proves only the current static contract. It does not prove
that Tool requirements resolve, that a company granted authority, that an
Instance binding exists, or that installation is supported. Until Blueprint
plan/apply/lock exists, propose materialized files as an ordinary governed
Workspace diff and identify Package-derived files in its Change Plan.
