---
document_id: guide.author-workflow
title: Author a Workflow
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-09-17
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
`owner`, `execution_mode`, one schedule trigger, one event trigger or
`operator`, and `steps:`.
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

Replies to a delivered report can use its exact sent text after the workflow
finishes. Put the desired explanation style in the owning Agent's instructions;
no extra conversation Skill or artificial waiting step is needed. The host must
support the shared publication-context contract. This read-only discussion does
not grant Tools or reopen the workflow. Only publications with retained delivery
text are available; older messages are not automatically backfilled. See
[workflow operations](../../operations/workflow-engine.md#replies-to-delivered-reports)
for limits and acceptance checks.

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

## Open a workflow from a provider event

To react to a created or moved card instead of scanning on a timer, declare
an event source under `events/` with the logical `provider`, the logical
`resource_binding` and one or more triggers, then reference one trigger from
the workflow.

::: implementation-example

The maintained board-event adapter is described in
[Monday board events](../../operations/vercel-workflow-runner.md#monday-board-events).
A Workspace using it declares:

```yaml
# events/sprint-board.yaml
schema_version: 1
id: sprint-board-events
activation: blocked
provider: monday
resource_binding: sprint-board
triggers:
  - id: sprint-card-changed
    events: [item-created, item-moved]
```

```yaml
trigger: event:sprint-card-changed
```

:::

The workflow receives `$trigger.event.work_item_id`, `$trigger.event.kind`
and the other verified identity fields; it must still read the card through
`oregano:records/query` or `oregano:work-items/read` before deciding anything.
The default instance key is `trigger_id` plus `event_id`, so each provider
event opens one run and a redelivery reuses it. Add `calendar:` when the
workflow waits or decides in business days. Keep `activation: blocked` until
the Workspace decides to go live; the Instance separately opts the workflow
into event opening and registers the provider subscription. Trigger IDs share
one namespace with calendars, so a schedule and an event source cannot claim
the same ID.

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


A person may answer in the main conversation, including a direct message, when
exactly one unexpired fact-collection
question is open for that recipient in that account and channel. The host reads
the original provider message and uses the existing question as its context;
it does not pretend that the message was sent in a thread. Multiple possible
questions require clarification. Unrelated users, other channels and expired
questions cannot select a conversation. This fallback collects facts only;
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


## More than one scheduled run per day

Daily workflows keep the default key `trigger_id` plus `run_date`. For repeated
checks within one day, declare `trigger_instant` as an instance field and use it
in the key:

```yaml
instance:
  key: [trigger_id, trigger_instant]
  fields: [trigger_instant]
```

Core fills this field from the validated scheduled occurrence. Different
occurrences produce different runs; retrying the same occurrence reuses its run.
Callers and child steps cannot supply or override this trusted field. Operator
retries retain the first opening time. Existing workflows that do not declare
it keep their prior fields and identity. Business period fields still require
Workspace computation or explicitly reviewed inputs.

## Show a readable review without technical payloads

On a `human:*` step with `message` and `labels`, add `review_format: message`
to show only the complete readable proposal. Include the target and every
proposed business change in the template, such as before/after values and the
full comment. Do not use a vague confirmation sentence as the entire review.
The full `binds` object remains internal for exact approval and write checks.
Leave out the option to retain the historical payload-inclusive presentation.


A human decision with explicit recipient and labels may declare
`continue_in: $steps.conversation.thread_reference`. The target must be a prior
private root publication to that same recipient. Core resolves the exact receipt
and destination; the Connector may render an affirmative control that both
links to this conversation and sends the existing decision action. Following a
link is never authority: the authenticated decision callback still gates the
next step. Unsupported clients can continue through the normal decision and
message path without automatic navigation. Keep later publications' `thread`
and collections' `from` on this root to preserve one conversation.

The navigation reference is optional and distinct from `thread`, which places
the decision notice itself inside a conversation. Omitted navigation preserves
historical notice inputs and verification. Workspace chooses the conversation
and its content; provider navigation rendering belongs to the Connector.

By default, a private `human:*` decision with an explicit `recipient` and
`labels`, and without `thread` or `continue_in`, roots its own conversation.
Core compiles it as a conversation root: the Connector may link the affirmative
control to the notice's own thread once the published message is verified, and
the approved, rejected or timed-out output also carries the delivered notice's
`thread_reference`, `destination_binding` and `message_id`. An undelivered
timed-out root ends without a thread. The authenticated decision callback still
gates the next step.

Later publications to the same explicit recipient that can only be reached
through that decision continue in its thread without declaring `thread`.
Declare `thread: none` to post such a message as a new root, or any explicit
`thread` to choose another conversation. A collection names the card thread
with `from: $steps.<decision>.thread_reference`. Use `continue_in` only to
navigate to a different, earlier root; such a decision is not a conversation
root.

A human reply inside a thread whose delivered run is waiting for that person's
collection goes directly to the workflow conversation. The conversation
coordinator pass is skipped for that reply; other messages keep ordinary
coordination.

An optional single-line `title` of up to 150 characters replaces the
Connector's generic decision heading. Decisions without `title` or a thread
reply keep their historical heading, notice input and manifest.
