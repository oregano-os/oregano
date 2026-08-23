---
document_id: onboarding.index
title: CompanyOS Onboarding
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-08-23
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
relations:
  depends_on:
    - vision.companyos
    - architecture.overview
    - workbench.overview
---

# CompanyOS Onboarding

Onboarding is a maintained product contract, not a one-time setup note. A Human
Contributor or Agent Contributor must be able to enter a Company Workspace,
discover the correct path, establish a deterministic local baseline, and see
which remaining actions require a Platform Administrator with `repository` or
`instance` scope.

For a new Workspace, Codex and Claude Code use the same plugin-free Release
runbook, `INSTALL-COMPANYOS.md`, reached through the compatibility entrypoint
`BOOTSTRAP_FOR_AGENTS.md`. It collects confirmed non-secret answers in chat,
routes them through `companyos create workspace`, and treats
`companyos bootstrap verify` as an internal local checkpoint. The maintained
live path then uses `companyos setup --profile vercel-neon-slack` and finishes
only when `companyos verify-live` proves the narrow supervised starter scope.
The agent waits for the human's browser authentication, provider consent,
hash-bound Steward merge authorization, and production confirmation; it does
not obtain those authorities from the chat prompt.

Start with [Onboard a Company Workspace](company-workspace.md), then run:

```bash
companyos onboard /path/to/company-workspace
companyos bootstrap verify /path/to/company-workspace
companyos setup --profile vercel-neon-slack --workspace /path/to/company-workspace --answers /path/to/live-answers.yaml --state /path/to/setup-state.json --plan
companyos verify-live --state /path/to/setup-state.json
```

The first two commands check the local Workspace contract, immutable Core and
Workbench pin, governance, CODEOWNERS, CI, and the declared
repository-protection baseline. They deliberately report hosted facts as
manual because repository files cannot prove external state. The setup state
machine then attempts hosted protection automatically and records `enforced` or
`advisory` alongside the other provider and runtime evidence without placing
credentials in the Workspace or state file.

An authoring-only Workspace is valid with no operating agents and no executable
workflows. It must not invent automation merely to pass onboarding. The live
starter makes the move to `operating` as a separate hash-bound, checked, and
Steward-confirmed change: one supervised Oregano Agent, one Slack workflow, one
non-secret connection declaration, and no business Tool grants.

## Maintenance contract

Any change to required Workspace files, compatibility rules, repository
protection, CI, Workbench commands, Instance preparation, or Contributor entry
points must update these onboarding pages and the `companyos onboard` checks in
the same pull request. `companyos docs check` keeps the published navigation
and bundled Guides synchronized.
