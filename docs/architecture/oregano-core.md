---
document_id: architecture.oregano-core
title: Oregano Core
kind: architecture
status: approved
authority: canonical
language: en
updated: 2026-08-26
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

Core also owns the provider-neutral Builder proposal control path:

- `AgentResolver` deterministically selects one compiled Company Agent from
  exact trusted surface bindings and fails closed on unknown or ambiguous
  multi-agent routes.
- `BuilderService` owns confirmed job creation, leases, recovery, cancellation,
  independent diff inspection, Workbench validation, and proposal-only
  authority.
- `RepositorySourceAdapter` materializes one exact source revision, and
  `ProposalPublisher` publishes only independently checked evidence.
- The private `BuilderExecutionAdapter` controls only isolated worker
  lifecycle. The first maintained implementation uses Vercel Sandbox.
- The isolated worker uses stable ACP v1 with exactly pinned Claude Code or
  Codex adapters. ACP does not replace `RunnerAdapter`, Tool, approval,
  StateStore, repository, or governance contracts.

Concrete provider SDKs and credentials remain in adapters or the Company
Instance. A second execution host or repository provider can implement the
same narrow contracts without changing Builder semantics.

Core changes are rare for Workspace Contributors. A Workspace Contributor who
finds a missing generic mechanism files a Core capability request rather than
placing platform code in the Workspace.
