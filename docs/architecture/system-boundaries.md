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
- deterministic Agent Bindings and fail-closed Agent resolution,
- persistent Builder job semantics, independent diff inspection, and
  proposal-only enforcement,
- provider-neutral repository source and checked proposal publication
  contracts,
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

The maintained model routes are Vercel AI Gateway and direct Anthropic. Adding
a direct OpenAI, Bedrock, Vertex, or another model route extends the model
adapter set and conformance tests; it does not add a fifth installation role or
permit credentials in Core, a Workspace, or an Artifact.

The private Builder execution boundary is narrower than the normal Runner
boundary. It starts, observes, cancels, collects, and disposes one isolated
coding job. Vercel Sandbox is the first maintained adapter, but no Vercel type
may enter the Builder job contract. ACP v1 is private communication inside that
worker; it is not the CompanyOS Core contract for selecting or invoking normal
Company Agents.

Repository-only execution is a separate trust boundary. When the Runner host
cannot execute Git, a private `TrustedGitExecutionAdapter` may clone and push
with provider-brokered credentials, transfer only a bounded credential-free Git
bundle to coding, and rerun diff inspection plus the Workbench before the outer
commit. It MUST NOT run Claude Code, Codex, or another coding agent, and the
coding boundary MUST NOT receive its repository credential or remote.

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
- Slack, Monday, Vercel, Neon, and other provider installations,
- Agent Binding declarations, Builder execution and coding-profile bindings,
  repository-provider installations, and their non-secret verified receipts.

The Instance secret store owns general provider credentials, including model
keys and a service-environment GitHub App private key. A coding worker receives
neither repository credentials nor deployment, Slack, database, or GitHub App
authority.

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
