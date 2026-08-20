---
document_id: guide.author-workflow
title: Author a Workflow
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-08-14
owners:
  - core-maintainers
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
