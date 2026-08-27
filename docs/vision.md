---
document_id: vision.companyos
title: CompanyOS Vision
kind: vision
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

# CompanyOS Vision

CompanyOS is a safe, inspectable operating system for companies whose operating
model is represented as versioned files and executed by governed agents.
Humans retain authority over intent, policy, money, people, and irreversible
effects. Agents make the operating model easier to run, examine, and improve.

The system must work for established companies, small teams, and internal or
external Workspace Contributors without granting them authority to bypass
company governance.

## North Star

A capable Human Contributor or Agent Contributor should be able to open one
Company Workspace, understand how the company operates, make a bounded change
through the CompanyOS Workbench, prove that it fits the architecture, and
submit it for the correct human approval without access to runtime secrets or
platform code.

A new company should be able to establish the same safe baseline through one
maintained onboarding path without guessing repository structure, versions,
commands, hosted protections, or the boundary between local and external setup.
That path may use a concrete reference stack—currently GitHub for source and
review, Vercel for runtime hosting, and Neon/Postgres for durable state—while
keeping every provider replaceable behind the same CompanyOS contracts.

An external contributor should be able to publish a portable CompanyOS Package
against stable public contracts without patching Oregano Core. A Workspace
Steward should be able to discover, inspect, pin, review, install, grant, bind,
activate, update, remove, or fork it through governed paths. Installation alone
must never grant company authority, secrets, or runtime access.

An authorized company member should be able to retrieve cited, freshness-aware
Company Knowledge from the exact reviewed Workspace version without loading the
entire Handbook into every Agent prompt. Search providers, embeddings, and
external sources remain replaceable projections or evidence inputs. Only a
reviewed Workspace change can make raw source material or a Runtime Observation
part of curated company authority.

## Non-negotiable principles

1. **One Company Workspace per company.** Company-specific operating truth is
   versioned in its own repository.
2. **A company-independent Core.** Oregano Core contains only generic runtime,
   enforcement, modules, schemas, and developer tooling.
3. **One deployed pairing.** A CompanyOS Instance records the exact Core and
   Workspace versions it runs.
4. **Human authority is explicit.** Authentication, authorization, approval,
   and effect execution are separate steps with evidence.
5. **Safety cannot be weakened from a Workspace.** Company policy may tighten
   Core defaults but may not bypass them.
6. **Files are the review surface.** Company intent stays readable without a
   proprietary admin interface.
7. **Evidence beats claims.** Effects, versions, approvals, and external
   receipts are recorded so a run can be explained later.
8. **The runtime is replaceable.** Business rules do not hide inside eve,
   Slack, Vercel, or another provider adapter.
9. **The Workbench guides every Contributor.** Human Contributors and Agent
   Contributors use the same versioned Guides, contracts, validation rules,
   and change process through interfaces appropriate to their actor type.
10. **Documentation is part of the system.** A change to architecture,
    behavior, governance, commands, or runtime capabilities is incomplete
    until canonical documentation and machine-readable status are updated.
11. **Onboarding has no hidden steps.** Required files, commands, immutable
    pins, Git protections, administrator actions, and acceptance checks stay
    documented and machine-checkable wherever the system can verify them.
12. **English is the engineering language.** Canonical artifacts are English;
    runtime communication follows the Company Workspace language.
13. **The reference stack is concrete, not mandatory.** CompanyOS maintains one
    executable setup using GitHub, Vercel, and Neon/Postgres so onboarding can
    be tested end to end. Equivalent Git, runtime-hosting, and state providers
    remain valid when their adapters preserve identity, protection, secrets,
    provenance, evidence, rollback, and validation contracts.
14. **Readiness is scoped and evidenced.** Workspace structure, workflow
    execution, Instance enforcement, and effect risk are evaluated at their
    proper scopes. CompanyOS does not replace this evidence with one global
    maturity or conformance label.
15. **The ecosystem is open and authority remains governed.** Contributors may
    author and publish portable Packages without receiving company authority or
    changing Core for each implementation.
16. **Marketplace discovery is not authority.** Listing, certification,
    popularity, acquisition, or installation never implies a Tool grant,
    provider binding, approval, activation, or permission to execute.
17. **Privilege determines the extension boundary.** Declarative Blueprints,
    restricted Tools, and privileged Connectors use different contracts,
    validation, execution, and trust requirements.
18. **Public contracts are portable and maintained.** Package manifests,
    Capability Contracts, SDKs, and conformance suites are versioned,
    registry-independent, and governed by explicit compatibility policy.
19. **Package lifecycle is reproducible and reversible.** Exact sources,
    versions, digests, managed changes, grants, bindings, activation, updates,
    removals, and revocations remain inspectable and attributable.
20. **Knowledge authority stays reviewed and singular.** OKF in the exact
    Company Workspace commit is curated authority. Database projections,
    embeddings, source envelopes, Runtime Observations, and model summaries
    remain cited, rebuildable, review-bound evidence.

## Architecture fitness questions

Every material change must answer:

- Does it belong in Core, a Company Workspace, or a Company Instance?
- Does it introduce company knowledge into Core?
- Does it duplicate a source of truth?
- Can a Company Workspace weaken a safety invariant?
- Is the behavior inspectable and deterministic where it must be?
- Is the exact deployed version and evidence recoverable?
- Can another runtime or another company use the same Core mechanism?
- Have documentation, tests, migration, and rollback been handled?
- Does a setup or governance change keep onboarding accurate and executable?
- Does a reference-provider assumption remain replaceable at its declared
  boundary?
- Can an external contributor add the capability without patching Core or
  receiving company secrets or authority?
- Are Package installation, Tool grants, Instance bindings, activation, and
  per-effect approval separate and inspectable?
- Can the exact Package be reproduced, updated, removed, forked, or replaced
  without depending on one proprietary registry?

`companyos inspect` and `companyos inspect-core` turn these questions into a
structured Architecture Fitness Report. `companyos validate` and
`companyos docs check` enforce the deterministic subset.
