---
document_id: architecture.boundaries
title: System Boundaries and Placement
kind: architecture
status: approved
authority: canonical
language: en
updated: 2026-08-24
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
provider. These adapters translate provider commands and receipts into the
provider-neutral Instance evidence above. They are not a public plugin API and
must not leak Vercel, Neon, Slack, GitHub, or any future provider type into
runtime Capability, Tool, evidence, or StateStore contracts. A Docker,
Hetzner, Railway, Supabase, or other installation becomes a new adapter and
profile, not a new Core execution model.

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
