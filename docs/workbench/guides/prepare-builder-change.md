---
document_id: guide.prepare-builder-change
title: Prepare a Builder Change
kind: guide
status: building
authority: canonical
language: en
updated: 2026-09-08
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
relations:
  depends_on:
    - specification.builder-governance
    - guide.operate-builder
---

# Prepare a Builder Change

The company-facing Builder owns discovery and clarification. A separate coding
agent implements the resolved request. The employee describes the desired
outcome in ordinary conversation; the Builder fills the brief below.

## Read before proposing

1. Discover the available definitions with `builder_list_context`. Resolve a
   named process to its exact Workflow or Agent file. If multiple definitions
   match, ask which process the employee means.
2. Read the affected definition with `builder_read_context`, then follow its
   relevant references: responsible Agents, Tools, process steps, schedules,
   resource declarations and policies. These reads use the current Artifact's
   scoped Workspace snapshot. They do not read arbitrary provider data or
   production state.
3. Explain the existing behavior and intended change in plain language. If a
   required definition is unavailable, identify the missing context. Do not
   infer its content or declare an existing file to be a new file to evade
   the read requirement.
4. Record the before/after change and observable success criteria. New files
   must be explicit in `newPaths`; Core checks them against the source inventory.
   All existing targets must have current read evidence.

For example, for “change our weekly report,” first identify which report,
read its trigger, data sources, author, recipients and approval steps, and
explain which of these would change. A request for a shorter summary normally
preserves those rules. A request to publish automatically raises a decision
about the existing human approval and its authorized replacement.

## Ask only material unanswered questions

Use documented, unchanged company choices without asking for them again.
Ask before coding when the available request and definitions do not determine:

- the target process or intended outcome;
- the trigger, order, participants or exception behavior being changed;
- who must approve, whether approval can be skipped, or who may act;
- which records or provider resources may be read or changed;
- the success criteria; or
- a test destination or real effect that differs from the remembered test policy.

A process decision is not a permission grant. A requested rights change can be
prepared, but current governance decides who can accept it. Before proposing
approval or access changes, read `.companyos/governance.yaml` and
`handbook/roster.md` through the same scoped read Tools. If those files are
outside the Builder's compiled scope, request the scoped configuration change;
do not proceed from assumptions about the current authority.

Group related questions into one short message when useful. Never invent an
answer to make a brief look complete. Leave `openQuestions` populated or mark
the relevant decision `unresolved` until the employee answers. The admission
check refuses either state before creating a coding job. This check proves
bounded source reads and explicit decisions, not perfect model comprehension.
The employee still reviews the actual result before live adoption.

## Build brief version 1

The machine contract lives in `packages/runtime/builder/brief.ts`. It contains:

| Field | Meaning |
|---|---|
| `objective` | Requested outcome. |
| `targetPaths`, `newPaths` | Exact affected definitions; explicitly new files. |
| `currentBehavior`, `proposedBehavior` | Precise before/after behavior. |
| `acceptanceCriteria`, `constraints` | Observable success and boundaries. |
| `contextRefs` | Relevant source definitions actually read. |
| `decisions.workflow`, `.approvals`, `.access` | Preserve, change, not applicable, or unresolved, each with an explanation. |
| `test` | Strategy, scenarios and exact resource bindings where needed. |
| `deploymentIntent` | Prepare only, or request adoption after acceptance. |
| `openQuestions` | Remaining material decisions; must be empty before coding. |

Core adds the Artifact hash, Workspace commit, independently recorded content
read digests and a digest of the whole resolved brief. The model cannot supply
read receipts in its Tool arguments. Evidence is scoped to the current
Artifact, authenticated requester and conversation. The durable job retains
the brief; both Claude Code and Codex receive the same contract.

## Select the smallest useful test

Use `simulate` for local fixtures, `auto` when maintained inspection can select
the checks, `test-resources` for existing company test destinations, or
`live-trial` for a precisely authorized production trial. A test channel in the
existing app or a test board in the existing provider can be sufficient.
Neither a second app nor a hosted Preview is an unconditional requirement.

Record exact logical resource bindings for a connected test or live trial.
The preference does not grant provider access and does not prove a test ran.
Only a qualified test executor can produce execution evidence. If none exists
for the requested test, report the gap. A coding worker with model-only network
access cannot perform that test by itself.

## Start and hand off

After material questions are resolved, call `builder_propose_change`. An
explicit development request authorizes isolated implementation and preparation
of a reviewable draft within that scope. No additional start click is required.
An allowlisted handoff from another Company Agent forwards the original current
human message to Builder immediately. It does not transfer the other Agent's
private history, Tool grants or authority. If that message depends on missing
prior context, Builder clarifies it.

The coding agent receives an exact credential-free Workspace copy and changes
files in its isolated worker. It must preserve the brief's decisions, verify
source-read digests, create the required Change Plan and stop for a newly
encountered material decision. Trusted Workbench inspection, validation and
security checks run outside the coding process before draft publication.
The shared worker image includes the exact matching Workbench and Guides.
Coding and independent validation still run in separate isolated executions.

Starting development never accepts the result, merges it or deploys production.
A qualified release binding presents the checked result and one combined
accept-and-live action when the same person has both authorities. The
unconfigured maintained Runner continues to return a draft for review. It must
not show a working live action without a real trusted execution adapter.


## Connected test and correction loop

Call `builder_instance_capabilities` before selecting `test-resources`. Reuse
listed Instance test resources; a missing capability or destination needs setup
before coding. Do not ask to install another provider app for an existing binding.
Include one exact `test.execution` in the brief:

```json
{"strategy":"test-resources","scenarios":["Review the revised answer"],"targetBindings":["test-channel"],"execution":{"kind":"agent","agentId":"assistant","prompt":"Explain the weekly report."}}
```

For a workflow use `execution: {kind: "workflow", workflowId: "report", fields: {}}`
and the selected test channel plus exact work-item test resource. Current support
is a read-only Agent reply or an immediate operator workflow without messages,
waits or intermediate decisions. Report unsupported cases explicitly.

Core tests the unmerged candidate and posts its actual result before the final
merge/live action. The requester uses **Request changes**, then explains the
correction in the original Builder conversation. Call `builder_read_test_result`
to retrieve the previous brief, actual summary and authenticated feedback. Re-read
the current definitions and create a complete revised brief. The previous test
and live action cannot approve this rebuilt candidate. No extra start click is
needed for a resolved correction request.
