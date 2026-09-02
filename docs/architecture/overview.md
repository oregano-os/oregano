---
document_id: architecture.overview
title: CompanyOS Architecture Overview
kind: architecture
status: approved
authority: canonical
language: en
updated: 2026-09-01
owners:
  - oregano-maintainers
audience:
  - human
  - agent
relations:
  depends_on:
    - vision.companyos
    - reference.glossary
---

# CompanyOS Architecture Overview

A CompanyOS system has three operational parts and one contributor-facing surface.

```mermaid
flowchart LR
    C["Oregano Core<br/>generic platform"] --> I["Company Instance<br/>deployed pairing"]
    W["Company Workspace<br/>company operating model"] --> I
    R["Runtime infrastructure<br/>secrets, state, providers"] --> I
    C --> B["CompanyOS Workbench<br/>CLI, Guides, governance"]
    B --> W
```

- Oregano Core defines mechanisms that must work for every company.
- A Company Workspace defines how one company operates within those mechanisms.
- A Company Instance is the running result for one company and environment.
- The Workbench is how Human Contributors and Agent Contributors change a
  Workspace safely.

The primary placement rule is simple:

| Question | Destination |
|---|---|
| Must it work and remain safe for every company? | Oregano Core |
| Does it describe how this company works or decides? | Company Workspace |
| Is it a secret, live state, provider installation, or environment binding? | Company Instance |
| Does it try to bypass generic enforcement? | Stop; it is not a valid Workspace change |

Detailed boundaries are defined in [System boundaries](system-boundaries.md).

The open Package ecosystem is a supporting distribution plane, not another
operational authority layer. It lets contributors publish portable Blueprints,
Tools, and Connectors while Company Workspaces and Instances retain grants,
bindings, approvals, and activation. See [Ecosystem and Package
Architecture](ecosystem-and-packages.md).

Company Knowledge follows the same placement model. Reviewed OKF lives in the
Company Workspace, immutable projections and review state live in the existing
Company Instance database, and Oregano Core owns validation, bundling,
hybrid retrieval, deterministic graph traversal, citations, source envelopes,
Runtime Observations, and provider-neutral contracts. The maintained read-only
repository Source Connector feeds the same review boundary. Raw review input is
not operating truth and an external source never becomes a second authority
plane.

Multi-Agent conversation routing is deliberately two-stage. Deterministic
ingress chooses the first Agent from authenticated provider facts. An exact
binding remains fixed; an unmatched general conversation may begin at an
explicit default Agent. Only after that selection may the active Agent propose
an allowlisted semantic handoff. Core authorizes it without trusting message
text for identity or permission and the Instance persists the resulting exact
Conversation Assignment:

```mermaid
flowchart LR
    M["Authenticated provider message"] --> AR["AgentResolver<br/>exact binding or default"]
    AR --> A["Active Company Agent"]
    A -->|"bounded semantic request"| H["Agent handoff authorization"]
    H -->|"denied"| A
    H -->|"accepted"| CA["Conversation Assignment<br/>Instance state + evidence"]
    CA --> S["Target Company Agent<br/>own scoped ToolSet"]
```

Skills remain scoped material of the active Agent and may be selected from task
meaning because they do not select another Agent or increase authority. A
handoff changes the active compiled Agent, so it requires the separate Core
authorization and evidence path above.

The experimental Builder follows the same placement rule. A trusted Agent
Binding selects the ordinary `builder` Company Agent for one exact
communication channel. Only a second, explicit human confirmation creates a
durable proposal job. Provider-neutral Core control then coordinates separate
repository, isolated coding, validation, and proposal-publication boundaries:

```mermaid
flowchart LR
    H["Authorized human"] --> AR["AgentResolver<br/>exact surface binding"]
    AR --> BA["Builder Agent<br/>normal Runner conversation"]
    BA --> C["Explicit confirmation"]
    C --> BS["BuilderService<br/>durable proposal job"]
    BS --> RS["Repository source<br/>exact base"]
    BS --> CW["Isolated coding worker<br/>ACP: Claude Code or Codex"]
    BS --> V["Independent diff + Workbench checks"]
    V --> P["Draft proposal publisher"]
    P --> HR["Human review, merge, and deployment"]
```

The coding worker cannot push, merge, deploy, read production secrets, or
select another Company Agent. The Builder is opt-in Instance behavior; an
Instance without its exact configuration and Agent Binding continues to run
normal Agents without constructing Builder providers or coding runtimes.
