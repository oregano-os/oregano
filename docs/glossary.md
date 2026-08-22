---
document_id: reference.glossary
title: CompanyOS Glossary
kind: reference
status: approved
authority: canonical
language: en
updated: 2026-08-22
owners:
  - oregano-maintainers
audience:
  - human
  - agent
---

# CompanyOS Glossary

## System terms

### CompanyOS
The complete product and architecture: Oregano Core, a Company Workspace, its
Company Instance, and the governance that connects them.

### Oregano Core
The generic executable platform. It contains runtime-neutral control logic,
runner adapters, StateStore implementations, modules, enforcement, schemas,
the CompanyOS Workbench, standard tools, and test fixtures. It contains no real
company's operating model.

### Company Workspace
The version-controlled, company-specific operating model in its own Git
repository. The physical repository may still be called a “company repo”, but
Company Workspace is the canonical architectural term.

### Company Instance
One deployed pairing of an exact Oregano Core version and an exact Company
Workspace version, connected to environment-specific infrastructure,
configuration, secrets, integrations, and operational state. An environment
is part of the identity, for example `acme-production` or `acme-staging`.

### CompanyOS Workbench
The versioned development environment for humans and agents who build and
maintain Company Workspaces. It provides CLI commands, Guides, planning,
inspection, validation, diagnostics, templates, and security checks.

### CompanyOS Toolchain
The technical distribution of the Workbench, initially the `@companyos/cli`
package. “Workbench” is the product-facing name; “toolchain” describes the
versioned artifact.

## Ecosystem terms

### CompanyOS Package
A versioned distribution and ownership unit with one manifest, one Package
kind, an exact source, and verifiable content. A Package may declare requested
Capabilities and recommended grants but cannot assign company authority,
principals, approvals, secrets, or Instance bindings. “Plugin” is not a
canonical CompanyOS term because it does not identify an execution or trust
boundary.

### Package Component
A logical artifact contained in a Package. Blueprint Packages may contain Agent
Blueprint, Workflow Template, and Skill Components. A Component is not an
independently installed Package unless it has its own manifest and version.

### Blueprint Package
A declarative CompanyOS Package that proposes reviewable Company Workspace
files. It may contain Agent Blueprints, Workflow Templates, Skills, SOPs, and
supporting assets. It cannot contain runtime code, assign authority, or bind an
Instance.

### Tool Package
A portable restricted-code CompanyOS Package that exposes Tools while using
only the approved Tool SDK and declared Capability Contracts. Installation does
not grant an agent access to its Tools. Local Company Tool resolution and
isolation are experimental; published Tool Package acquisition and activation
remain planned.

### Connector Package
A privileged CompanyOS Package that implements Core-owned Capability Contracts
for an external provider or technical surface. It is installed and bound in a
Company Instance, never as direct provider code in a Company Workspace.

### Capability Contract
A versioned, provider-neutral Core contract that describes a technical ability,
its schemas, failure behavior, evidence, idempotency, and minimum controls. A
Connector Package may implement a Capability Contract; a Tool Package may
require it. The contract is not itself an installable Package or a Tool grant.

### Package Registry
An open discovery and distribution service for Package metadata, immutable
versions, artifacts, publisher namespaces, compatibility, advisories, yanks,
and revocations. A Registry is not a source of company authority and the
official Registry is not required for local, Git, mirrored, or forked sources.

### Marketplace
A human-facing discovery experience over one or more Package Registries. Search
results, ratings, certification, and install actions do not authorize runtime
use.

### Package installation
The governed act of making one exact Package version and its provenance part of
managed CompanyOS state. Installation does not imply a Tool grant, Instance
binding, activation, or per-effect approval.

### Package activation
The inclusion of an installed Package and its resolved contracts in one exact
CompanyOS deployment. Activation remains separate from installation, grants,
bindings, and runtime approval.

### Compatibility Registry
The canonical machine-readable inventory of public CompanyOS contracts, their
versions, stability, owners, replacement guidance, and required tests. It is
distinct from a Package Registry.

### Contract Test Kit
Public fixtures and reusable conformance suites that test one Package or
implementation against a declared CompanyOS contract without requiring access
to a real company's secrets or operating model.

## Operational readiness terms

### Workspace mode
The declared structural state of a Company Workspace. `authoring-only` permits
governed authoring through the Builder entrypoint but no operating agents or
executable workflows. `operating` requires at least one operating agent and
one workflow. The field is `workspace_mode` in `company.md`.

### Execution mode
The declared operating model of one workflow. `supervised` requires a human to
remain in the execution loop. `unattended` permits the workflow to advance
without continuous human participation, subject to effect-level R0–R4 rules,
Tool grants, approvals, and verified enforcement. The field is
`execution_mode` in workflow frontmatter.

### Instance readiness
A derived claim about one exact Core, Workspace, and environment pairing. Its
levels are `declared`, `validated`, and `enforced`. Readiness is computed from
artifacts and evidence; it is never self-declared in `company.md`.

CompanyOS deliberately has no global A/B/C conformance profile. Workspace
structure, workflow execution, Instance evidence, and effect risk are separate
dimensions and must not be collapsed into one maturity label.

## Contributor terms

### CompanyOS Contributor
Any human or agent that proposes or implements a change to a CompanyOS
artifact. Contributor status describes participation, never approval authority.

### Workspace Contributor
A CompanyOS Contributor working in a Company Workspace. The term includes
employees, external specialists, founders, partners, and agents.

### Core Contributor
A CompanyOS Contributor working in Oregano Core. Core changes additionally
require the authority and review defined by Core governance.

### Human Contributor
A human CompanyOS Contributor. Employment or contract type is irrelevant to
the engineering process; `external` is used only when access lifecycle or
contract expiry matters.

### Agent Contributor
An automated CompanyOS Contributor, such as Codex or Claude Code. An Agent
Contributor receives no authority from its model, prompt, or contributor type.

### Builder Agent
The future governed CompanyOS agent under `agents/builder/` that proposes
Company Workspace changes from authorized requests. This name is reserved for
that product component and is not a synonym for Contributor.

## Authority roles

### Workspace Steward
A human entrusted to approve protected Company Workspace changes. This is a
governance role, not a statement about legal ownership and not automatically a
GitHub administrator.

### Process Steward
A human accountable for the behavior of one company process and authorized to
review its workflow or SOP changes within the Workspace governance policy.

### Platform Administrator
A technical role that administers CompanyOS hosting without gaining business
approval authority. Its separately assignable `repository` scope covers Git
hosting, access, CODEOWNERS, rulesets, and branch protection. Its `instance`
scope covers runtime hosting, state, provider installations, environment
variables, secrets, deployment, observability, backup, and recovery. One person
may hold both scopes or a company may assign them separately.

### Oregano Maintainer
The accountable human authorized to change Oregano Core invariants, schemas,
runtime code, and Workbench releases. One person may hold this role; it does
not imply a mandatory second maintainer.

### GitHub code owner / CODEOWNERS reviewer
A GitHub user or team selected by path through `.github/CODEOWNERS`. This is a
technical review mapping, not a separate CompanyOS authority role. Protected
Workspace paths normally map to the appropriate Steward team.

## Validation terms

### Validation
Deterministic, LLM-free checks that return pass/fail diagnostics and never
mutate the target. Validation answers whether a document, Workspace, or
Core/Workspace pairing satisfies formal rules.

### Inspection
A structured architecture review against the Vision. Inspection combines
machine-discovered facts with explicit human or agent judgment. Its presence
can be enforced mechanically; the quality of judgment still requires review.

### Change Plan
A machine-readable statement of objective, placement, change class, affected
principles, expected files, approvals, tests, documentation impact, rollback,
and open decisions.

### Change Report
The post-change comparison of the approved plan with the actual diff,
validation evidence, Architecture Fitness findings, and remaining gaps.
