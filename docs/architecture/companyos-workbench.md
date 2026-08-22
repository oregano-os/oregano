---
document_id: architecture.workbench
title: CompanyOS Workbench
kind: architecture
status: approved
authority: canonical
language: en
updated: 2026-08-22
owners:
  - oregano-maintainers
audience:
  - human
  - agent
---

# CompanyOS Workbench

The CompanyOS Workbench is the development environment for Human Contributors
and Agent Contributors who build and maintain Company Workspaces. Its
canonical source lives in Oregano Core and is distributed as a versioned
toolchain that a Workspace pins locally.

```text
CompanyOS Workbench
├── Guides
├── Planning
├── Creation
├── Analysis
├── Inspection
├── Validation
└── Security
```

The initial commands are `guide`, `plan`, `inspect`, `inspect-core`, `validate`,
`security`, the end-to-end `onboard` readiness check, and local read-only
`package inspect`. Later creation, analysis, and Package mutation commands use
the same schemas and Guides. A command is labeled `planned`, `experimental`, or
`stable`; docs must never imply that a planned capability already exists.

| Actor | Workbench interface |
|---|---|
| Human Contributor | CLI |
| General Agent Contributor | CLI in a bounded development environment |
| CI | non-interactive CLI |
| Builder Agent | planned typed Workbench Tools/SDK using the same validation library |

The Builder Agent does not receive an unrestricted shell merely to run the
CLI. A restricted CLI sandbox is acceptable only for its proposal-mode
prototype until the typed interface exists.

Onboarding reuses the same validators and Guide library. It checks local facts
deterministically and labels hosted GitHub protection, identities, provider
accounts, and Instance provisioning as accountable manual steps until a
provider integration can verify them without weakening authorization.

“Builder” remains reserved for the governed Builder Agent. Human Contributors,
general Agent Contributors, and Core Contributors are not called Builders merely
because they create a change.
