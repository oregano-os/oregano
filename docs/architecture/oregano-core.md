---
document_id: architecture.oregano-core
title: Oregano Core
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
Capability contracts, exact Connector bindings, deterministic Agent Bindings,
optional non-secret Builder bindings, and provenance. Runtime
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

Core also owns the provider-neutral, proposal-only Builder control path:

- `AgentResolver` selects one compiled Company Agent from exact trusted
  surface, account, and channel bindings and fails closed on ambiguity.
- The planned Agent handoff control extends that deterministic ingress without
  replacing it: an active Agent may request one allowlisted target from message
  meaning, Core authorizes the request from trusted facts, and the Company
  Instance persists an exact, expiring Conversation Assignment. Exact static
  Agent Bindings retain precedence, and neither the request nor assignment
  changes identity, ToolSet, grants, approvals, or provider authority.
- `BuilderService` owns immutable jobs, leases, recovery, cancellation,
  independent diff inspection, Workbench validation, and proposal-only
  authority.
- `RepositorySourceAdapter` materializes one exact revision and
  `ProposalPublisher` publishes only independently checked evidence.
- The private `BuilderExecutionAdapter` controls isolated worker lifecycle.
  The maintained profile uses Vercel Sandbox, but this host is replaceable.
- ACP v1 is private communication inside that worker with exactly pinned
  Claude Code or Codex adapters. ACP is not the normal Runner, Tool, approval,
  repository, or governance contract.

The v0.5.4 implementation candidate adds governed semantic handoff,
Conversation Assignment persistence, return, expiry, and revocation to the
deterministic initial resolver. It remains ineligible for a production claim
until release, the additive Company Instance migration, deployment,
conformance, and live evidence are complete.

The Runner imports only a thin Builder chat integration. Removing or disabling
that integration does not replace `CompanyOSRuntime`, the normal model loop,
Knowledge Tools, or Agent routing. Concrete provider SDKs and credentials stay
inside adapters or the Company Instance.

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
