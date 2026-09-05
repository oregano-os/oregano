---
document_id: guide.author-workflow
title: Author a Workflow
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-08-22
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
---

# Author a Workflow

Create the workflow under `workflows/` and begin with a behavior-class Change
Plan. Define its stable ID, owning operating agent, trigger, goal, boundary,
input, ordered steps, output, and verification evidence.

Declare `execution_mode: supervised` or `execution_mode: unattended` in the
workflow frontmatter. It is never inferred. Start with `supervised` unless the
workflow genuinely needs to progress without continuous human participation.
An unattended declaration additionally requires resolved Tools, compiled
enforcement, verified Instance controls, and runtime evidence before it may be
treated as deployable.

For each effect, state R0–R4, the Tool used, approval conditions, idempotency,
failure behavior, and compensation. Write human decisions as `[human:<role>]`;
assign risk to the effect that follows, not to the human. Every referenced role
must resolve to an active roster entry and every Tool must be granted to the
owning agent.

Before review, run `companyos validate` and `companyos inspect --plan <file>`.
Include at least one happy-path, rejection, retry, and unauthorized-action test
when the workflow can produce effects.

## Executable steps (authoring validation available)

A workflow may declare `type: workflow`, a stable `id`, a `version`, its
`owner`, `execution_mode`, one schedule trigger (or `operator`) and `steps:`.
Each list entry starts with its step ID mapped to a Tool, `wait`, `route` or
`human:<role>`. The remaining fields are that construct's options. Mirror each
step once in the prose with an owner/risk marker and `<!-- step:id -->`, in
the same order. The full fictional example is
`packages/testkit/fixtures/lindenhof-studio/workflows/friday-close.compact.md`.

Put literal parameters in a referenced config v2 file. Use `$config`,
`$steps`, `$trigger`, `$instance` and `$item` references, with computations in
Company Tools. A referenced output must be produced on every path reaching
its consumer. For messages, use a Skill `template` and scalar `vars`; the
renderer supplies the actual publish input. Publish a root without a thread
and use its persisted receipt for subsequent replies. Decisions bind the exact
payload; an empty batch must end before approval.

`companyos validate` now checks executable authoring, including source-derived
Record row types, grants, risk minima, markers, schedule references and control
flow. Passing it does not yet make these workflows executable: the generic
Artifact compiler and runtime are under implementation. Consult the
[Workflow Execution specification](../../specifications/workflow-execution-v1-draft.md)
for the available validation and remaining execution gates.
