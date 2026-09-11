---
document_id: architecture.boundaries
title: System Boundaries and Placement
kind: architecture
status: approved
authority: canonical
language: en
updated: 2026-09-09
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

The non-secret Instance build declaration is physically stored in the Company
Workspace at `.companyos/instance.yaml`. Its ownership remains the Company
Instance; its source changes use Workspace security review. The file may name
exact accounts, resources, routes and SecretRefs, but cannot grant credentials,
execute a provider call or activate a deployment. Runtime state and secrets
remain outside Git. See the [format contract](../reference/instance-configuration.md).

The standard installation flow lives in the Workbench, not in a Codex/Claude
prompt. Its session owns discovery, defaults, one initial setup decision and
recovery; private provider adapters perform the effects. The fresh operating
Workspace remains company-owned. Session decisions, resource receipts and live
verification remain private Instance evidence. A release payload supplies exact
Core and tooling without turning a harness into another setup implementation.
This new path is experimental and its five-minute live qualification is pending.

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
isolate provider-generated skills and transient OIDC files from the immutable
Core checkout. Only validated non-secret project link fields survive that
temporary context. Slack connector payloads remain private and are reduced to
validated app/workspace identities; they are not general readiness evidence.
Production aliases come from the exact provider deployment receipt, and current
health must identify that deployment before the alias becomes verification input.
Login redirects are not followed or interpreted as application health.
The Slack adapter explicitly enables incoming triggers at creation and checks
current forwarding, production attachment and webhook destination before the
first-message gate and final verification. Explicit event selections must include
direct messages. The adapter exposes exact-resource delivery recovery when a
reply remains missing; provider synchronization and Slack URL verification
remain separate from runtime model evidence and cannot grant additional scopes.
The adapters must not leak Vercel, Neon, Slack, GitHub, or any future provider type into
runtime Capability, Tool, evidence, or StateStore contracts. A Docker,
Hetzner, Railway, Supabase, or other installation becomes a new adapter and
profile, not a new Core execution model.

Provider prerequisites belong to the concrete setup binding. The maintained
Vercel binding declares Pro or Enterprise, checks the selected team's current
plan automatically, and owns its background schedules. Team identity and plan
receipts remain private Instance setup evidence; a Hobby upgrade is a human
billing action. This does not make Vercel billing or cron frequency a generic
Core runtime contract or a Company Workspace interview field.

Core owns one model-recipe registry rather than a model installation role. The
standard setup exposes OpenAI and Anthropic as explicit direct-provider choices.
Other providers and exact model overrides require a request; this selection
reuses the recipe resolver and secret-entry adapter. Runtime defaults for
existing installations remain separate. The maintained recipes include Vercel AI Gateway; native Anthropic, OpenAI, and
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
Identity, scoped inputs, Tool grants and effect authority remain in their
existing Core layers; model configuration does not grant access or approval.

Database resource provisioning and CompanyOS schema preparation are separate
setup responsibilities. In fresh setup, the state-service adapter creates the
provider resource and identifies the runtime secret binding. Core owns the
provider-neutral, versioned PostgreSQL manifest and the idempotent bootstrap
and read-only qualification operations for `companyos` and
`companyos_records`. The runtime-host adapter executes bootstrap with the
resolved `DATABASE_URL` in process memory; neither Core nor setup state may
receive the credential value. The non-secret qualification receipt crosses
the adapter boundary and is bound to setup and health evidence. Runtime health
MUST verify the manifest without performing schema DDL. A new host or database
provider may replace the maintained Vercel and Neon bindings only after its
secret transport and PostgreSQL behavior satisfy the same contract.

The current `companyos-postgres@3.0.0` manifest qualifies 15 control/Workflow and 14
Records/Sprint tables. Historical identities are recognized for upgrade but
obsolete schema constructors are removed. Knowledge retirement is an explicit
one-time migration, separate from normal initialization and read-only health.
Schema presence never grants identity, Tool or effect authority.

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
permitted logical surfaces, one fixed-TTL or local-day-boundary expiry policy,
return behavior, and conversation and retention policy. It cannot infer
authorization from text, assign a live provider
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

## Handbook boundary

The Company Workspace owns Handbook Markdown and the structured roster.
Core retains generic scoped file material, identity and approval enforcement.
The Workbench applies ordinary validation and governed editing. No Knowledge
service, source registry, database projection, search or promotion path remains.
General Records connectors, model recipes, Builder and workflow behavior remain
independent and unchanged.

## Candidate distribution boundary

Packaging and verifying an unpublished installer belongs to Core. Candidate
selection does not add authority: the existing single scoped setup decision
still covers named fresh resources and first deployment. The Company Workspace
records the source pin and candidate marker; the private acquisition receipt
stays with the setup session, outside company Git. Core generates a separate
Slack connector name for each candidate session; provider identity and trigger
receipts must match that exact name throughout creation, resume and verification.
