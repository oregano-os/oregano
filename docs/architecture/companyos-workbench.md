---
document_id: architecture.workbench
title: CompanyOS Workbench
kind: architecture
status: approved
authority: canonical
language: en
updated: 2026-08-31
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
| Builder Agent | experimental restricted proposal worker using the same CLI validation library; typed Workbench Tools/SDK planned |

The Builder Agent does not receive an unrestricted shell merely to run the
CLI in the normal Runner. The experimental proposal worker uses a restricted,
credential-free snapshot to invoke the same CLI library until the typed
interface exists. A separate trusted Git worker reruns validation before
publication; neither boundary may merge or deploy.

Onboarding reuses the same validators and Guide library. It checks local facts
deterministically and labels hosted GitHub protection, identities, provider
accounts, and Instance provisioning as accountable manual steps until a
provider integration can verify them without weakening authorization.

“Builder” remains reserved for the governed Builder Agent. Human Contributors,
general Agent Contributors, and Core Contributors are not called Builders merely
because they create a change.

Company Knowledge adds a single command group. `knowledge inspect`, `build`,
`regression`, and review preview do not mutate a Workspace; `stage`, `verify`,
`activate`, `rebuild`, source synchronization, and Runtime Observation
lifecycle commands are explicit Instance operations. Source verify/health use
read-only provider requests. Review is deliberately bounded to three
candidates and never writes an accepted proposal into the Handbook
automatically.
