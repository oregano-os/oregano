---
document_id: governance.ecosystem-trust
title: Ecosystem Contribution and Trust
kind: governance
status: approved
authority: canonical
language: en
updated: 2026-08-14
owners:
  - core-maintainers
audience:
  - human
  - agent
relations:
  depends_on:
    - vision.companyos
    - architecture.ecosystem-packages
    - specification.companyos-packages-v0.1
---

# Ecosystem Contribution and Trust

Open publication and company authority are separate. Anyone may propose or
publish a compatible Package subject to source and Registry policy. No
publisher, Registry operator, badge, maintainer status, install action, or test
result grants authority inside a Company Workspace or Company Instance.

## Ecosystem responsibilities

| Responsibility | Authority | Does not imply |
|---|---|---|
| Package Maintainer | maintains one Package, releases, migrations, tests, and security response | Core contract ownership or company approval authority |
| Publisher Administrator | controls one Registry namespace and its Package ownership assignments | trust of Package behavior or Instance access |
| Registry Operator | operates catalog, artifact, moderation, yank, and advisory services | permission to activate a Package for a company |
| Ecosystem Security Responder | investigates reports and issues advisories or revocation recommendations under policy | unilateral Company Workspace grants or effect approval |
| Core Maintainer | owns Package, Capability, SDK, compatibility, and conformance contracts | authority over a company's policies, principals, bindings, or approvals |

These are ecosystem responsibilities, not CompanyOS authority roles. A person
may hold more than one responsibility, but every action records which authority
or responsibility was exercised.

## Publication requirements

A public Package release MUST provide:

- a valid Package manifest and immutable version;
- a declared license and source-availability status;
- an accountable Package Maintainer and security contact;
- exact source and artifact integrity;
- supported CompanyOS contract versions;
- the conformance evidence required for its Package kind;
- release notes and migration guidance for material changes; and
- no secrets, real company data, completed approvals, or hidden install code.

Registry acceptance proves that the publication contract was satisfied. It does
not prove that the Package is appropriate for a particular company.

## Trust and certification

Trust claims MUST name the exact evidence and Package version. CompanyOS does
not use one universal “trusted” label across Package kinds.

- Blueprint conformance covers declarative content and safe materialization.
- Tool conformance covers the restricted Tool SDK and Tool contract.
- Connector conformance covers privileged implementation, binding, provider,
  reconciliation, and lifecycle behavior.
- Security review, publisher verification, provenance verification, and company
  approval are separate claims.

Official or bundled Packages MUST pass the same static, compatibility, advisory,
and provenance checks as third-party Packages. Official status may define
ownership and support; it is not a security bypass.

## Namespace and ownership lifecycle

Registry namespaces have explicit owners and administrators. Package ownership
transfer requires evidence from the current owner or an auditable dispute and
recovery process. Namespace reuse after abandonment MUST preserve redirects and
history and MUST NOT silently transfer trust to unrelated code.

Published versions are immutable and are never replaced in place. A Package MAY
be yanked to discourage new selection while preserving exact locked resolution.
A security advisory or revocation remains visible with the affected versions,
replacement guidance, and evidence. Historical deployment records are retained.

## Compatibility and deprecation

Package Maintainers own migration within their Package. Core Maintainers own
migration of public CompanyOS contracts. A breaking contract change requires a
Compatibility Registry update, replacement guidance, tests for supported old
and new paths, and the announced migration window defined by Core policy.

Popularity, lack of current downloads, or maintainer convenience is not proof
that a public contract can be removed.

## Registry openness

The official Package Registry implementation and protocol are governed as an
open product. The manifest, compatibility data, Inspector behavior, lock
semantics, and conformance suites remain usable with local sources, exact Git
references, mirrors, forks, and independent registries.

Registry discovery metadata cannot patch a manifest, grant permissions, weaken
Workbench inspection, or change a locked artifact. A Registry outage cannot
invalidate already verified local artifacts, although current revocation policy
may require fresh advisory evidence before a new activation.

## Contribution paths

Contract Foundation Lite currently accepts local Blueprint inspection backed by
Core-internal neutral fixtures. Public contribution paths open only after the
corresponding versioned Contract Test Kit and contribution policy exist.

1. Blueprint Packages use the public manifest, Blueprint Contract Test Kit, and
   reviewable example Workspace.
2. Tool Packages additionally require the public Tool SDK, Tool contract tests,
   and evidence that the ToolSet Resolver keeps ungranted Tools unavailable.
3. Connector Packages additionally require privileged review, provider
   conformance, binding, health, provenance, and security response evidence.
4. A new Capability Contract is a Core proposal with at least one implementation
   and one provider-neutral consumer; it is not smuggled into a provider Package.
5. A repeated ecosystem need may promote a deferred extension point only through
   its documented admission gate and a new Core Change Plan.

## Decisions required before public launch

Before accepting public Package releases, Core Maintainers MUST approve:

- Oregano Core and Registry software licenses;
- contributor terms and repository governance;
- vulnerability reporting and response policy;
- publisher identity and namespace recovery;
- signing, provenance, scanning, advisory, and revocation policy; and
- support and deprecation expectations for stable public contracts.

These decisions are intentionally open. Openness is an architectural commitment;
selecting a particular legal or trust mechanism still requires explicit human
authority.
