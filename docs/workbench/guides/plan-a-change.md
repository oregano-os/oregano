---
document_id: guide.plan-change
title: Plan a Change
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-09-05
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
---

# Plan a Change

A formal Change Plan is required for behavior and security changes. The agent
provides the reasoning; the Workbench provides and validates the structure;
the pull request provides the approval.

## What a plan records

Objective, non-goals, placement, change class, the exact files or bounded
globs the change touches, the real test files that prove it, the canonical
documents it changes, an architecture block for Core behavior and security
work, and a rollback. Nothing else. A plan never grants its author permission
to approve the resulting change, and it does not record approvals at all: the
Workspace Steward or Oregano Maintainer approves by merging the pull request
that carries the plan through the required check. Existence of a plan on the
protected default branch therefore means the change was approved and shipped.

## Before implementation

New plans use Change Plan version 3. Run `companyos plan --output <path>` to
create the template, then:

1. state in `architecture.placement` what Core, Packages or Blueprints, the
   Company Workspace, and the Company Instance each own, including an explicit
   no-change statement where appropriate;
2. list in `architecture.mechanisms_extended` only the governed mechanisms the
   change extends, each with the bounded contract extension as its reason.
   Every mechanism not listed is reused unchanged. The catalog is
   AgentResolver, ToolSetResolver, ModelRecipeResolver, Company Records,
   identity and authorization, timers and business time,
   approvals/effects/idempotency, and Capability Contracts/Connectors;
3. list genuinely new Core mechanisms only in a Core plan;
4. confirm that Core contains no company values, Git contains no secrets, and
   Core fixtures are synthetic; and
5. explain in `architecture.core_reusability` why the Core work is reusable
   across companies, or why no Core mechanism changes.

A plan that routes from message meaning must state separately how
authenticated ingress, semantic handoff, target authorization, ToolSet
isolation, assignment persistence, return, expiry, revocation, and evidence
are handled.

## Declarations that bite

`companyos plan --check` and `companyos inspect-core` enforce three things a
reviewer previously had to trust:

- every changed file must match `files_expected`; a catch-all glob such as
  `packages/**` or `docs/**` is rejected because it declares nothing;
- every entry in `tests` must be an existing test file or a glob that matches
  one; prose descriptions of intended tests are not accepted;
- every document ID in `documentation_impact.affected_documents` must be
  changed in the same diff, and a documentation contract triggered by the
  changed paths must be listed.

## Proposals

A plan for work that is not in the same pull request carries
`proposal: true`. Inspection then allows only `.oregano/changes/**` and
`docs/**` in the diff, and `tests` may name files that do not exist yet. The
pull request that ships the implementation removes the flag and completes the
test list. A proposal on the default branch is an approved intent, not an
implemented change.

## Selecting the plan in a pull request

Inspection discovers a single changed Change Plan automatically. When one pull
request intentionally contains multiple plan files, its description must name
the governing plan on a line by itself:

```text
Change-Plan: .oregano/changes/example.yaml
```

A Company Workspace uses the corresponding `.companyos/changes/example.yaml`
path. CI treats the marker only as explicit selection; the selected plan must
still exist, validate, and match the actual diff class. The marker never
grants authority.

After a GitHub merge, the target-branch check resolves the uniquely associated
merged pull request and reuses the same marker while inspecting the actual
merge commit. A direct push has no merged pull-request authority and therefore
remains on strict automatic discovery. Ambiguous associations, invalid paths,
and missing plan files fail closed.

## Historical plans

Version 1 plans dated on or before 2026-08-31 and version 2 plans dated on or
before 2026-09-05 remain valid historical evidence. Their `status` and
`approvals` fields are read as they were written and are not maintained.
