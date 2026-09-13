---
document_id: governance.agent-agreement
title: Agent Working Agreement
kind: governance
status: approved
authority: canonical
language: en
updated: 2026-09-13
owners:
  - oregano-maintainers
audience:
  - agent
---

# Agent Working Agreement

For an Instance configuration change, use the Company's tracked
`.companyos/instance.yaml` beside governance and compatibility. Do not invent
an `instances/` folder or edit a temporary/encoded copy as the source of truth.
Read [the format and migration contract](../reference/instance-configuration.md),
preserve unrelated bindings, and classify changes under `.companyos/**`
security review. This allowed non-secret placement does not authorize new
provider access, resolved secrets in Git or deployment.

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

## Git task lifecycle

1. At the start of each task or resumed task, read this repository's `AGENTS.md`
   and working agreement. Verify the repository, current branch, working-tree
   changes and upstream. Fetch the current `origin/main` before creating a new
   task branch; report unavailable remote verification instead of assuming freshness.
2. Keep the primary checkout on a clean `main`. Make changes on a short-lived
   task branch from current `origin/main`, with a separate worktree for parallel
   tasks. Reuse an existing task branch only for that same unfinished task after
   checking its current PR state. Never continue a merged branch. Name any
   dependency on another unmerged branch explicitly.
3. Commit and push the intended changes before a shared test deployment or a
   handoff for review. Keep unfinished work visible in a draft PR. Preserve and
   report unrelated or uncommitted files; never sweep them into a task commit or
   discard them to obtain a clean status. Keep private material out of public Git.
4. Record relevant checks against the exact candidate commit. A shared test or
   deployment record identifies its environment and exact Core and Workspace
   commits where applicable. A passing test, an open PR, a merge and a verified
   deployment are distinct states. A changed candidate needs the relevant checks
   again; do not reuse evidence for a different source state.
5. Use normal merge commits for this repository; do not squash or rebase-merge
   PRs. Prepare the PR within the authorized task scope. Merge and production
   deployment require authorization covering those actions; reuse authorization
   already given instead of asking again.
6. After an authorized merge, verify the actual PR merge and required check
   results. Fast-forward the clean primary checkout to current `origin/main`
   when it is not in use by another task. Remove the completed task branch and
   its worktree only after checking for local changes, dependent work and
   non-reproducible ignored files. Preserve anything still needed and report it.
   Remote branch auto-deletion alone does not prove local cleanup.
7. Every implementation handoff states the repository and branch/commit, PR or
   merge status, checks, deployment status, and any remaining local changes or
   worktrees. Call work complete only for the scope actually finished. If merge
   approval is pending, say "PR ready; not merged" rather than "complete".

## Minimal-interruption rule

An explicit task request or confirmed plan authorizes the Agent Contributor to
complete all work inside that unchanged scope without asking again. This
includes read-only inspection, local edits, validation, retry and resume,
branch publication, and pull-request preparation. These actions create review
material; they do not grant merge, release, deployment, or business-effect
authority.

Pause only when a human must:

- authenticate or accept provider, legal, privacy, or billing terms;
- approve a new or increased permission, cost, external resource, or secret
  placement not already covered by the confirmed plan;
- approve or execute a protected merge, release, production deployment,
  migration, externally visible effect, or destructive action whose exact
  scope is not already authorized; or
- decide a material scope or product question that the current request does
  not answer.

Do not turn ordinary commands into approval gates. Reuse the recorded
authorization while its scope and targets remain exact. When the Workbench
requires multiple confirmation hashes or human actions that are already known,
present them together in one concise request. Never fabricate, bypass, or
silently broaden a required confirmation.

::: implementation-example

Fresh setup requires the human's model-provider choice, presenting OpenAI and
Anthropic only. A supported alternative requires an explicit request. Do not
infer a provider from the coding agent or substitute Gateway as a default.

See the [maintained host profile](../operations/maintained-host-profile.md).

:::

A fresh standard installation uses one concrete reviewed setup decision under
the release/promotion specification. That decision includes the named new
resources and first production deployment; do not add separate local, activation,
merge or deployment questions. Later changes, adoption, changed scope and actual
provider consent retain their applicable authority boundaries. The CLI records
fresh initialization evidence; a prompt cannot manufacture it.

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
