---
document_id: workbench.overview
title: CompanyOS Workbench
kind: guide
status: building
authority: canonical
language: en
updated: 2026-09-01
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

The current repository release candidate is `0.1.0-experimental.13`. Verify the
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
| `companyos knowledge` | Inspect/build OKF, test retrieval, operate snapshots and derived indexes, synchronize a repository source, and govern observations/review | experimental |
| `companyos records` | Inspect and materialize Company Records declarations, qualify a maintained source, and plan/apply secret-bound synchronization or reconciliation with payload-free status | experimental |
| `companyos create workspace` | Interactively or through the agent answers-file transport, preview and create one valid authoring-only Company Workspace | experimental |
| `companyos create` for other objects | Scaffold valid CompanyOS objects inside an existing Workspace | deferred |
| `companyos analyze` | Analyze workflow structure and behavior | planned |

The version-matched [Operate the Builder](guides/operate-builder.md) Guide
documents the experimental proposal-only path. The isolated worker currently
uses the same CLI validation implementation through a restricted snapshot; the
narrow typed Builder Workbench Tool surface remains planned. This transitional
shell does not provide repository credentials, merge authority, deployment
authority, or access to Instance secrets.

The canonical Guide source lives in this directory and is bundled into the
versioned Workbench distribution. The current co-checkout mode pins its exact
Core commit and Workbench version together. A future published package will let
a Workspace Contributor use the same Guides without opening the Oregano Core
repository.
