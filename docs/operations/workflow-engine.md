---
document_id: operations.workflow-engine
title: Hosted Workflow Engine Operations
kind: guide
status: approved
authority: canonical
language: en
implementation_scope: general
updated: 2026-09-15
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
---

# Workflow operations

Use this guide to check whether a hosted workflow is ready for human testing.
It defines the evidence required, independently of the hosting or chat provider.

For a concrete Connector example, see [Slack communication delivery](slack-communication.md).
Its provider-specific identity checks implement the general conversation contract.

## Migrating from the retired domain executor

Core now runs declared Workflows only. Remove `sprint_runtimes` from the
Instance declaration and replace old version-1 Sprint configuration with the
Workspace's declared Workflows and version-2 workflow configuration. The
builder rejects the retired declaration instead of silently disabling it.
Artifacts containing active legacy definitions are also rejected. An older
Artifact with an empty legacy list remains readable for retained workflow
receipts; new builds omit the list entirely.

Prepare and qualify database manifest `2.1.0` before deployment. It retains all
general workflow and Records tables. New databases do not create the three
retired Sprint tables; existing audit data and historical manifest identities
are preserved. No table is dropped and no old worker is kept as a fallback.

Rebuild from clean pinned Core and Workspace commits. Check conversation
routing, decisions, scheduled opening, message intake, and recovery on that
exact candidate before activation. Hosting steps belong in the linked provider
guide below. Do not delete installations or credentials as part of source
cleanup.

## Replies to delivered reports

When a workflow publishes an addressable message, Core retains the exact sent
text alongside its verified receipt and conversation address. A later reply can use that text
even after the workflow finishes or is cancelled. This is evidence for an
explanation, not permission to resume work or execute a Tool.

The context reader accepts opaque surface, account, conversation and thread
identities from an authenticated adapter. It contains no provider address parser
or SDK. The maintained host passes the resulting evidence to the owning Agent
alongside ordinary chat history. Another communication adapter must authenticate
its own inbound messages and normalize its receipts to the same contract. A
receipt's `thread_reference` is an opaque conversation reference; it need not
represent a threaded user interface. Without a stable reply reference, a
successful send alone cannot establish follow-up context.

Check these cases before inviting a tester:

- Reply to a newly delivered message after its workflow completes. The Agent
  should explain the message without asking the person to paste it again.
- Repeat the question after a host restart. The sent text must still be available.
- Verify that another private recipient, account or conversation cannot read it.
- Verify that discussion does not record a decision, reopen a run or grant Tools.

Context uses at most 40 messages and 80,000 content characters and reports
truncation. It expires with its delivery assignment, which defaults to 30 days.
The reader uses the current active human roster, enabled workflow list and
current Agent definition; it rejects conflicting Agent ownership. Text is a
snapshot of what was sent, not a claim about later external edits. Existing
publications from before this correction lack the retained text and are not
silently reconstructed from changed business data. Publish a new report through
the normal authorized workflow to test the complete path.

Provider-specific setup is described in the
[maintained runner guide](vercel-workflow-runner.md). Synthetic adapter tests
prove the shared contract; they do not qualify an additional live provider.

Before inviting a human tester, verify the effective model task, model and
provider route for each participating Agent. Compare them with the intended
Instance configuration; a successful health response with the wrong model is
not acceptance. Test conversation quality using the compiled instructions and
Skills, including irrelevant, incomplete and contradictory answers. Preserve
the actual response-model evidence. Schema checks and simulated collection
objects prove structure, not the quality of a model conversation.

## Choose the provider guide

- [Vercel Runner setup and recovery](vercel-workflow-runner.md)
- [Vercel Connect interaction routing](vercel-connect-workflow-interactions.md)

These guides describe the maintained reference implementation. Other adapters
must provide equivalent identity, decision, persistence and effect checks.

## Check startup before inviting a tester

The deployed Artifact and any separately stored configuration must identify the
same Core commit, Workspace commit and Instance. Prepare, deploy and roll back
that set together. A successful build does not check the settings in a running
Instance.

The runtime must finish configuration validation and register its message
handlers before it reports ready or stores a shared instance for later requests.
A failed start must fail again on the next request, rather than return a partly
initialized runtime. Automated tests must cover that failure and recovery after
the configuration is corrected.

Keep three results separate: the build passed, the deployed runtime is ready,
and an actual person received an answer. Only the last result proves a working
conversation on the tested route. Test each required route, such as a direct
conversation and a shared-channel reply; success on one does not qualify another.

## What a successful decision means

Save the authenticated human decision before updating the displayed card.
Replace its buttons with a clear confirmation. A saved approval authorizes the
bound change; it does not prove that the change has executed. Verify that
separately through the effect receipt and a read of the target system.

## Hosted interaction acceptance gate

Treat these as separate checks; do not call a hosted human test ready because
only build, health, or outgoing message delivery passed:

1. Verify exact Core, Workspace, Artifact and deployment identities, isolated
   state, permitted write resources and intended recipients. Stop if any differ.
2. Verify the provider installation destination resolves to that deployment.
   Send a clearly labelled non-decision diagnostic only to an authorized test
   recipient. Check actual provider forwarding and the receiving endpoint log.
   HTTP health checks and operator calls do not exercise this path.
3. Verify unsigned interaction requests fail authentication. Never disable
   signature verification to make the test work. A diagnostic message does not
   prove button authorization; qualify that separately with a real human click.
4. Start with a real rejection: correlate the delivered request, authenticated
   human response, persisted rejection, terminal run and absent write effects.
   Confirm the original message has no remaining action controls.
5. Test a separately bound positive decision. A recorded approval is not proof
   of a completed write: inspect the effect receipt and read the target resource
   back through the qualified provider integration. Test idempotent redelivery
   and stale-input rejection with automated contract tests as well.

For each checkpoint report `passed`, `failed`, or `not verified`, its observed
version and evidence. Missing external credentials or skipped database tests are
not a passing hosted qualification. Repeat affected checks when deployment,
routing, credential placement, or recipient bindings change. Never repeatedly
ask a user to click without locating the failed checkpoint first.

If a click times out, inspect ingress delivery before assuming a decision was
lost. If controls remain visible, inspect durable decision state before asking
for another decision: authorization may have succeeded while the message edit
failed. Report these failures separately to the operator. Never manufacture a
human response or use model conversation as an approval fallback.

The response regression suite covers durable-save-before-edit, removal of
controls after approve/reject, no edit after failed authorization, and preserved
decision state after a presentation failure. These tests cannot establish a
customer's external installation routing. The hosted gate above remains an
explicit operator qualification; it is not an automatic universal setup doctor.

## Feedback while saving a decision

After the current user and exact request pass authorization, the interface may
show “Processing your decision…”. This is temporary feedback, not a new
Workflow step or a saved decision. Once approval is stored, keep the reviewed
proposal, remove the controls and show only “Approved”. A separate completion
message requires a verified result. If storage fails, show that the result could not be confirmed
and direct the user to an administrator; do not claim rejection or success.

System feedback uses the existing working language from the Workspace's company
file. New Artifacts retain it; no new required Workspace field is introduced.
The current system-message catalog supports English and German, including
regional language tags. Older Artifacts without this field, unsupported languages
and invalid tags fall back to English. Business explanations and button labels
remain authored in the Workspace. Runtime decisions stay in the Instance store.

A continuation failure shows a short explanation while retaining the saved
approval. A stopped write or dependent verification also uses the existing
durable notice in the original approver's conversation. The notice says that
completion could not be confirmed and asks the person not to submit again until
the result is checked. Raw errors remain in operator diagnostics. Declared
output dependencies must identify one approved decision; ambiguous audiences
remain available for operator review. A notification never retries the write.

## Check model-generated steps

For a Tool using `language.generate`, verify the exact scoped Skill binding,
Agent model task, evidence selection and output checks. Exercise the real model
through the deployed workflow before accepting the result; a mocked response
checks plumbing only. Confirm that model failure or rejected output stops
publication and remains visible in the run. Save response-model evidence and
the prompt, context and output digests with the run.

Completed generation is retained with the step, so resuming a finished run must
not generate or publish it again. An interrupted, uncommitted model call can be
repeated and incur cost. Test any publication separately for duplicate effects.


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

## Recover a decision that was never published

An authorized operator may request `recover-unpublished-decision` with the run
ID. Recovery requires a trusted Connector verifier to prove that the failed
publication sent nothing. The decision must still be pending and unexpired,
with its exact text, recipient and thread unchanged. The host qualifies the
destination again before committing the recovery authorization.

Core records one recovery attempt per recipient under the run lease and keeps
the original failed effect. The normal worker then delivers the notice and waits
for the human decision. Recovery does not approve anything or retry business
writes. A timeout, unknown outcome or second failed attempt stays blocked.
Hosts without a verifier cannot use this operation. Provider-specific proof
rules are documented with their Connector.

## Readable decisions and conversation selection

A human decision may declare `review_format: message` with a complete readable
message template and button labels. The exact bound object remains in decision
state, hashes and effect checks; technical serialization is omitted from the
presentation. Retained Artifacts without this declaration preserve their exact
historical notices and receipt verification.

Conversation choice snapshots bind one original message reference to a frozen
numbered list, scoped by Instance, provider, account, channel, thread and human.
They expire after one day; content-free records remain for 30 days to explain
late replies. The generic service requires verified inputs and target
revalidation from its adapter. It cannot create an assignment, grant Tools or
authorize an effect.


## Shared conversation coordination

A Workspace can opt its entry Agent into `conversation_coordinator: true`.
The hosted chat then interprets ordinary messages before the legacy collection
selector. Existing signed button handlers retain their exact decision path.
The coordinator searches existing delivery assignments and Builder jobs, then
resumes the selected work using its source revision and the original message.
For one concern the Agent omits route text; Core forwards the verified source
without asking the model to transcribe it or comparing a copy against raw
provider formatting. Existing receipts containing a complete source copy retain
this behavior. Split concerns require exact excerpts, checked in the same text
representation used at conversation ingress. Provider identity, recipient,
message attribution and current work revision are still verified; routing never
records an effect approval. Direct replies continue in the original workflow thread. A different
source thread receives an acknowledgment and verified destination link.
The interpretation pass chooses routes rather than composing substantive
answers; routed replies contain only a short destination acknowledgment when
needed. New ongoing ideas receive an internal discussion bookmark even when
the human explicitly wants no card or external change yet. Live qualification
must inspect persisted drafts as well as the visible response.

Coordinator replies, clarifications and destination acknowledgments are delivered
as Markdown. Human-facing prose uses real paragraphs and lists; the delivery
boundary repairs double-escaped paragraph/list separators while preserving code
and literal paths. It does not rewrite retained answers or structured work data.
The configured provider's working indicator ends after direct delivery, replay, failure
or cancellation. Before delegation, the coordinator ends its own indicator;
the selected Agent then owns its status, including suspended approval state.
Optional provider status failures cannot replace the accepted turn's result.

The Instance reuses `chat_values` for attention and immutable routing receipts.
Attention is scoped by instance, principal, surface, account and channel; an
atomic revision comparison prevents concurrent turns replacing each other.
Retention is 30 days. Clarifications expire after one day; draft discussions
become dormant after seven days without use. Closed, dormant or linked drafts
are pruned when room is needed within the eight-draft limit. Retained drafts
hold no business-effect authority.
The working context keeps at most three focus references, eight recent bounded
exchanges, eight drafts and four pending clarifications. Search pages contain
six existing records; at most eight additional read calls and three explicit
concerns are accepted per turn. Selected detail is capped at 10,000 characters
and reports truncation. Current conversation history is limited to 12,000
characters; the selected Agent receives at most twelve messages and 32,000
characters from its existing transcript. Pending answers expose a 4,000-character
preview and require an explicit full read before routing longer text (maximum
16,000 characters). There is no background transcript summarizer or new search
index.

Dispatch retains per-concern running/completed/failed receipts alongside the
existing workflow or Builder execution. The same original source is reused on
retry. Provider and model errors remain visible; routing completion never proves
a business write. Source changes require fresh interpretation. Builder job
creation links its preceding discussion draft to the actual job, whose existing
worker leases, deadlines and notifications remain in force.

Disabling the Workspace flag restores legacy entry behavior without removing
workflow state. Previously issued button decisions and publications remain
readable. Unresolved legacy numbered choices import only after the adapter
rereads and verifies the retained original answer and candidate order.
Compile and deploy an exact Core/Workspace pair before live acceptance;
local synthetic transport tests do not constitute provider delivery acceptance or
production qualification of another adapter.

## Selective participation in shared conversations

The existing conversation coordinator follows the shared Core participation
policy. It records `participation: context-only` with no reply, routes or
clarification when humans discuss among themselves. This retains attributed
context without starting another Agent, creating a draft, posting status or
changing business state. Clear unmentioned follow-ups can still route to the
existing work. Native mentions and DMs use the normal response path. The
ordinary Agent loop uses the same output controller when no coordinator applies.

See [Shared Conversation Participation](../specifications/conversation-participation.md).
Exact provider ownership, current sender permissions and independent authorized
job notifications remain mandatory. This source change needs an exact Instance
adoption and configured-model qualification; unit tests are not live evidence.

## Monitor a scheduled review without an Agent

The existing authenticated operator endpoint accepts:

```json
{"action":"health","workflowId":"quality-review","graceMinutes":120}
```

This read bypasses model generation and workflow/connector initialization. It
uses the current compiled calendar, host activation and retained run state.
The response reports a blocked run, an overdue successful occurrence after the
chosen grace period, or two successive unsuccessful expected occurrences.
A quiet `done` result counts as success. Disabled calendars and non-working days
do not create missing occurrences. The lookback is bounded to 30 days and 100
runs; overflow is explicit. Ordinary operator authentication still applies.

A healthy or intentionally disabled review returns 200; a required intervention
returns 503 with structured issues and run references. Query/storage failures
also return 503. Connect this check to the Instance's existing operations monitor,
accountable human, permitted destination and repeat suppression. A 503 or log
alone is not delivered notice. Verify an intentionally blocked review, unavailable
model, actual alert receipt and recovery before unattended activation. Until that
route is qualified, keep the review calendar blocked. No additional monitoring
Agent or notification service is installed by this endpoint.

## Collection conversation continuity

Collection is a terminal submission for the current question, not a partial-note
operation. The model receives explicit guidance to retain incomplete facts in
conversation history, ask only for remaining facts, and satisfy any Workspace
preview requirement before submitting. Missing facts must not become placeholders.
After a successful collection receipt, the host ends that model turn and lets the
workflow deliver the next question or review; it suppresses contradictory trailing
prose that could send the person back to an already completed question. Business
completeness checks remain in Workspace Tools; prompt guidance alone is not proof
that the facts are complete.

If the coordinator selects a workflow through an older delivered question while
the same run awaits a newer collection, the maintained receiver can forward the
original verified message to that current question. It requires one current
delivery for the same run, pinned Artifact, step, recipient and transport audience,
and rereads the exact revision before dispatch. The original thread receives a
visible continuation link. It cannot select another run, widen the audience,
reopen terminal work or infer a decision. If no unique current delivery is
available, the old publication remains discussable without collection controls.
Opening a conversation pane is client UI behavior, not a workflow delivery proof.


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

## Keep draft validation inside the conversation

A `collect` step may declare `validate: company:<tool-id>`. The Tool must be
explicitly granted to the workflow Agent, have risk R0 and no capabilities.
Core calls its pinned isolated implementation with `{context, facts}` only after
checking the active human, exact private assignment, waiting step and lease.
The Tool returns exactly `{accepted: boolean, feedback: string}`; feedback is
bounded to 2,000 characters and must explain a rejection. Business format and
completeness rules stay in the Workspace.

A rejection leaves the same collection, deadline, run and conversation waiting.
It does not publish, advance, create a repair thread or consume a repair round.
The maintained host returns `collected: false` with internal feedback to the
Agent, which revises or asks a natural follow-up. Only accepted facts finish the
step. Validators cannot alter the candidate or authorize an effect. A Tool
failure leaves the waiting state intact and is reported as a Tool error.
Older collections without a validator retain their existing behavior.

The maintained chat host now owns the working indicator around every actual
specialist model turn, including buffered and Tool-delivered replies. It clears
that indicator in `finally` on success, error and cancellation. Explicit approval
waiting uses suspended status; ordinary waiting for another answer is not ongoing
processing. The coordinator finishes its own indicator before delegation, and a
specialist does the same before a further handoff. No shared multi-Agent routing,
work identity, permissions or conversation storage is replaced.

Qualify early candidate rejection followed by a corrected answer in the same
thread, private delivery recovery, model dialogue and status cleanup separately.
A synthetic engine or model test does not establish live provider acceptance.

## Wait for a complete current inventory

The standard Records query can wait when no matching complete source scan exists
yet, or its start precedes the requested `require_scan_started_after`. The
maintained Records service raises a typed pending-read signal; Company Tool text
cannot request retries. The Runtime preserves that signal across its isolated
Tool boundary only for `oregano:records/query`.

The engine retains the prepared input, original logical instant and scan deadline.
It schedules the same read through a durable `records` wait every 30 seconds,
for at most 15 minutes from step preparation. Timer repair after a host restart
restores a missing timer. Completion continues the original run without an
operator resume. The independent Records worker must still synchronize the exact
configured source; waiting does not start another source or relax its scope.

Authorization, malformed inventory, ordinary provider errors and unknown effect
outcomes remain blocked. Exhausting the wait also blocks for inspection without
substituting stale rows. Effects are not automatically retried by this mechanism.
Before downgrading to a runtime that predates `records` waits, drain those waits
on the newer runtime; immutable old artifacts and completed runs are unchanged.

## Resume a pending Brain write

The maintained Brain write Tools also use a bounded durable `effect` wait when
Git receipt reconciliation or post-commit indexing is pending. This preserves
the original run, input and effect identities. Every 30 seconds, for at most
15 minutes after preparation, the exact standard Tool may recheck provider
receipt evidence and refresh the index; it cannot dispatch another Git mutation.
Company Tool text and unrelated unknown effects cannot opt into this behavior.
After the bound, an authorized operator may resume the same reconciliation
through `resume`. Missing proof still blocks. Drain these waits before deploying
a runtime without `effect` wait support. See the [Brain contract](../specifications/brain-read.md).

## Inspect a deduplicated child from a scanner

The existing `start` step returns `run_id`, `status`, `blocked` and
`succeeded_steps` for the child at the time of selection. Repeated starts with
the same workflow and opening fields reuse the same child, including terminal
children. No message bodies or child outputs are copied to the parent.

Workspace policy interprets that snapshot. A `done` child can have ended through
a rejection or skip branch, so successful business completion may additionally
require a particular verification step in `succeeded_steps`. A scanner never
reopens a rejected or cancelled child merely by starting it again. The child
keeps its original conversation, pinned artifact, approvals and receipts.

## Repair a blocked read phase

Ordinary `resume` retains successful outputs. If a successful model response is
invalid downstream, or previously read context is stale, the authenticated
operator may use `repair-read-phase` with `runId`, `fromStepId`, the exact
observed `expectedRevision`, and a bounded `reason`. Optional `feedback` contains
1–2,000 characters without control characters describing the observed validation
problem. Core retains it immutably in the repair snapshot and includes its digest
in control events and paid-attempt evidence. Only the first repaired step receives
it through trusted invocation context. Language generation encloses the original
input and this diagnostic as separate evidence fields; feedback never replaces
source facts, Skill instructions, model selection, grants or validation. Later
steps and conversation calls do not inherit it. Existing repairs without feedback
keep their original behavior. Core accepts only a
previously attempted linear R0 Tool path ending at the blocked cursor. Every
resolved Capability must be read-only. The operation cannot cross a route, wait,
human decision or write, reopen a completed run, replace its Artifact or source
admission, or alter any prior effect. A pending wait must reconcile normally.

Each run allows at most three explicit repairs. Core archives the exact prior
step outputs, input digests and item receipts with operator/time/reason evidence
before restarting the selected path. New model calls retain separate attempts
and costs; failed responses remain inspectable. Workers never choose this
operation automatically. Failed or uncertain writes continue through their
existing effect recovery, not read repair. The unchanged 64 MiB snapshot bound
also applies to retained repair history.

A transcript import binding may additionally declare at most 100 exact
`nonTranscriptSources` entries with `identity`, `version` and
`kind: discussion`. These reviewed source versions use the same source-keyed
Workflow and normal Records/Tool permissions while retaining a distinct immutable
non-transcript admission proof. They never allocate, refill, or change transcript
cohort slots. Unknown versions and overlap with any admitted transcript fail
closed. This is a finite selection, not a channel wildcard or an automatic
expansion policy. Earlier completed source versions remain deduplicated.

An optional `processingField` points to an exact Workspace configuration subset
`{ max_transcripts, sources: [{ identity, version }] }`. An empty list pauses
transcript execution. The list must fit the declared maximum, contain distinct
identities already in the frozen cohort, and use exact content versions. Core
checks the current activated subset both before opening and before executing or
resuming historical runs. Reducing this subset preserves all original admission
receipts, Records, prior attempts and completed pages; retries cannot refill it.
A later reviewed configuration activation may intentionally expand it. Discussion
selections remain independently exact and do not consume transcript slots.



## Exact retained Record version reads

The existing Records query accepts optional `source_version_id`, the exact
64-character normalized version ID returned in a prior row. Omission or null
preserves ordinary current reads. A selected version is read only from the
current projection's at most 100 contributing source generations, after the
active subject passes current projection and source access. It uses existing
immutable version storage and reapplies the current projection's source/type
selection, field allowlist and filters. It never falls back to another binding,
Instance, arbitrary provider revision or nearby observation. Missing, deleted or
nonmatching versions return no rows; invalid provenance or modified immutable
content fails. No provider call or database migration is involved.

The result marks `retained_version_id`, uses the original observation time and
sets `fresh_until` to that same time. It provides no source-completeness or
current-scan proof. Cursor, all-pages and completeness/scan requirements cannot
be combined with this mode. The exact result is capped at 2,500,000 serialized
characters without truncation. Consumers must retain the earlier row version ID;
a provider's own content hash is a distinct value. Current source access changes
and binding generations remain effective for historical reads.


Historical Evidence Workflow queries may include `match_fields` for one selected
Workflow and at most four exact declared instance-key values. The store applies
the predicate before ordering and the result limit; the Connector independently
checks every returned identity. Unknown/non-key fields and cross-kind use fail.
Current Agent, Workflow, group, time-window, payload and result bounds remain
unchanged. This reads existing run history; it does not create a source-progress
registry, infer outcomes or reset effects.

Historical Workflow evidence defaults to bounded feedback event reads. An explicit
`include_feedback: false` selects retained outputs without reading the feedback
event log; each run returns `feedback: null` and coverage records
`feedback-not-requested`. Complete coverage then refers only to the requested
projection. It never establishes absence of feedback, approvals or provider events.

## Continuing Agent tasks

The maintained host supports declared durable Agent steps using the same store,
leases, ModelRecipe resolver, Tool runtime and attempt accounting. Inspect the
step's Agent journal to distinguish a prepared model turn, retained response,
completed Tool call and accepted final result. Partial external writes are not
workflow completion. Resume uses receipt reconciliation for known writes. Unknown
model outcomes remain stopped; ordinary resume must not generate another paid call.
For `completion: text`, terminal evidence is the persisted complete non-empty
no-Tool response and the call journal. It ends without another generation or a
content validator. A final report can describe uncertainty or incomplete work;
inspect it separately from actual write receipts and independent acceptance.
Default structured Agent tasks still require an accepted finish Tool.
Finite budgets and scoped Skill reads are pinned in the Artifact. Deploying a new
definition does not migrate an existing run or reset its attempts.


### Explicit continuation of an unwritten source

The Core `continueUnwrittenSource` operator method can replace an unfinished source
run exactly once with a reviewed replacement Artifact. It requires current operator
authority, source admission and processing scope, an exact revision, only attempted
R0 computations/routing, no decisions, no Agent Tool conversation, and no unknown or
unfinished model attempt. A possible write is never replayed through this path.
The existing lease fences cancellation and an immutable successor reference before
creating the replacement. A lost result reuses that successor; normal source-version
opening follows the link. Both runs retain their original Artifacts, source version,
outputs, repairs and all billed attempts. The successor records its predecessor and
starts the reviewed procedure anew. A further continuation of that successor is
unsupported; ordinary durable resume and targeted correction apply.

Source-history reads expose these references at the trusted cutoff. The Brain
procedure accepts only its exact linked cancelled predecessor as unwritten history;
an unrelated cancelled run or an unchanged completed source is not silently ignored.
This is an explicit Core operator action, not a model Tool, automatic retry or a
source-version change. It grants no new sources, Tools or provider access.

A completed effect `for_each` with the canonical empty input digest, empty retained
item map and exact empty output has no dispatched operation. Source continuation
may cross that step. Missing, running, nonempty or inconsistent evidence still
blocks continuation, including in archived read-repair snapshots.


### Explicit retry of an unavailable Agent model response

An authenticated operator may call `retry-agent-model` with the exact run revision,
last attempt ID and reason. Core requires a stopped Agent turn with an unavailable
model response, no retained response or Tool results, and its unknown dispatched
attempt receipt. Current activation/source scope and the original task budget still
apply. This is permission for another paid generation, not proof of zero prior cost.

The journal appends an immutable operator/time/reason receipt; prior responses,
Tool results, source identity, instructions and unknown usage stay unchanged. The
next model turn continues the same conversation. No Tool call can be replayed from
the missing response because Core dispatches only a durably retained response.
Repeating the same operator request returns its existing authorization. Ordinary
resume and model-generated inputs cannot authorize this retry. Do not claim complete
cost accounting until the unknown provider usage is reconciled separately.

### Continuing Agent cost stops

An adopted Agent step may declare cumulative input-byte and output-token budgets
and a consecutive no-progress limit. The immutable turn journal records host
request reservations and actual output usage when available. Cached inputs still
count toward the serialized input bound. These bounds cover the Agent step;
include earlier generation steps such as utility triage in complete import cost
reports. Missing usage is not zero cost.

Unknown model responses stop without an automatic paid continuation. With
`failure_policy: stop`, known incomplete responses stop as well. New Brain imports
use `failure_policy: continue-output-limit`: only a retained, dispatched `length`
cutoff automatically continues within the same journal. Partial calls are discarded,
prior successful receipts are replayed as context, exact repeated successful R1
inputs are rejected, and recovery permits one Tool operation per response.
Cutoffs consume output budget and count toward the no-progress limit. Unknown
outcomes, other finish reasons and historical definitions retain their stop policy. `resume` does not authorize another model call. An explicit exact
`retry-agent-model` action can authorize another attempt only for a dispatched
failed/unknown response; it retains prior costs and cannot reset the original
budgets or discard saved Tool results. A local pre-dispatch budget rejection
requires correcting the reviewed configuration, not pretending it was a paid
failure or silently switching to another pipeline. No-progress stops similarly
remain unfinished; never mark a partially written source as ingested.

### Agent output recovery and hosting headroom

New Brain imports allow 32,000 tokens per response; the remaining 48,000-token
task allowance may reduce the next response ceiling. This is not a budget reset.
Use a reviewed 360,000 ms model binding when adopting the larger allowance. The
host caps Agent calls at 360 seconds, with 600-second operator/steps endpoints,
a 600-second steps-worker timer lease and a 600-second Agent-Workflow lease.
The existing 150-second dispatch window leaves 90 seconds of headroom. Workflows without
Agent steps retain their five-minute lease. Unavailable transport remains unknown
and requires explicit reconciliation/retry; it is never classified as a cutoff.

A configuration change applies to newly built Artifacts. It neither rewrites an
old run's budgets/policy nor restarts completed or stopped sources. Qualify recovery
with a saved operation, a known cutoff, a worker restart and the remaining work;
verify unchanged source identity, preserved receipts and all failed-attempt costs.
