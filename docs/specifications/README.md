---
document_id: specifications.index
title: CompanyOS Specifications
kind: index
status: building
authority: normative
language: en
updated: 2026-08-20
owners:
  - core-maintainers
audience:
  - human
  - agent
---

# CompanyOS Specifications

This subtree contains formal, normative CompanyOS requirements. Architecture
pages explain boundaries; specifications define testable contracts. Workbench
validation schemas implement the deterministic subset without replacing the
human-readable specification.

The controlled migration from the German v0.6 sources is in progress. Until a
translated specification is explicitly approved, the corresponding German
source remains the detailed reference and any ambiguity is listed in the
[Translation Exception Report](../reference/translation-exceptions.md).

No Agent Contributor may resolve a translation exception as a product decision.

## Active build target

- [CompanyOS Core Specification v0.7](companyos-core-v0.7-draft.md) — the
  consolidated English contract for the approved repository split and
  Workbench control plane; currently `building`, not yet `approved`.
- [Identity, Access, and Offboarding](identity-access-and-offboarding.md) —
  stable principals, roster authorization, approval identity, and retention.
- [Tool Architecture](tool-architecture.md) — Core mechanisms, capabilities,
  standard Tools, Company Tools, grants, resolution, and distribution.
- [CompanyOS Packages v0.1](companyos-packages-v0.1-draft.md) — the draft open
  contract for Blueprint, Tool, and Connector Packages, Capability ownership,
  lifecycle, compatibility, conformance, and Registry separation.
  — the approved English product, safety, placement, configuration, rollout,
  and evidence target for Sprint V1. The v0.3 profile and German PRDs are
  retained only as migration evidence.
- [Builder Governance](builder-governance.md) — proposal and change safety for
  the future Builder Agent; currently a draft, not an implemented capability.
- [Company Workspace Generator v0.1](workspace-generator-v0.1-draft.md) — the
  deterministic authoring-only Workspace creation contract used by the shared
  Codex and Claude Code runbook.
- [Core-to-Workspace Upgrades v0.1](core-workspace-upgrades-v0.1-draft.md) —
  separated assessment, proposal, and Instance-assistance boundaries.
- [Company Instance Release and Promotion v0.1](company-instance-release-and-promotion-v0.1-draft.md)
  — risk-based lanes and authority; the live setup implements only its
  documented Tool-free supervised starter subset.
