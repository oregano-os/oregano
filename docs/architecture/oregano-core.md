---
document_id: architecture.oregano-core
title: Oregano Core
kind: architecture
status: approved
authority: canonical
language: en
updated: 2026-08-19
owners:
  - core-maintainers
audience:
  - human
  - agent
---

# Oregano Core

Oregano Core is the generic executable platform behind CompanyOS. The runner
runs as one adapter inside Core, but Core is broader than the runner: it owns
the control layer that decides which company applies, what an agent may do,
who may approve, whether an effect is safe to dispatch, which versions were
used, and what evidence exists.

The Core Builder compiles an exact Workspace and non-secret Instance
declaration into an immutable artifact. The artifact contains scoped agent
material, roster principals, resolved ToolSets, restricted Company Tool code,
Capability contracts, exact Connector bindings, and provenance. Runtime
execution validates schemas, grants, approvals, idempotent effects, and
evidence without reading the Git repositories again.

Runner-specific code presents messages, obtains model turns, and transports
Tool calls. It does not own business authorization. A second runner must be
implementable without rewriting roster, approval, effect, or provenance
semantics. The maintained Vercel Runner uses Vercel Connect plus Chat SDK for
Slack transport, AI SDK plus AI Gateway for model turns, and the Postgres Chat
State adapter for durable subscriptions, locks, queues, and conversations. It
registers only the Artifact's resolved ToolSet and delegates approvals and
effects to `CompanyOSRuntime`. The legacy Eve adapter remains retired.

Core changes are rare for Workspace Contributors. A Workspace Contributor who
finds a missing generic mechanism files a Core capability request rather than
placing platform code in the Workspace.
