---
document_id: architecture.boundaries
title: System Boundaries and Placement
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
- neutral fixtures and compatibility tests.

Core must not contain company names, board IDs, channel IDs, company roles,
company thresholds, company policies, or provider credentials.

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

The current `companyos-postgres@1.4.0` manifest is an additive Instance storage
contract over immutable predecessors `1.3.0`, `1.2.0`, `1.1.0`, and `1.0.0`.
Core defines and qualifies 55 required Knowledge relations, including stable groups,
memberships, durable Source Events, provider ACL snapshots, pipeline receipts,
completed watermarks, per-stream synchronization leases, lifecycle requests,
and a payload-free integrity-linked change stream. Schema presence alone never grants access: the Runtime supplies
a Core-resolved subject, and the Knowledge Provider applies policy intersection
before candidates, ranks, graph structure, citations, review content, or model
context. Sensitive-source activation remains a separate provider-ACL
conformance gate.

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

## A Company Instance owns

- immutable deployment artifacts and their provenance,
- environment-specific bindings and non-public configuration,
- secrets and provider credentials,
- Connector Package installations, bindings, and the Instance Package ledger,
- database state, events, approvals, and effects,
- the applied CompanyOS database-manifest ledger and qualification evidence,
- Slack, Monday, Vercel, Neon, and other provider installations.

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
