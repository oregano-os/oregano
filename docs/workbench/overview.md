---
document_id: workbench.overview
title: CompanyOS Workbench
kind: guide
status: building
authority: canonical
language: en
updated: 2026-08-26
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
---

# CompanyOS Workbench

The Workbench is the versioned CLI and Guide library used to build and maintain
Company Workspaces safely.

The current repository release candidate is `0.1.0-experimental.7`. Verify the
validator in use with `companyos --version`. This identifier is an exact local
contract version; it does not claim that a public package has been published.

| Command | Purpose | Availability |
|---|---|---|
| `companyos guide` | Discover and read version-matched Guides | experimental |
| `companyos plan` | Create or check a structured Change Plan | experimental |
| `companyos inspect` | Produce an Architecture Fitness Report | experimental |
| `companyos inspect-core` | Check a Core diff against the North Star and Core Change Plan | experimental |
| `companyos validate` | Run deterministic document or Workspace checks | experimental |
| `companyos security` | Check local governance controls and protected paths | experimental |
| `companyos onboard` | Check end-to-end Workspace onboarding readiness and surface manual external steps | experimental |
| `companyos bootstrap status` / `verify` | Drive the resume-aware local checkpoint used by the shared Codex and Claude Code runbook | experimental |
| `companyos setup --profile vercel-neon-slack` | Plan, confirm, execute, and resume the maintained private GitHub plus Vercel, Neon, and Slack starter setup | experimental |
| `companyos verify-live` | Verify the exact supervised live starter scope, including health and persisted Slack evidence | experimental |
| `companyos versions` | Report the exact Core, Workspace, Workbench, and specification versions | experimental |
| `companyos package inspect` | Inspect a local Package without mutation; Blueprint is supported, Tool and Connector are recognition-only | experimental |
| `companyos build` | Compile an exact Core, Workspace, and non-secret Instance declaration into an immutable resolved artifact | experimental |
| `companyos create workspace` | Interactively or through the agent answers-file transport, preview and create one valid authoring-only Company Workspace | experimental |
| `companyos create` for other objects | Scaffold valid CompanyOS objects inside an existing Workspace | deferred |
| `companyos analyze` | Analyze workflow structure and behavior | planned |

The canonical Guide source lives in this directory and is bundled into the
versioned Workbench distribution. The current co-checkout mode pins its exact
Core commit and Workbench version together. A future published package will let
a Workspace Contributor use the same Guides without opening the Oregano Core
repository.

The Workbench is also the independent validation boundary for Builder
proposals. The isolated coding agent does not decide that its change is valid.
After it exits, CompanyOS inspects the actual diff and runs the exact
Workbench `inspect`, `validate`, and `security` implementation before any
trusted outer publication boundary receives write authority. The maintained
hosted composition reruns those checks in a fresh repository-only trusted Git
worker before the outer commit and branch push. Operational procedures are
defined in [Operate the Builder](guides/operate-builder.md).
