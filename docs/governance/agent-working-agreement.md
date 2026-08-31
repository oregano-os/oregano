---
document_id: governance.agent-agreement
title: Agent Working Agreement
kind: governance
status: approved
authority: canonical
language: en
updated: 2026-08-31
owners:
  - oregano-maintainers
audience:
  - agent
---

# Agent Working Agreement

Before editing, an Agent Contributor reads the Vision, Glossary, relevant
specification, relevant Workbench Guide, and the
[Versioning Policy](versioning-policy.md). It then:

1. classifies every responsibility as Core, Package or Blueprint, Workspace, or
   Instance work;
2. creates a Change Plan for behavior or security changes and completes its
   placement and reuse assessment;
3. edits only the authorized repository and paths;
4. never resolves an open product decision silently;
5. runs Inspection and Validation;
6. updates canonical documentation in the same change and lists each affected
   document ID in the Change Plan;
7. reports tests, remaining risks, and required human approvals.

The placement and reuse assessment is mandatory for newly created Change
Plans. It records responsibilities at all four boundaries and reviews the
governed catalog of existing Core mechanisms before proposing another one.
An applicable Agent, ToolSet, or ModelRecipe Resolver, Company Records service,
identity control, timer, effect control, or Connector contract must be reused
or deliberately extended. `not-applicable` requires a reason; omission is not
a decision. Core proposals must also explain cross-company reusability and
confirm that public fixtures are synthetic.

`companyos inspect-core` resolves every affected document ID and requires that
document to be changed in the inspected diff. For contracts listed under
`documentation_contracts` in the Core Change Policy, it also requires the
complete named document set and any non-canonical runbook files. Passing the
mechanical check does not replace accountable review of semantic accuracy.

Agents write engineering artifacts in English. They do not expose secrets,
grant themselves authority, weaken Core safety, or replace a missing Core
capability with direct provider access in a Company Workspace.
