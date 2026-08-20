---
document_id: governance.versioning
title: Core and Workspace Versioning Policy
kind: governance
status: approved
authority: canonical
language: en
updated: 2026-08-19
owners:
  - core-maintainers
audience:
  - human
  - agent
relations:
  depends_on:
    - vision.companyos
    - architecture.company-instance
---

# Core and Workspace Versioning Policy

Oregano Core and every Company Workspace use Semantic Versioning 2.0.0. Their
release versions are independent because generic platform behavior and one
company's operating model evolve at different rates. An exact Git commit stays
mandatory for reproducible builds: a release version describes compatibility
and change significance; a commit identifies the exact source.

The initial Oregano Core release line is `0.1.0`. Each Company Workspace starts
and advances its own independent release line. The leading zero already
declares initial development without a stable public API. `alpha` is therefore
not a permanent maturity label.

## Number meaning before 1.0

| Position | Increment when | Example |
|---|---|---|
| `MAJOR` | Move to `1.0.0` only after the public contract, migration, recovery, and support gates are explicitly approved. After 1.0, increment for an incompatible public-contract change. | `0.8.4` to `1.0.0`; later `1.6.2` to `2.0.0` |
| `MINOR` | Add a feature or capability, introduce an incompatible pre-1.0 contract change, or require a Core/Workspace migration or operator decision. | `0.1.4` to `0.2.0` |
| `PATCH` | Deliver a backward-compatible correction, hardening, documentation or CI improvement, or internal refactor that requires no consumer migration. | `0.1.0` to `0.1.1` |

The highest-impact included change determines the release increment. A security
fix is a patch only when it preserves compatibility; a security change that
requires migration is a minor release before 1.0.

For a Company Workspace, a new or incompatible workflow, agent contract, Tool
contract, policy shape, or operating-data migration is a minor change. A
compatible content correction, instruction clarification, or implementation
fix is a patch. Ordinary commits do not each receive a version: the version is
bumped by an explicit release Change Plan when a reviewed set of changes is
released.

## Pre-release identifiers

Use `-alpha.N`, `-beta.N`, or `-rc.N` only for distributable candidates of one
specific target release:

- `0.2.0-alpha.1`: incomplete internal candidate;
- `0.2.0-beta.1`: feature-complete pilot candidate;
- `0.2.0-rc.1`: release candidate with only blocking corrections expected;
- `0.2.0`: accepted release.

The Workbench may use an explicit experimental candidate series such as
`0.1.0-experimental.3` before its first published package. Pre-release labels
are dot-separated identifiers, not a fourth numeric version position.

Do not use leading zeroes (`01`, `001`, or `0.01.0`), four-part product
versions, dates as product versions, branch names, or floating tags in the
Core/Workspace release fields. Build metadata may identify an artifact but
does not replace the exact commit recorded in provenance.

## Canonical fields and release procedure

- Oregano Core version: root `package.json` `version`.
- Company Workspace version: `company.md` `workspace_version`.
- Workspace Core expectation: `.companyos/compatibility.yaml` `core.version`
  plus the immutable `core.ref` commit.
- Deployed evidence: Artifact provenance and the Instance health response
  record Core and Workspace version plus both commits.

An Agent Contributor preparing a release MUST:

1. classify every included change and select the highest required increment;
2. create an approved release Change Plan;
3. update the canonical version field and compatibility pin in the same change;
4. run `companyos versions`, validation, Inspection, and the relevant tests;
5. build from clean exact commits and verify Artifact/health provenance;
6. create the immutable `v<version>` repository tag only after the protected
   release commit is merged; and
7. record migration and rollback whenever the minor or major position changes.

## Decision evidence

[Semantic Versioning 2.0.0](https://semver.org/) defines `0.y.z` for initial
development and defines optional pre-release identifiers. OpenClaw's official
release history began at [`v0.1.1`](https://github.com/openclaw/openclaw/releases/tag/v0.1.1)
without a pre-release suffix before later changing schemes. Gbrain's repository
began with [`v0.1.0`](https://github.com/garrytan/gbrain/commit/b22cbd349ac2787ca47da98a7026a3a923f82006)
and later adopted a project-specific four-part scheme. CompanyOS keeps the
portable three-part SemVer contract instead of copying either project's later
release cadence.
