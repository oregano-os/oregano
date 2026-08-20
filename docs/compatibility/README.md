---
document_id: compatibility.index
title: CompanyOS Compatibility Registry
kind: reference
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
    - specification.companyos-packages-v0.1
---

# CompanyOS Compatibility Registry

The Compatibility Registry is the canonical machine-readable inventory of
public CompanyOS contracts. It is not the Package Registry: it governs the Core
contracts that Packages and implementations may rely on.

The seed registry is [`registry.yaml`](registry.yaml). It is intentionally
small. A contract enters it when CompanyOS exposes that contract to an external
Package or implementation, not merely because an internal symbol exists.

Each record declares:

- stable contract ID and version;
- stability: `internal`, `experimental`, `stable`, or `deprecated`;
- accountable owner;
- introduction date;
- normative specification;
- implementation state;
- conformance tests; and
- replacement and removal information when applicable.

The top-level `companyos_spec` record declares the exact current specification
implementation, every specification version this Workbench can inspect against,
and the normative specification document. Package compatibility ranges are
evaluated against `companyos_spec.current`; the value is not duplicated as an
independent Inspector constant.

The Workbench validates the current Registry structure, unique contract
versions, stability values, owners, specification references, tests, and
deprecation fields through `companyos docs check` and `companyos inspect-core`.
The Registry is still experimental: these checks do not yet provide generated
compatibility documentation, multi-version resolution, or a public
deprecation-window automation service. Empty or planned test references are
not implementation evidence.

Adding, stabilizing, deprecating, or removing a public contract is a governed
Core change. The same Change Plan updates this registry, specifications, tests,
migration guidance, and current status.
