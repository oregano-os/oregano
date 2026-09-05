---
document_id: architecture.oregano-core
title: Oregano Core
kind: architecture
status: approved
authority: canonical
language: en
updated: 2026-09-03
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
  Instance persists an exact, expiring Conversation Assignment. A reviewed
  Workspace may bound it by a fixed TTL or by the next local calendar-day
  boundary in an explicit IANA timezone. Exact static
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
Conversation Assignment persistence, fixed-TTL or local-day-boundary expiry,
return, and revocation to the
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

## Sprint orchestration

Core keeps Sprint policy separate from Sprint execution. The pure Sprint
domain accepts a reviewed declaration, a Workspace-supplied business calendar,
prior state, and one normalized event, then returns only deterministic state,
evidence, and intents. It contains no provider client, SQL, model call, Tool
execution, company template, or external effect.

The provider-neutral orchestration service surrounds that pure boundary. It
atomically commits each event, its monotonic state version, decision evidence,
and stable pending intents; optimistic retries preserve concurrent events and
event-identity collisions fail closed. Durable timers enter through the same
event path. A bounded leased worker may dispatch an intent only after an exact
adapter has been supplied. The maintained adapter resolves a compiled Agent
and Tool grant and calls the existing `CompanyOSRuntime`, so ToolSet,
Capability, authorization, approval, effect, idempotency, and Connector
controls are not duplicated.

The maintained Vercel Runner hosts that service behind an authenticated
operator route, separate timer and intent wake-up routes, and the existing
authenticated Slack ingress. Workbench compiles the reviewed Sprint policy,
schedule, templates, logical Agent, service principal, participant identity
namespace, and destination/resource bindings into the immutable Artifact.
Opening a Sprint reads only fresh authorized Company Records projections
through the standard `records.query` Tool. `shadow` mode renders and records
digests without provider effects; `active` mode still reaches a provider only
through the standard Tool boundary. Each Sprint definition has a namespaced
timer kind, so one worker cannot lease another definition's timers.

An optional compiled replay binding selects one generic
`communication-message` projection. The authenticated operator may replay an
explicit historical period with an isolated Sprint definition and controlled
clock. Canonical roster principals, not text or display names, resolve message
authors; the Sprint Domain alone recognizes and derives typed Friday
submissions. Exact communication and work-item source-version lineage is
retained with the durable Sprint event. The maintained hosted replay is
proof-only and structurally refuses every live output binding. A later test
publication remains an ordinary Capability-controlled effect rather than a
privilege of the replay engine.

The weekly worker refreshes current work-item facts from a twice-stabilized
projection before processing due Monday, weekday, readiness, or Friday timers.
This does not replace the Sprint participant snapshot: the participant scope is
frozen for the Sprint while provider work facts advance only through versioned
`work-items.observed` events. Structured `NEXT WEEK` submissions feed the next
Monday comparison; scheduled readiness emits at most one focused direct
question per affected participant and one version-bound reversible status
intent for each actual readiness transition. The status intent can change only
the exact Instance-bound secondary field and never the authoritative provider
group.

Message text, participants, provider projections, calendar dates, schedules,
language, and requested grants remain Company Workspace truth. Exact Agent,
model, destination, work-item, database, secret, timer, and activation
bindings remain Company Instance truth. Merely installing Core or preparing
the additive database schema does not start a Sprint, lease an intent, send a
message, or change a work item. The initial hosted profile uses reviewed
Monday polling for projections and Slack for interactive submissions. Monday
board-change webhooks and Monday card chat remain later extensions. A
single-item reversible briefing proposal may be confirmed only by its exact
active human subject through a dedicated R2 Tool. Rollover uses a separate R3
batch Capability: automatic orchestration freezes and records only the
proposal; an ordinary approval must authorize the exact batch, the Connector
preflights every item before the first write, and a partial dispatch becomes an
unknown effect outcome. The generic intent worker never turns a proposal
directly into an effect.

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
