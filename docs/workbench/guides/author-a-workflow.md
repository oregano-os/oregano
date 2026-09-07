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

## Executable steps (validation and compilation available)

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
flow. `companyos build` also compiles the validated steps into frozen manifests in
the Artifact. The generic runtime guard and durable engine are implemented;
executing a workflow requires separately verified Instance controls and explicit
activation. Consult the
[Workflow Execution specification](../../specifications/workflow-execution-v1-draft.md)
for the available validation, compilation and remaining execution gates.

Scheduled workflows use the originating schedule for business-day timeouts.
For an operator workflow with timed waits or decisions, add
`calendar: schedules/<file>.yaml`. Keep company parameters in literal config;
the compiler does not infer a calendar from business parameter names.

Opening triggers, wait triggers and explicit calendar paths select the files
that must satisfy the executable calendar contract. Independent scheduling
metadata may coexist in `schedules/`; it is not added to workflow manifests.
Keep all candidate YAML readable and avoid competing trigger IDs. Invalid or
missing referenced calendars still block validation and compilation.

## Assigned fact collection

A `collect` step pauses for one private conversation. `from` references a prior
root message's `thread_reference`; that message must have one explicit recipient.
`context` supplies the reviewed card or other business facts. `fields` names up
to 30 required text fields, each at most 4,000 characters. `timeout.business_days`
uses the workflow calendar. On timeout the run is cancelled without an effect.

The Agent asks questions and submits only these fields. Core verifies the active
human, delivered thread, current step and deadline, then freezes the output.
Submission is not consent. A later human decision binds the proposed changes.
Use `recipient` to limit a decision to one exact member. `human:subject` confirms
only R0–R2 effects for that member without granting an approval role. R3–R4 still
require the existing risk authorization and named role. The action labels belong
to the Workspace. A conversational acknowledgement does not approve a decision.


A person may answer in the main channel when exactly one unexpired fact-collection
question is open for that recipient in that account and channel. The host reads
the original provider message and uses the existing question as its context;
it does not pretend that the message was sent in a thread. Multiple possible
questions require clarification. Unrelated users, other channels and expired
questions cannot select a conversation. Channel fallback collects facts only;
a human decision still requires its own delivered question or action.

Keep selection, questions and permitted business fields in the Workspace. Put
provider integration in its Connector. Operational state remains in the Instance,
never in Workspace files. Verify unauthorized replies, expiry, rejected proposals,
stale versions, retry and provider readback before enabling a workflow.

For a recurring intake, select eligible objects in a Company Tool, then use
`start` with `workflow`, `input` and optional `for_each` to open one child per
object. The exact input fields deduplicate repeated intake scans. The child must
be an enabled operator workflow and cannot start further workflows. Keep the
intake calendar blocked until its recipients and provider effects are tested.

## Keep a review in the conversation

On a human decision step, add `thread: $steps.ask.thread_reference` to put the
review below an earlier private question named `ask`. Use the same explicit
`recipient` on both steps and provide `labels.approve` and `labels.reject`.
Keep `via` pointed at that recipient's qualified destination. The person reviews
the proposed change and clicks a control on that review message. Plain replies
to the original question do not approve the change.

Leave out `thread` to send a separate review message. The Connector must support
replies at the chosen destination; see its setup guide for supported surfaces.
After acceptance, publish a separate completion message only after verifying
the effect. Use the original question's thread for that message too.
