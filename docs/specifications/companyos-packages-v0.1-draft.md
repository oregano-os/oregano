---
document_id: specification.companyos-packages-v0.1
title: CompanyOS Packages Specification v0.1
kind: specification
status: building
authority: normative
language: en
updated: 2026-08-22
owners:
  - oregano-maintainers
audience:
  - human
  - agent
relations:
  depends_on:
    - vision.companyos
    - architecture.ecosystem-packages
    - architecture.boundaries
    - specification.companyos-core-v0.7
    - specification.tool-architecture
---

# CompanyOS Packages Specification v0.1

This document defines the draft public contract for portable CompanyOS
Packages. It makes the open ecosystem architecture testable without claiming
that Package loading, publishing, registry services, Tool activation, or
Connector activation are implemented.

Normative words `MUST`, `MUST NOT`, `SHOULD`, and `MAY` carry their usual
requirements meaning.

## 1. Scope and status

Version 0.1 defines three Package kinds:

1. `blueprint` for declarative Workspace Components;
2. `tool` for restricted code that consumes Core-owned Capabilities; and
3. `connector` for privileged implementations of Core-owned Capabilities.

The first implementation slice MUST support inspection before it supports
mutation. Blueprint installation is the first planned end-to-end path. Tool
activation is blocked until the ToolSet Resolver, Tool SDK, and grant
enforcement exist. External Connector activation is blocked until privileged
isolation, publisher provenance, Instance binding, and Connector conformance are
proved.

### 1.1 Current implementation profile: Contract Foundation Lite

The experimental Workbench currently implements only:

- `companyos package inspect <local-directory>` with human and JSON output;
- JSON Schema-backed structural validation plus semantic identity, CompanyOS
  specification range, Package contract, path, canonical-reference,
  type-specific Component entrypoint, permission, lifecycle, link, hardlink,
  credential-indicator, declarative file allowlist, and Blueprint runtime-code
  checks;
- full local inspection for `blueprint` Packages;
- recognition of `tool` and `connector` kinds with an explicit unsupported
  verdict; and
- Compatibility Registry checks as part of `companyos docs check` and
  `companyos inspect-core`.

The JSON Schema source is `packages/cli/src/package-manifest.schema.json` and is
executed by the Inspector as the structural manifest authority. The current
experimental implementation evaluates `compatibility.companyos_spec` against
CompanyOS specification version `0.7.0`, which represents the v0.7 draft
implementation profile and is declared once in the Compatibility Registry.
Changing that implementation version requires the same-change schema,
Inspector, fixture, compatibility, documentation, and migration review.
Repository-local neutral fixtures are implementation evidence, not yet a
public versioned Contract Test Kit. The current command performs no install,
plan, apply, lock, update, remove, acquisition, activation, or execution.

## 2. Package, Component, and Capability

A Package is the unit of identity, publication, acquisition, versioning,
integrity, ownership, update, and removal. A Package declares exactly one kind.

A Component is a logical artifact carried by a Package. A Blueprint Package MAY
contain any number of the following Component types:

- `agent`;
- `workflow`; and
- `skill`.

A Capability Contract is a versioned Core-owned provider-neutral interface. It
is not a Package, Component, Tool grant, provider binding, or approval. A
Connector Package MAY implement Capabilities. A Tool Package MAY require
Capabilities. A Package MUST NOT redefine a Capability under an existing Core
identifier.

## 3. Package identity and manifest

Every Package MUST contain one root `companyos.package.yaml` manifest. The
manifest MUST be inspectable without importing or executing Package runtime
code.

The minimum manifest fields are:

```yaml
schema_version: 1
id: example.publisher/sprint-agent
version: 0.1.0
kind: blueprint
name: Sprint Agent
description: Governed sprint planning Components
license: Apache-2.0
publisher:
  id: example.publisher
compatibility:
  companyos_spec: ">=0.7 <0.8"
  package_contract: "1"
components:
  agents: []
  workflows: []
  skills: []
requires:
  tools: []
  capabilities: []
permissions:
  runtime_code: false
  network: []
  secret_refs: []
tests:
  fixtures: []
```

Package IDs MUST use a registry-independent `namespace/name` form and remain
stable across registries and mirrors. A Registry proves control of a namespace;
the string alone proves no identity. Versions MUST be valid semantic versions.
The license field MUST use a declared SPDX expression or an explicit Registry
policy identifier.

The manifest MUST declare all Components, runtime entrypoints, required and
provided Capability Contracts, requested permissions, and conformance fixtures
that affect inspection or activation. Runtime registration MUST match the
static manifest.

Artifact digests, Registry verification, security verdicts, and signatures MUST
be stored in the source or Registry envelope and resulting lock or ledger. A
Package MUST NOT claim trust by embedding an unverifiable badge in its own
manifest.

## 4. Common content rules

All selected Package paths MUST be relative, remain inside the Package root,
and identify regular files. Package inspection MUST reject escaping paths,
symlinks, hardlinks, device files, duplicate canonical paths, undeclared
runtime entrypoints, embedded credentials, and Package lifecycle scripts.

The initial Blueprint Inspector uses a conservative declarative content
allowlist. It accepts Markdown, structured text data, plain text, selected
raster image and font assets, and extensionless `LICENSE` or `NOTICE` files. It
rejects runtime source and binary formats, active document formats, unknown
extensions, executable mode bits, hidden control directories, and known or
credential-like secret indicators. Adding a format is a security change and
requires evidence that it cannot create an executable or authority bypass.

Agent Component references MUST resolve to an
`agents/<agent-id>/instructions.md` entrypoint. Workflow Component references
MUST resolve to a Markdown entrypoint under `workflows/`. Skill Component
references MUST resolve to `SKILL.md` in a `skills` directory. Fixture
references MUST identify regular files. References that normalize to the same
canonical path MUST be rejected even if their source strings differ.

Package builds MUST be deterministic for identical selected inputs. Ambient
files, source-control state, caches, local configuration, credentials, prior
artifacts, and unselected files MUST NOT enter the artifact.

Version 0.1 Packages MUST NOT declare transitive Package dependencies. They MAY
declare required Tool and Capability identifiers. Missing requirements are
reported by planning and resolution; they are never installed implicitly.

## 5. Blueprint Package contract

A Blueprint Package materializes reviewable Company Workspace files through a
Workbench plan. It MAY contain Agent Blueprints, Workflow Templates, Skills,
SOPs, examples, tests, and non-executable assets.

A Blueprint Package MUST NOT contain runtime code, Package lifecycle scripts,
resolved secrets, provider credentials, real principals, completed approvals,
Instance bindings, or active grants. It MAY declare recommended grants and
requirements as proposals that remain visibly unapproved in the generated
Workspace diff.

Applying a Blueprint Package MUST:

1. validate the exact artifact and manifest;
2. produce a complete Workspace diff and Change Plan;
3. report collisions, missing requirements, change class, and readiness impact;
4. preserve existing user-owned files unless the reviewed plan explicitly
   changes them; and
5. record Package origin and managed or referenced file provenance in the
   Workspace Package lock.

Apply does not merge, grant, bind, activate, deploy, or execute the result.

## 6. Tool Package contract

A Tool Package contains portable Tool contracts and restricted Tool SDK code.
It MUST declare each Tool ID, version, input and output schemas, minimum risk,
data class, idempotency rule, required Capabilities, expected evidence, failure
semantics, implementation entrypoint, and contract tests.

Tool Package code MUST NOT access provider SDKs, undeclared network endpoints,
environment secrets, direct databases, runtime internals, approval stores, or
effect primitives. The Tool SDK is its only execution boundary.

Installation MUST NOT expose a Tool to an agent. Availability additionally
requires an explicit grant, compatible scope and policy, available Instance
Capabilities, deterministic ToolSet resolution, and runtime enforcement. An
installed but ungranted or unresolved Tool MUST remain undiscoverable and
uncallable by the agent runtime.

The same execution restrictions apply to a published Tool Package and a local
Company Tool. Publication changes distribution and ownership, not authority or
runtime privilege.

## 7. Connector Package contract

A Connector Package contains privileged provider code that implements one or
more Core-owned Capability Contracts. It MAY own provider authentication,
request translation, rate limiting, retry, provider evidence, read-after-write,
and provider-specific diagnostics.

It MUST declare:

- every implemented Capability Contract and version;
- runtime entrypoints;
- network destinations;
- SecretRef types without resolved values;
- data classes and minimum effect risks;
- idempotency, retry, reconciliation, and failure behavior;
- setup, health, and removal diagnostics; and
- Connector conformance fixtures.

Connector Packages are installed and bound in a Company Instance. They MUST NOT
be copied into a Company Workspace, assign agent grants, embed company policy,
or make a Capability available without an explicit compatible binding.

External Connector activation MUST fail closed until the approved privileged
isolation, publisher provenance, signing, binding, and conformance requirements
are implemented.

Communication providers are Connector Packages in version 0.1. A separate
Channel Package kind is not defined.

## 8. Inspection, installation, and planning

Every source type MUST use the same canonical Package Inspector. Version 0.1
anticipates local directories, exact Git references, Registry versions, mirrors,
and forks. A source adapter MUST NOT weaken manifest, path, compatibility,
permission, integrity, or policy checks.

Inspection is read-only and MUST report at least:

- Package identity, kind, publisher claim, license, source, and exact version;
- artifact and manifest integrity when available;
- Components, runtime entrypoints, provided and required contracts;
- requested permissions and trust tier;
- compatibility, deprecation, advisory, yank, and revocation state;
- proposed placement and missing prerequisites; and
- whether the current implementation supports installation or activation.

The current local report exposes the publisher claim, license, source kind and
location, declared and current CompanyOS specification versions, compatibility
verdict, trust tier, Component list, requested requirements and permissions,
and explicit inspection, installation, and activation support states. These are
inspection facts, not publisher verification or authority.

Installation MUST bind the exact inspected artifact and resulting plan. Floating
versions, `latest`, silent fallback, and automatic upgrades MUST NOT enter a
deployment lock. If source, destination, policy, compatibility, or live managed
state changes after review, apply MUST fail and require a new plan.

## 9. Resolution, grants, bindings, and activation

The lifecycle stages are separate state transitions:

```text
Discover -> Acquire -> Inspect -> Plan -> Apply -> Grant/Bind -> Resolve -> Activate -> Execute
```

Acquisition obtains an exact untrusted artifact. Inspection is read-only. Plan
precedes every mutation. Apply performs only the reviewed placement change and
records the exact installed artifact. No Package may grant or bind itself.
Workspace authorities approve content and Tool grants. A Platform Administrator
configures Connector installation, accounts, SecretRefs, and Instance bindings.
Resolution follows those explicit inputs. Runtime approval remains bound to the
exact effect and is never inherited from Package installation or activation.

The ToolSet Resolver MUST include installed Package identity, version, manifest
digest, contract versions, grants, bindings, scopes, policy, and availability in
its material inputs. Any material Package or compatibility change MUST change
the resolved ToolSet hash.

## 10. Lock and deployment provenance

The versioned Workspace Package lock records Blueprint and Tool Package origin:

- Package ID and exact version;
- exact source and artifact digest;
- manifest digest and Package contract version;
- selected Components and Tool contracts;
- managed and referenced files;
- resolved public contract versions;
- advisory and verification snapshot when available; and
- reviewed plan digest.

The Instance Package ledger records Connector installation and binding origin,
exact versions and digests, contract implementations, trust and advisory state,
binding identifiers, and health evidence. It MUST contain SecretRefs, never
resolved secret values.

Deployment provenance MUST include the Workspace Package lock hash and Instance
Package ledger hash when present. Update or removal of a Package is a new
governed plan and MUST NOT erase historical deployment or execution evidence.

## 11. Compatibility Registry

Every public CompanyOS contract MUST have a stable ID and an entry in the
Compatibility Registry. An entry records:

- contract version and stability;
- accountable owner;
- introduction date;
- specification and conformance tests;
- deprecation date and replacement when applicable; and
- removal date or explicit removal gate when applicable.

Allowed stability values are `internal`, `experimental`, `stable`, and
`deprecated`. Exporting or documenting an interface does not make it stable.
Experimental contracts MAY change only through a Change Plan that updates the
Registry, affected Packages, tests, documentation, and migration guidance.

A stable public contract MUST NOT be removed in the same release that introduces
its replacement. Removal requires a named compatibility record, migration path,
test coverage for old and new behavior, an announced window, and explicit Core
Maintainer approval.

## 12. Contract Test Kit

CompanyOS MUST provide public, versioned conformance suites without requiring a
real Company's content or secrets.

The common Package suite covers manifest validity, path safety, deterministic
artifacts, declared content, compatibility, and absence of lifecycle scripts or
credentials.

The Blueprint suite additionally covers declarative-only content, authority and
binding absence, reference validity, collision reporting, deterministic diffs,
and managed-file provenance.

The Tool suite additionally covers SDK boundaries, schemas, risk, Capability
requirements, idempotency, evidence, failure behavior, and absence from the
runtime without a resolved grant.

The Connector suite additionally covers static Capability ownership, runtime
registration agreement, SecretRef boundaries, provider translation, retry,
idempotency, reconciliation, evidence, health, and removal behavior.

A test badge or successful suite is evidence of contract conformance, not
security certification or company authority.

The current Lite implementation contains the common Blueprint security
fixtures inside Oregano Core. Publishing those fixtures as a supported,
versioned Contract Test Kit is deferred until an external contributor or a
second independent Package author needs to consume them.

## 13. Open Package Registry

The Package Registry is an independent open product and protocol. It owns
publisher namespaces, immutable versions, artifact locations and digests,
compatibility metadata, advisories, yanks, revocations, and discovery indexes.
It owns no grants, bindings, approvals, activation, deployment, or runtime state.

The official Registry MUST NOT be required to inspect or use a Package from a
local, exact-Git, mirrored, or forked source. Registry implementations MUST NOT
change Package semantics or bypass Workbench inspection.

Published versions are immutable. A yank hides a version from ordinary new
selection but preserves exact resolution and history. A security revocation is
a fail-closed activation input according to security policy; it does not delete
historical provenance.

## 14. Update and removal

Update and removal MUST use the same Inspector and plan-integrity rules as
installation. The plan distinguishes:

- **managed** resources introduced and still owned by the Package; and
- **referenced** resources that pre-existed or are shared independently.

Removal MAY delete unchanged managed resources when no conflicting owner
exists. It MUST preserve modified, user-owned, independently referenced, or
uncertain resources and report the resulting partial state. External mutations
that cannot be proven compensated MUST stop with explicit partial provenance.

## 15. Deferred extension points

Version 0.1 defines no Workbench, Runner, Module, or separate Channel Package
kind. Their architecture options, evidence triggers, and admission gates are
maintained in `architecture.ecosystem-packages`. They MUST NOT be introduced by
relabeling privileged code as a Blueprint, Tool, or Connector.

## 16. Required acceptance tests

Before Blueprint installation is implemented:

- invalid or ambiguous manifests fail;
- path escape, links, lifecycle scripts, and credential fixtures fail;
- planning is read-only and deterministic;
- apply rejects plan drift and file collisions;
- Blueprint content cannot assign principals, grants, approvals, or bindings;
- exact source and managed-file provenance are locked; and
- update and removal preserve user-owned or modified files.

Before Tool activation is implemented:

- the ToolSet Resolver and Tool SDK requirements from the Tool Architecture
  Specification pass; and
- installed but ungranted or unresolved Tools are neither discoverable nor
  callable.

Before external Connector activation is implemented:

- privileged isolation, publisher provenance, signing, binding, compatibility,
  health, evidence, retry, reconciliation, and removal contracts pass with at
  least one real provider implementation.

## 17. Open decisions

This draft does not silently choose:

1. the Oregano Core, Registry implementation, or Package license policies;
2. publisher identity, signing, transparency, scanning, and revocation vendors;
3. Registry transport, artifact storage, mirroring, or federation;
4. the exact public Tool SDK and Connector SDK APIs;
5. privileged Connector process or sandbox isolation; or
6. commercial, private, or paid Package policy for public Registry listings.

Each decision requires a Core Change Plan and corresponding compatibility,
governance, status, migration, and test updates.
