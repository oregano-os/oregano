---
document_id: docs.index
title: CompanyOS Documentation
kind: index
status: approved
authority: canonical
language: en
updated: 2026-09-02
owners:
  - oregano-maintainers
audience:
  - human
  - agent
---

# CompanyOS Documentation

This directory is the single canonical documentation tree for CompanyOS and
Oregano Core. It is written for Human Contributors, Agent Contributors, and a
future public documentation website.

## Start here

1. [Vision](vision.md) — the North Star and architecture fitness principles.
2. [Glossary](glossary.md) — canonical names for the system's parts and roles.
3. [Architecture overview](architecture/overview.md) — how the parts interact.
4. [System of Proof](architecture/system-of-proof.md) — how versions,
   approvals, effects, records, knowledge, and provider receipts form one
   explainable evidence chain.
5. [Ecosystem and packages](architecture/ecosystem-and-packages.md) — how
   portable contributions remain separate from company authority.
6. [Current status](status/current.md) — what is real, simulated, or planned.
7. [Workbench](workbench/overview.md) — how humans and agents change Core and Company Workspaces.
8. [Onboarding](onboarding/README.md) — how a new Workspace reaches protected collaboration safely.
9. [Documentation rules](governance/documentation-rules.md) — authority, metadata, and maintenance.
10. [Versioning policy](governance/versioning-policy.md) — how Core, Workspace,
   and prerelease versions are numbered and advanced.

## Source-of-truth map

| Question | Canonical location |
|---|---|
| What outcome must CompanyOS optimize for? | `docs/vision.md` |
| What does a term mean? | `docs/glossary.md` |
| Where does a capability belong? | `docs/architecture/` |
| What is formally required? | `docs/specifications/` |
| Which public contracts are stable or changing? | `docs/compatibility/` |
| What is implemented now? | `docs/status/current.md` |
| What evidence proves what ran, was approved, or changed externally? | `docs/architecture/system-of-proof.md` |
| How is a change made safely? | `docs/workbench/` and `docs/governance/` |
| Which Core or Workspace version should change? | `docs/governance/versioning-policy.md` |
| How is a new Workspace set up and verified? | `docs/onboarding/` |
| Why did an old prototype choose something? | approved public history under `docs/archive/` |

Authority is defined by concern, not by a global “one file beats all” rule. A
new decision is incomplete until every affected canonical document is updated
in the same change.

## Language

English is mandatory for canonical engineering artifacts: specifications,
architecture, governance, code identifiers and comments, schemas, commands,
diagnostics, tests, guides, change plans, and agent-authored repository text.
Historical sources may remain in their original language. Runtime agents may
communicate in the language declared by their Company Workspace.

## Repository-local entrypoints

`AGENTS.md`, `CLAUDE.md`, root `README.md`, and package READMEs are thin
entrypoints. They may link here but must not create competing architecture,
status, or product truth.
