---
document_id: command.bootstrap
title: companyos bootstrap
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
    - onboarding.index
    - onboarding.company-workspace
    - specification.workspace-generator-v0.1
---

# `companyos bootstrap`

```bash
companyos bootstrap status [workspace] [--format human|json]
companyos bootstrap verify [workspace] [--format human|json]
```

The command provides the deterministic local Workspace checkpoint used inside
the shared Codex and Claude Code runbook. It derives progress from the selected
directory and existing Workspace checks, so the agent does not treat chat
history as verification evidence.

`status` reports the next local, hosted-repository, and Company Instance phases.
Before a Workspace exists it points to `companyos create workspace`. After
creation it includes the ordinary onboarding checklist.

`verify` exits successfully only when the local Company Workspace has no
blocking validation, security, compatibility, or onboarding diagnostic. Its
verification scope is exactly `authoring-only-local`. Success does not prove or
authorize:

- a GitHub account, repository, organization, or ruleset;
- a Vercel deployment;
- a Neon/Postgres database;
- a Slack installation; or
- an operating Company Instance.

Those external phases remain visible as `manual`, `deferred`, or
`not-authorized` to this local command. The separate experimental
`companyos setup --profile vercel-neon-slack` command owns provider contracts,
confirmations, idempotent resume evidence, independent review, and deployment.
`companyos verify-live` is the final completion boundary for that full path.
