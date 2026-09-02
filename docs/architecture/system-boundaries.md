---
document_id: architecture.boundaries
title: System Boundaries and Placement
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
    - architecture.overview
---

# System Boundaries and Placement

## Oregano Core owns

- runner-neutral interfaces and provider adapters,
- approval, effect, identity, provenance, and StateStore mechanisms,
- generic business modules parameterized by Company Workspace files,
- non-weakenable safety defaults,
- schemas and deterministic validators,
- provider-neutral Capability Contracts and their compatibility policy,
- standard tools and their minimum risk,
- Package manifest schemas, Inspectors, resolution contracts, and conformance
  test fixtures,
- the CompanyOS Workbench and its Guides,
- deterministic Agent Binding resolution, provider-neutral governed Agent
  handoff and Conversation Assignment contracts, and the provider-neutral
  Builder job,
  repository-source, checked-proposal, and validation contracts,
- neutral fixtures and compatibility tests.

Core must not contain company names, board IDs, channel IDs, company roles,
company thresholds, company policies, or provider credentials.

Company Records and the Sprint domain follow the same rule. Core owns generic
source-version, projection, access, freshness, reconciliation, business-time,
Sprint-event, read-model, intent, durable-timer, idempotency, and evidence
mechanisms. A maintained Connector may implement a provider protocol inside
its privileged boundary, but the Sprint domain consumes only normalized
records and Capability contracts. The declarative Sprint Blueprint remains
separate from executable domain code.

Every new Change Plan must make this boundary review explicit. It assigns
responsibilities separately to Core, Packages or Blueprints, the Company
Workspace, and the Company Instance; reviews the maintained catalog of
existing mechanisms; and explains why any new Core mechanism is reusable
across companies. Provider adapters and Connector Packages may use provider
SDKs inside their privileged boundary. Generic business domains and
Capability Contracts remain provider-neutral, while exact provider mappings,
IDs, schedules, roles, thresholds, and operating policy remain Workspace or
Instance truth.

The Workbench may maintain a small private setup-adapter boundary for hosted
installation. A setup profile composes exactly one typed adapter for each
required role: source host, runtime host, state service, and communication
provider. A separate typed model-execution selection binds a Runner-supported
route and credential reference without making model SDKs part of Workspace or
provider-neutral Tool contracts. These adapters translate provider commands and receipts into the
provider-neutral Instance evidence above. They are not a public plugin API and
must not leak Vercel, Neon, Slack, GitHub, or any future provider type into
runtime Capability, Tool, evidence, or StateStore contracts. A Docker,
Hetzner, Railway, Supabase, or other installation becomes a new adapter and
profile, not a new Core execution model.

Core owns one model-recipe registry rather than a model installation role. The
maintained recipes include Vercel AI Gateway; native Anthropic, OpenAI, and
Google routes; named OpenAI-compatible cloud routes for OpenRouter, DeepSeek,
Groq, Together AI, MiniMax, Zhipu AI, Moonshot AI, Mistral AI, and NVIDIA NIM;
local or proxy routes for Ollama, llama-server, and LiteLLM; and one generic
OpenAI-compatible escape hatch for an explicitly bound endpoint. Recipes
declare transport, credential requirements, default or overridden base URL,
capabilities, model namespace, and advisory defaults; they never contain a
credential value. Exact task bindings override profile bindings and the
Instance default. Adding another model provider extends the recipe and
conformance set; it does not add a fifth installation role or permit
credentials in Core, a Workspace, or an Artifact.

The resolver may select documented Anthropic-then-OpenAI defaults from present
keys only when no explicit task, profile, default, or legacy route binding
exists. One resolved request never silently fails over to another provider.
Knowledge authorization remains upstream of model execution; the recipe layer
does not duplicate it as a provider data-class engine or approval workflow.

Database resource provisioning and CompanyOS schema preparation are separate
setup responsibilities. The state-service adapter creates or adopts the
provider resource and identifies the runtime secret binding. Core owns the
provider-neutral, versioned PostgreSQL manifest and the idempotent bootstrap
and read-only qualification operations for `companyos` and
`companyos_knowledge`. The runtime-host adapter executes bootstrap with the
resolved `DATABASE_URL` in process memory; neither Core nor setup state may
receive the credential value. The non-secret qualification receipt crosses
the adapter boundary and is bound to setup and health evidence. Runtime health
MUST verify the manifest without performing schema DDL. A new host or database
provider may replace the maintained Vercel and Neon bindings only after its
secret transport and PostgreSQL behavior satisfy the same contract.

The current `companyos-postgres@1.7.0` manifest is an additive Instance storage
contract over immutable predecessors `1.6.0`, `1.5.0`, `1.4.0`, `1.3.0`, `1.2.0`, `1.1.0`, and `1.0.0`.
Core defines and qualifies 67 required Knowledge relations, including stable groups,
memberships, durable Source Events, provider ACL snapshots, pipeline receipts,
completed watermarks, per-stream synchronization leases, lifecycle requests,
and a payload-free integrity-linked change stream, compounding receipts,
review-only Claim-pair proposals, explicit grading requests, a policy-bound
model-result cache, spend reservations, a rated execution ledger, rebuildable
Retrieval V3 projections, and payload-free benchmark and productization evidence. Schema
presence alone never grants access: the Runtime supplies
a Core-resolved subject, and the Knowledge Provider applies policy intersection
before candidates, ranks, graph structure, citations, review content, or model
context. Sensitive-source activation remains a separate provider-ACL
conformance gate.

The Builder execution host is a private adapter behind Core control, not a new
CompanyOS authority plane. Its coding process receives no Git-host, deployment,
Slack, StateStore, or production-provider credential. Repository credentials
belong to a separate trusted source/publisher boundary. When a hosted runtime
cannot execute Git, that boundary may use a private trusted Git worker to
acquire one exact source, independently validate the returned patch, create the
outer commit, and push the draft-proposal branch. It must never run the coding
agent or share its credential with the coding workspace.

ACP v1 transports messages only between an isolated Builder worker and a
pinned coding-agent implementation. It does not select Company Agents and does
not replace Runner, Tool, approval, StateStore, repository, or governance
contracts.

## A Company Workspace owns

- company identity, mission, context, and operating knowledge,
- policies that tighten or specialize Core behavior,
- roles, verified principals, and approval assignments,
- workflows, schedules, agent instructions, Skills, and SOPs,
- Blueprint and Tool Package declarations, reviewed materialized content, and
  the versioned Workspace Package lock,
- grants and declarative connection scopes,
- restricted company tools built only against the Oregano tool SDK,
- Workspace governance configuration and governed change records.

A Workspace never contains runner code, provider SDKs, direct secret access,
generic enforcement, deployment code, or operational state.

For Company Records and Sprint, the Workspace declares record sources,
projections, explicit field mappings, access policy, participants, calendar,
schedule, required briefing fields, close and Rollover policy, logical
destinations, requested Tools, grants, and the model task profile. It does not
contain durable synchronized rows, exact Connector credentials, or executable
provider adapters.

For multi-Agent conversation behavior, the Workspace declares logical Agents,
allowlisted handoff directions and purposes, eligible roles or groups,
permitted logical surfaces, return behavior, and conversation and retention
policy. It cannot infer authorization from text, assign a live provider
conversation, merge two Agents' ToolSets, or weaken exact-binding precedence.

## A Company Instance owns

- immutable deployment artifacts and their provenance,
- environment-specific bindings and non-public configuration,
- secrets and provider credentials,
- Connector Package installations, bindings, and the Instance Package ledger,
- database state, events, approvals, and effects,
- the applied CompanyOS database-manifest ledger and qualification evidence,
- Slack, Monday, Vercel, Neon, and other provider installations,
- Agent Binding declarations, optional Builder execution and coding-profile
  bindings, repository-provider installations, and their verified receipts.
- live Conversation Assignments, handoff request and decision receipts,
  provider conversation identifiers, expiry, return, and revocation state.

General model credentials and a service-environment repository App key are
Instance secrets. They are never Builder-specific Workspace fields and never
enter the coding process.

For Company Records and Sprint, the Instance also owns the exact database,
board and channel resources, Connector and external-Agent installations,
resource and destination bindings, provider permissions, model route, queues,
durable timers, callback replay claims, echo receipts, approvals, effects, and
operational evidence.

## A Package Registry owns

- publisher namespaces and Package ownership metadata,
- immutable Package versions, locations, and integrity metadata,
- compatibility discovery metadata,
- security advisories, yanks, and revocations.

A Package Registry never owns Company Workspace grants, Instance bindings,
secrets, approvals, activation, or effect authority. Registry listing,
certification, acquisition, and installation do not imply permission to use a
Package.

## Escalation rule

If a Workspace Contributor needs a generic capability that does not exist, the
valid action is a Core capability request. Reimplementing it inside a Workspace
as direct provider access is forbidden, even when it appears faster.

A request for a new Core capability must identify why AgentResolver, governed
Agent handoff and Conversation Assignment, ToolSetResolver,
ModelRecipeResolver, Company Records, identity and authorization, timers and
business time, approval and effect controls, and existing Capability or
Connector contracts cannot be reused as-is. Extension is preferred to a
parallel mechanism when the existing contract has the same responsibility.

## Company Knowledge boundaries

- Oregano Core owns OKF, Knowledge Bundle, graph, snapshot,
  search/get/traverse, citation, embedding-policy, Source Envelope, Runtime
  Observation, and review-state contracts plus the maintained provider
  interfaces.
- A Company Workspace owns curated `handbook/` content and raw
  `brain/inbox/`/`brain/archive/` review evidence.
- A Company Instance owns the `companyos_knowledge` projections, optional
  vector rows, source versions/receipts/cursors, observations, review rows,
  active snapshot pointer, legal holds, and rollback evidence in its existing
  database.
- The maintained repository Source Connector owns provider authentication,
  verification, enumeration, and fetching only. It feeds versioned envelopes
  to the raw review boundary and cannot write authoritative OKF directly.
- The Workbench owns inspect, build, regression, review preview, source
  operation, observation lifecycle, stage, verify, rebuild, and activate
  commands. A Blueprint may suggest examples but grants no access or binding.
