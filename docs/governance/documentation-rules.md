---
document_id: governance.documentation
title: Documentation Rules
kind: governance
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

## General contracts and concrete implementations

General documentation defines the contract independently of a vendor, product,
model, Connector, host, company or installation. This applies to specifications,
architecture, capability contracts and guides. The default `implementation_scope`
is `general`. A concrete implementation document declares
`implementation_scope: provider` and a non-empty `providers` list. Here provider
means the named implementation, including a model or Connector implementation.
Do not relabel a general contract to silence a diagnostic.

General documents may link to implementation guides. A concrete example belongs
in an explicitly marked `::: implementation-example` block, closed by `:::`,
and must link to the implementation document. The example illustrates the
contract; it must never become a required default for all implementations.

`pnpm docs:check` checks known implementation names outside references and
marked examples, validates scope metadata, and requires examples to contain a
document link. Existing violations are recorded in
`documentation-scope-baseline.json` by exact file and line text. This is migration
debt, not an allowlist for new writing. New or changed violations fail CI. Do not
expand the baseline to accept new text; remove entries as pages are cleaned up.
The check cannot understand every vendor alias or detect every semantic
assumption. Reviewers must also check the contract's independence and whether an
example's linked document actually explains the implementation.

## Write simply

Start with the reader's task and the result they should expect. Use short,
direct sentences and familiar words. Explain a technical term on first use.
Give concrete steps in the order the reader needs them. Keep implementation
details in their implementation guide and link to them. Separate requirements
from examples and explain why a requirement exists. Avoid long noun chains,
repeated disclaimers and unexplained internal terminology.

Reviewers must check clarity. Passing the automated scope check is not proof
that a page is easy to understand. Improve the section being changed; a small
change does not require rewriting the entire documentation tree.
