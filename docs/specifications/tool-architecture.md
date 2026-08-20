---
document_id: specification.tool-architecture
title: Tool Architecture Specification
kind: specification
status: building
authority: normative
language: en
updated: 2026-08-19
owners:
  - core-maintainers
audience:
  - human
  - agent
relations:
  depends_on:
    - specification.companyos-core-v0.7
    - architecture.boundaries
---

# Tool Architecture Specification

This document is the controlled English successor to the normative German v0.6
Tool supplement. Implemented and missing portions are separated explicitly.

## 1. Four layers

1. **Core mechanisms** enforce identity, approval, effect state, idempotency,
   evidence, and run pinning. They are not model Tools.
2. **Connector capabilities** provide controlled technical access to external
   systems, including authentication, rate limits, retry policy, provider
   evidence, and read-after-write.
3. **Oregano standard Tools** expose reusable, company-neutral agent
   operations implemented and versioned in Core.
4. **Company Tools** compose granted capabilities for one company's domain and
   live with the responsible agent in its Company Workspace.

A Capability Contract is a provider-neutral Core contract, not a Package or
grant. A Connector implementation supplies a Capability. A Tool is an
agent-callable operation that may require one or more Capabilities. Distribution
ownership and runtime availability are therefore separate.

Deterministic business machines—such as progression calculation, escalation
timers, and scheduling—are generic Core modules parameterized by Workspace
files. They are not Company Tools or company-specific Core forks.

## 2. Tool contract

A Tool has a stable ID, human-readable description, input and output schemas,
minimum risk, data class, idempotency rule, required capabilities, expected
evidence, failure semantics, version, and implementation. A Tool is not a
workflow, connector, approval, scheduler, StateStore, or runtime adapter.

Missing risk defaults to R3. Effective effect risk is the maximum of the
workflow step, Tool minimum, connection operation, policy override, spend, and
blast-radius constraints.

## 3. Namespaces and grants

```yaml
tools:
  - oregano:sprint/write-card-field
  - company:calculate-weekly-facts-log
```

`oregano:<module>/<tool>` resolves against the exact Core catalog and is never
copied into the Workspace. `company:<tool>` resolves relative to the owning
agent's `tools/<tool>/` directory and becomes a role-qualified runtime ID.

File existence does not grant use. Effective availability requires all of:

- a resolvable implementation in the exact Core/Workspace pair;
- an explicit agent grant;
- compatible agent scope;
- permitted connection capabilities;
- available Instance configuration;
- policy and risk requirements.

Unknown, duplicate, ambiguous, unavailable, or scope-incompatible grants MUST
fail closed.

## 4. Local Company Tool

```text
agents/<agent-id>/tools/<tool-id>/
├── TOOL.md
├── execute.ts
└── tests/
```

`TOOL.md` is the accountable contract. `execute.ts` may call only the approved
Oregano Tool SDK. It MUST NOT import a runtime, provider SDK, network client,
environment secrets, or direct database client. It cannot call Core approval or
effect primitives directly.

Company Tool changes and Tool grants are security-class Workspace changes. A
new Tool begins at R3 until evidence justifies a stricter declared lower bound
that is still no lower than any capability effect.

A published Tool Package uses the same Tool contract, Tool SDK restriction,
risk floor, resolution, and grant rules. Publication changes how the Tool is
distributed and maintained; it does not increase runtime privilege. Its exact
Package source, version, manifest digest, and managed provenance are recorded in
the Workspace Package lock defined by `specification.companyos-packages-v0.1`.

## 5. Deterministic resolution

The **ToolSet Resolver** (not “Revolver”) is the deterministic compiler between
what exists and what one agent may actually use. A Tool is an available
capability; a grant is an explicit request to make that capability available
to one agent. Neither is sufficient on its own.

```mermaid
flowchart LR
  C["Core Tool Catalog"] --> R["ToolSet Resolver"]
  T["Company Tool declarations"] --> R
  P["Installed Tool Package contracts"] --> R
  G["Agent grants"] --> R
  W["Workspace policies and scopes"] --> R
  I["Instance Connector implementations and bindings"] --> R
  R --> M["Resolved ToolSet"]
  M --> X["Runtime registers only these Tools"]
```

The resolver performs the following steps without model judgment:

1. read the exact Core catalog, Company Tool declarations, installed Tool
   Package contracts, and Package lock;
2. resolve every explicit agent grant to exactly one implementation;
3. intersect the result with agent scope, Workspace policy, connection
   capabilities, and available Instance configuration;
4. compute effective risk and required approval metadata;
5. reject unknown, ambiguous, unavailable, or incompatible inputs; and
6. emit one ordered `ResolvedToolSet` manifest per agent.

The manifest includes exact Tool, module, and Package versions, manifest
digests, contracts, Connector implementations, capabilities, scopes, risks,
input hashes, and resolver version. Only this resolved set is registered with
the runtime. An agent cannot discover or call an installed but ungranted Tool,
and a grant cannot make an unavailable connection or forbidden scope usable.

The resolver is deterministic and LLM-free. Its output hash is recorded in
deployment and execution provenance. Identical material inputs MUST produce an
identical manifest and hash. Any material change to a contract, grant, scope,
policy, capability, connection binding, or version MUST change the hash.

Resolution decides availability and effective control metadata; it does not
approve an effect. Runtime approval and effect claiming remain separate Core
mechanisms.

The experimental implementation resolves local Company Tools against the Core
Capability catalog, Workspace connection allowlist, agent grants, and exact
Instance bindings. It rejects unknown, duplicate, ambiguous, unbound, and
disallowed inputs, raises effective risk to the Capability minimum, emits a
stable hash, and registers only resolved implementations. Standard Tool and
published Tool Package catalogs remain future inputs; the implementation does
not claim those distribution paths.

The reference production Artifact Connector implements `artifact.publish`
through Postgres and the Vercel Runner's public route. It accepts only bounded
artifact identifiers and approved text/HTML media types, rejects conflicting
content under an existing identifier, and returns a digest plus public URL as
real evidence. It does not implement paid marketing Capabilities.

## 6. Distribution

Production builds combine an exact Core checkout and an exact Company Workspace
checkout. Standard Tool code comes from the pinned Core revision; Workspace
files contain only their grants. Company Tool code comes from the exact
Workspace revision. Generated artifacts are disposable and record both commits.

The open Package ecosystem complements this deployed Core/Workspace pairing.
Blueprint and Tool Package origin is versioned in the Workspace Package lock;
Connector Package installation and binding is versioned in the Instance Package
ledger. Their hashes become deployment provenance inputs.

A future package distribution MAY replace the Core/Workspace co-checkout, but
must preserve exact version pairing, provenance, validation, signing, and
rollback. Silent upgrades and copying standard Tool source into a Workspace are
forbidden. Package installation alone does not grant, bind, activate, deploy, or
approve a Tool.

## 7. Duplication and graduation

Local Tools cannot import each other across agent scopes. If two agents need a
similar company-specific operation, the Process Steward chooses explicit
duplication, delegation to one responsible agent, or a proposal to graduate a
generic mechanism into Core.

Graduation requires evidence across companies, a company-neutral contract,
Core ownership, compatibility policy, generic tests, and migration. An agent
does not move code into Core merely because it looks reusable.

## 8. Required validation and tests

- unknown standard and Company grants fail;
- ungranted Tool is not callable;
- Company Tool forbidden imports fail;
- missing risk defaults to R3;
- scope/capability mismatch fails;
- same-named Company Tools remain role-qualified;
- installed published Tools without a resolved grant remain undiscoverable and
  uncallable;
- exact ToolSet hash is stable for identical inputs and changes for any
  material Package, contract, grant, scope, Connector, capability, binding, or
  version change;
- runtime registers only the resolved set;
- a Tool cannot bypass approval/effect control through direct provider access.
