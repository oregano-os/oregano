---
document_id: command.bootstrap
title: companyos bootstrap
kind: command
status: implemented
authority: canonical
language: en
updated: 2026-09-08
owners:
  - oregano-maintainers
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

For a fresh complete installation use `companyos setup`. Its CLI-owned session
creates the operating starter directly after one setup decision and verifies it
live. This command remains available for local authoring or inspection of an
existing Workspace; it is not an additional standard-onboarding question.

```bash
companyos bootstrap status [workspace] [--format human|json]
companyos bootstrap verify [workspace] [--format human|json]
```

The command provides the deterministic local Workspace checkpoint for the separate local-authoring path. It derives progress from the selected
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
`not-authorized` to this local command. The standard `companyos setup` session owns provider work and fresh initial
authorization. The explicit `--profile` path retains legacy/adoption approvals.
`companyos verify-live` is the final completion boundary for that full path.
