---
document_id: governance.documentation
title: Documentation Rules
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
---

# Documentation Rules

Documentation is part of the product and the Definition of Done.

## Canonical tree

All active canonical documentation lives under `docs/`. Root entrypoints and
package READMEs remain short and link into this tree. Frozen sources may live
in an archive but are never edited as current truth.

## Required metadata

Every Markdown document under `docs/`, except generated output, declares:

- `document_id`, `title`, `kind`, `status`, `authority`, `language`,
  `updated`, `owners`, and `audience`;
- optional typed relations such as `depends_on`, `supersedes`, and
  `implements`;
- `availability` when describing a command or capability.

IDs are stable and unique. Relations use IDs, not filenames. Status values are
`draft`, `approved`, `building`, `implemented`, `superseded`, or `frozen`.
Authority values are `canonical`, `normative`, `informative`, `generated`, or
`historical`.

## Same-change rule

A change to architecture, behavior, governance, a command, a schema, runtime
configuration, setup, or a public capability must update the affected
canonical documentation in the same pull request. A Change Plan may declare
no documentation impact only with an explicit reason.

## Publication

Canonical pages use relative links, stable headings, standard Markdown, and
Mermaid diagrams with adjacent prose. The website consumes this tree; it does
not maintain a second copy. Every page declares or inherits visibility. Real
Company Workspace content, credentials, private IDs, and customer data are
never published from this repository.

## Onboarding maintenance

Onboarding is part of the same-change rule. A change to required Workspace
files, Workbench commands, compatibility pins, Git protection, CI, Contributor
entrypoints, Instance preparation, or acceptance checks must update
`docs/onboarding/`, the relevant Guide, and `companyos onboard` behavior in the
same pull request. A setup instruction without a deterministic check must state
which accountable administrator verifies it and where the external evidence
lives.
