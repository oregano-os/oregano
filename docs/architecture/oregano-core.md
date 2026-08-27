---
document_id: architecture.oregano-core
title: Oregano Core
kind: architecture
status: approved
authority: canonical
language: en
updated: 2026-08-25
owners:
  - oregano-maintainers
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
Slack transport, AI SDK with either Vercel AI Gateway or the official direct
Anthropic provider for model turns, and the Postgres Chat State adapter for
durable subscriptions, locks, queues, and conversations. It
registers only the Artifact's resolved ToolSet and delegates approvals and
effects to `CompanyOSRuntime`. The legacy Eve adapter remains retired.

Core changes are rare for Workspace Contributors. A Workspace Contributor who
finds a missing generic mechanism files a Core capability request rather than
placing platform code in the Workspace.

## Native Company Knowledge

Core implements the OKF parser, deterministic heading-aware fragmenter,
Knowledge Bundle and link graph, lexical/hybrid retrieval and citation shape,
bounded graph traversal and curation, the embedding and provider interfaces,
three read Capability contracts, and the explicitly granted
`oregano:knowledge/search`, `oregano:knowledge/get`, and
`oregano:knowledge/traverse` standard Tools. The maintained Postgres provider
and repository Source Connector are adapters behind Core contracts; neither is
a second Agent runtime or a second Agent-facing knowledge surface.

When an Agent receives a Knowledge Tool grant, searchable Handbook documents
are omitted from its compiled prompt materials. The immutable control Artifact
records the bundle hash and policy hash while the separate Knowledge Bundle is
staged, verified, and activated in the Instance. The roster stays in the Agent
definition because runtime authorization remains a Core control.

The default embedding adapter is local and has no data egress. Optional
`pgvector` state is derived; adapter or index failure retains lexical retrieval
with explicit degradation. Source Envelopes and Runtime Observations feed the
same bounded human review boundary and cannot activate OKF directly.
