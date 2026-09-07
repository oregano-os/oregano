---
document_id: operations.vercel-workflow-runner
title: Vercel Workflow Runner Operations
kind: guide
status: approved
authority: canonical
language: en
implementation_scope: provider
providers:
  - vercel
  - slack
  - monday
  - postgres
updated: 2026-09-07
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
---

# Hosted Workflow Engine Operations

The Vercel host runs compiled Workspace workflows through the generic durable
engine. Configuration, calendar activation, operator authentication, human
decisions and provider effects remain separate controls. These endpoints do not
establish provider data completeness or authorize production activation.

## Prepare an exact Instance

1. Compile the reviewed Workspace and its non-secret Instance bindings. Include
   exact logical message destinations and stable-member direct recipient
   mappings. An existing Slack app may serve an isolated test Instance; use its
   approved test channel and recipients. Do not repoint production webhook
   ingress or share the production database for test execution.
2. Prepare and qualify the Company database through the maintained bootstrap,
   including manifest `2.0.0`. Workers qualify before use; they do not apply an
   unapproved migration. One deployment uses one `DATABASE_URL`; never switch
   databases inside a running function.
3. For each `oregano/company-records` Connector, put the complete non-secret
   Records runtime configuration in `configuration.configuration_snapshot`.
   It replaces `configuration_ref` for hosted workflows. Existing validation
   checks declarations, bindings, qualification and exact Core/Workspace refs.
   Raw credentials are rejected; SecretRefs remain references. Retain matching
   source projections and evidence for open runs. New source declarations cannot
   silently satisfy old source digests. Synchronization and qualified cutoff
   coverage remain separate requirements; a snapshot manufactures neither.
4. Configure `SLACK_CONNECTOR` with the existing Vercel Connect installation
   reference. Its app credential must support `auth.test`, `users.info`,
   `conversations.info`, exact `conversations.replies` reads, message publishing
   and required history scopes. Qualify these against the actual installation.
   Missing history access and ambiguous identities fail closed. Cross-workspace
   Slack Connect humans are not supported by the current identity check.
5. Set `COMPANYOS_WORKFLOW_CONFIG_GZIP_BASE64` to gzip-compressed, base64-encoded
   JSON matching the configuration below. Use a separate secret for each human
   operator and `CRON_SECRET`, each at least 32 characters. Never put their values
   in an Artifact or repository.
6. Set `COMPANYOS_WORKFLOW_ENABLED=true` only for the approved Instance; the
   default is `false`. `/api/health` reports enablement without exposing operator
   credentials. The cron configuration invokes the workers every minute.
   Preview tests must invoke these same protected endpoints through their
   approved driver when the host does not schedule Preview cron invocations.

Example shape; replace all illustrative IDs and the hash:

```json
{
  "version": 1,
  "instanceId": "example-preview",
  "artifactHash": "<exact Artifact hash>",
  "environment": "preview",
  "enabledWorkflowIds": ["daily-summary", "period-close"],
  "autoOpenWorkflowIds": ["daily-summary"],
  "schedulePrincipal": "slack:TEXAMPLE:UEXAMPLE",
  "activatedAt": "2030-01-01T00:00:00.000Z",
  "maxLatenessMinutes": 60,
  "recordSync": {
    "intervalMinutes": 5,
    "targets": [
      { "artifactHash": "<exact Artifact hash>", "sourceIds": ["work-items"] }
    ]
  },
  "operators": [
    { "principal": "slack:TEXAMPLE:UEXAMPLE", "secretRef": "env:WORKFLOW_OPERATOR_SECRET" }
  ]
}
```

Configuration pins the exact Artifact, Instance and deployment environment.
Operators resolve to current active humans. The schedule principal identifies
an accountable configured operator. Automatic opening allows only workflows
whose required fields are supplied by trigger identity and run date. Otherwise
prepare exact future occurrences using `schedule` and explicit Workspace-defined
fields. The engine persists a start wait; Core does not invent business periods.

## Worker and operator calls

| Endpoint | Authentication | Operation |
|---|---|---|
| `GET /api/workflows/timers` | Scheduler bearer credential | Open automatic occurrences, repair waits and wake claimed timers. |
| `GET /api/workflows/steps` | Scheduler bearer credential | Advance bounded pages of enabled running workflows. |
| `GET /api/workflows/records` | Scheduler bearer credential | Synchronize explicitly retained Artifact/source pairs through the existing Records service. |
| `POST /api/workflows/operator` | Configured human bearer credential | Open, prepare, inspect, cancel or resume runs; reread a provider reply. |

Operator bodies are strict JSON, at most 32 KiB. Each example is a separate
request. Callers cannot supply a principal, approval decision, arbitrary schedule
parameters or replacement Artifact:

```json
{"action":"open","workflowId":"period-close","requestId":"independent-request-1","fields":{"period_id":"period-1"}}
{"action":"open","workflowId":"daily-summary","requestId":"independent-request-2","fields":{},"triggerVariant":1}
{"action":"schedule","workflowId":"period-close","instant":"2030-01-04T16:00:00.000Z","fields":{"period_id":"period-1"}}
{"action":"read","runId":"workflow:<64 hexadecimal characters>"}
{"action":"list"}
{"action":"cancel","runId":"workflow:<64 hexadecimal characters>"}
{"action":"resume","runId":"workflow:<64 hexadecimal characters>"}
{"action":"receive-reply","threadId":"slack:DEXAMPLE:100.000001","messageId":"100.000002"}
```

`open` uses a stable caller-generated request ID. Repeating it is a redelivery;
a different ID creates an independent run. Changed fields under the same ID
fail. `schedule` requires an exact active calendar occurrence. `list` returns
at most 200 summaries and an `afterRunId` continuation. Summaries expose state,
blocked-error digest, pinned hashes and deadlines. Full events and effect
receipts remain in the database. Refused requests return an evidence digest
correlated with host logs. Unknown or failed effects cannot be blindly resumed:
review retained provider evidence and resolve the incident before authorizing
any new effect. There is no automatic unknown-effect reconciliation action.

For a manual opening that needs declared trigger parameters, supply
`triggerVariant` (integer 0–999). It indexes only the retained schedule entries
whose ID matches the selected workflow's trigger, starting at zero in declaration
order. For example, `1` selects the second matching entry's parameters. Inspect
the actual compiled Artifact before choosing; a missing entry is rejected.
The operator cannot replace those parameters. The run opens at the actual time,
keeps all later delivery windows and deadlines, and needs the same enabled
workflow and authenticated operator as any other opening. Automatic scheduling
may remain blocked. Retrying the same request reuses its opening; selecting
different parameters under that request ID fails. Omission preserves the
existing behavior without inferring a variant.

## Human decisions and conversations

Each notice contains the complete bound JSON, expiry and exact request ID.
Humans reply in that notice's thread with `APPROVE <request ID>` or
`REJECT <request ID>`. A DM root uses Slack's returned message timestamp, never
the whole DM conversation ID. Delivery subscribes the exact root before
returning its receipt. An unverified subscription retains partial publication
proof and blocks automatic retries.

The host checks the actual app account and current human identity, then rereads
the exact provider reply and verifies its root, author, original unedited text
and complete response. Decisions are processed before model invocation.
`receive-reply` performs the same read so a test Instance can use an existing app
without moving production ingress. Its caller cannot substitute text or an
approver. An edited decision needs a new original human reply. Missing provider
access is a failed qualification, never a simulated human decision.

Exact workflow assignments take precedence over ordinary routing. Agent,
materials, bindings and Tool definitions come from the opening Artifact; human
eligibility comes from the current deployed roster. Only the waiting step's
conversational Tool allowlist is visible and authorized; it is empty by default.
Ordinary model requests outside an assignment cannot call workflow-reserved
effects. Terminal or expired assignments retain proof but grant no conversation
authority. Concurrent conversations do not switch a shared Runtime's Artifact.

All message destinations, including all foreach members, are qualified before
preparing the collection. Each publication repeats qualification within the
same resolved credential scope used to send. Changed accounts or recipients
block dispatch. These reads do not promise provider-side atomicity between a
metadata check and publication.

## Recovery and rollout evidence

Step and repair scans retain run-ID continuations in durable timers. Schedule
scans retain their window, configuration digest and occurrence cursor. Bounded
lateness prevents unlimited catch-up; expired scans are reported. Superseded
configurations cannot open old automatic schedules. Claims have five-minute
leases; workers stop starting transitions after their time budget. Interrupted
runs recover completed effect receipts without republishing.

Disable `COMPANYOS_WORKFLOW_ENABLED` to stop new hosted work. The per-workflow
enabled list controls step dispatch; calendar activation separately controls
new scheduled openings. Cancel specific runs before retiring their definitions.
Retain Artifacts, state, receipts and database history through rollback. Do not
erase evidence to make a retry appear fresh.

Synthetic host tests exercise real engine execution, historical routing, one
bound response, exactly one subsequent write and identity refusals. They are not
installation qualification, real human acceptance or pilot evidence. Qualified
Slack/Monday source cutoff coverage, real test-Instance acceptance, complete
legacy parity/removal and production rollout gates remain mandatory.

Records completeness and row versions bind to the exact non-secret Instance
source binding and qualification. Changing an account, resource or identity
mapping requires new evidence; a new receipt cannot authorize old retained
rows. Source state and projection definitions have independent storage
generations, so the opening Artifact can still read its own materialized
projection after a binding/schema change. A new projection requires its own
successful materialization receipt; empty rows alone are insufficient. Keep
the old Artifact and Records generations, and continue qualified synchronization
through all cutoffs needed by its active runs before retiring them. See the
[Records query contract](../specifications/company-records-query-v1.md).

`recordSync` is optional and disabled when absent. Its current Instance
allowlist contains at most 100 unique Artifact/source pairs and an explicit
polling interval of 1–1440 minutes. Include the deployed Artifact to prepare
its source generations before opening a run. Retained Artifacts additionally
need a currently running or waiting execution of an enabled workflow in the
same Instance. Terminal executions and disabled workflows do not keep their
sources active. Removing a pair revokes future polling without deleting data.
An already-started read can finish; revocation does not retract provider reads.

The worker loads each source from exactly one non-secret Records snapshot in
that Artifact. It reuses current provider credential qualification, generation
storage, source leases and `synchronizeRecordSnapshot`. The installed Core must
still support the exact source Connector version; no implicit adapter upgrade
or configuration fallback is allowed. Polling appends observations without
inferring deletion from absence. Existing explicit reconciliation is separate.

Each invocation starts at most three source synchronizations and stops starting
them after 150 seconds. A durable cursor continues larger sets on a subsequent
invocation. Already-started scans survive interval boundaries; obsolete unopened
polls are coalesced. The interval is a minimum cadence, not a promise of provider
throughput or a completion deadline. A source failure records a payload-free
error digest and does not stop independent sources; a later poll retries it.
Completed source receipts are reused after a crash before timer completion.
Per-source leases protect concurrent synchronization. No provider write, schema
migration, missing-message inference or `synced_through` value is created by
this worker. A failed or unqualified source still blocks completeness queries.

## Inspect a stopped effect

An authenticated operator can list stopped executions, then submit
`{"action":"review","runId":"workflow:<digest>"}` to the existing operator
endpoint. A keyed collection returns one effect per page; supply the returned
`nextOffset` as `offset` for the next page. Each report identifies the retained
Artifact, manifest, run revision, step, effect claim and evidence digests.
The human operator must inspect every page. The operator report remains
available when automated delivery is unavailable or requires its own review.

For a stopped approval-bound scalar effect, the step worker also prepares
control-notice pages from the retained normalized outcome. It sends them through
the pinned R2 publication Tool to the actual approving human's original decision
thread. The current human role, exact recipient mapping and retained delivery
receipt must still agree. No replacement recipient or destination is inferred.
These notices respect the historical delivery window. An expired business
approval may receive an outcome notice; the approval is never renewed by it.

Pages contain at most 40 normalized evidence lines and 20,000 characters; at most
256 pages may be prepared. Every page is frozen before publication, has a
separate effect identity and retains its publication receipt. The existing
bounded step worker drains them while the business cursor remains stopped.
Restart after provider success recovers the ordinary Runtime receipt. Missing
eligibility or qualification leaves delivery pending for later inspection;
uncertain publication is retained as blocked and is never blindly repeated.
Cancellation or Instance disablement stops new notice dispatch. The separate
review dispatch fence cannot authorize a business Tool or changed page input.

The `review` response includes page count, delivered count and any delivery
error digest. It excludes notice content. Cases without exactly one recorded
approving human, without a usable original delivery, or exceeding the automatic
size bound remain in the authenticated operator queue. Inspect any explicitly
reported additional Capability receipts there; no omitted receipt is success.

For a partially completed batch, `verified` identifies a retained write/readback
receipt, `unknown` requires checking the provider outcome, and `not-attempted`
requires explicit Connector evidence that dispatch had not reached that item.
Missing or malformed item evidence remains unknown. Raw provider exceptions,
message content, tokens and arbitrary evidence fields are excluded. A later
provider change is still possible; the receipt is not a current-state lock.
No report authorizes replay, changes approval scope or silently retries the
unattempted suffix. The complete effect stays stopped pending a separately
qualified recovery action. Current `resume` continues to refuse unresolved
unknown, failed or claimed effects.

## Pin provider write identity

Every retained Artifact using the maintained hosted Monday Connector must carry
the reviewed `credential_identity` in its Instance configuration. Copy its
account ID, authenticated member ID, external-Agent kind and provider Agent
subject from the completed external-Agent qualification receipt; `actor_id`
is the authenticated member ID. Do not infer these values from a newly supplied
token. The host rechecks identity, active resource, current minimum access and
mapped columns before each invocation using the same client credential.

A missing identity on a retained Artifact blocks provider access. Prepare the
qualified Instance declaration before migrating to this Core release; pin it
with the Artifact and preserve its prior evidence. Token rotation to a different
identity needs reviewed Instance configuration. Qualification metadata is
retained with success and unknown-effect receipts, but is not proof of write
success or atomicity. This setup change does not activate production.

## Verify one completed run

Use `companyos verify-live --scope workflow --state <file>` after the ordinary
workflow completes. See [the command contract](../workbench/commands/verify-live.md)
for its non-secret exact-candidate file. The CLI sends only the authenticated
operator action `verify`. Operator authentication and the configured hosting
boundary remain required; missing or disabled hosting fails explicitly.

The optional `requirements` array on `verify` selects a nonempty unique subset
of `wait`, `human-decision`, `record-source`, and `approved-batch`. Omission
requires all four. The receipt binds the normalized set; it never disables
checks on executed steps. The corresponding CLI state field is
`required_evidence`. Require actual batch evidence on a workflow that performs
one rather than adding a redundant write to a review-only workflow. Retain the
separate complete acceptance plan across exact-candidate runs.

The operator response can inspect a historical run, but live candidate
acceptance requires that run's Artifact and Core identity to match the exact
current deployment. A later deployment does not inherit acceptance from a run
on an earlier Artifact. Verification never repairs audit gaps or retries an
effect. Preserve the returned receipt with the separate real-provider,
restart, deactivation, rollback and human-participation evidence.

For a CLI deployment from a Git worktree, verify the provider source metadata.
Vercel CLI versions that read `.git/config` directly may omit the Git provider
when `.git` is a worktree file. Supply the documented GitHub metadata from the
actual clean checkout (`githubDeployment=1`, exact `githubCommitSha`,
`githubCommitRef`, repository and owner), then compare deployment metadata and
runtime identity. Do not invent a source ref, alter identity tokens, or disable
the runtime's exact-commit comparison. The [Vercel metadata guide](https://vercel.com/kb/guide/branch-variables-and-domains-not-linked-to-cli-deployments)
documents this CLI mechanism. This does not require connecting a production
Git webhook or promoting a Preview.

## Decision buttons and interaction ingress

Newly compiled human decisions publish provider-neutral decision controls with a
request identity and optional Workspace labels. Slack renders native buttons;
its signature-verified action handler checks the current human identity and the
exact delivered message before invoking the existing engine decision operation.
Tool approvals reuse the same card renderer but retain their separate Runtime
approval operation. An action label never names a Tool or chooses a workflow
branch; only the fixed approve/reject semantics do that.

The Slack Interactivity endpoint must reach the Instance which owns the pending
request. Sharing an app between production and a Preview does not provide an
interaction router. A click received by another Instance fails closed; it must
not be forwarded to an arbitrary URL supplied in a button or interpreted by a
language model. Qualify actual button ingress before enabling live decisions.
Operator bearer requests cannot submit button events or approving identities.

Retained older Artifacts keep their original text notices and reply protocol.
Do not rewrite an outstanding request during rollout. Existing Tool approval
IDs also remain valid; removing their handlers would break pending requests.

For provider-specific destination registration and routing diagnostics, use the
[Vercel Connect interaction guide](vercel-connect-workflow-interactions.md).
Other hosts and communication providers must satisfy the same acceptance gate
below through their own adapters; they do not inherit Vercel setup requirements.

A successful workflow button decision replaces the original card with an
explicit recorded approval or rejection and no action controls. Approval
confirmation does not claim that downstream effects have executed. The durable
engine decision precedes this transport projection; a failed card edit is
reported separately and must not be represented as a failed decision. An exact
provider redelivery can retry the projection through the engine's existing
idempotent response path. Rejected or unverified requests never close a card.


## Larger deployment artifacts

When the compressed Artifact no longer fits a deployment environment variable,
encode the same JSON with Brotli and set `COMPANYOS_ARTIFACT_BROTLI_BASE64`.
Leave `COMPANYOS_ARTIFACT_GZIP_BASE64` empty. The runner accepts exactly one of
the two payloads and still verifies the Artifact hash and deployment environment.
This changes transport only; it does not change grants, bindings or workflow state.
Check the encoded value and total environment size before deploying. If neither
encoding fits, do not truncate the Artifact or remove its integrity checks.

## Conversation tests with a shared Slack app

The action-only test endpoint does not receive normal conversations. Do not test
a new conversation in the shared app's direct messages: the production bot may
also process that reply. Use a new thread in the approved test
channel, with one recipient mapping and `COMPANYOS_WORKFLOW_ONLY=true` in the
test environment. This enables original channel-thread events on the workflow
endpoint. The SDK verifies the original event; only subscribed, assigned threads
reach the workflow, and unassigned replies receive no general-agent fallback.
Replies may include an explicit app mention when the channel has an exclusive
destination as described below. Do not reuse a production thread.

A recipient-bound channel remains visible to channel members; it is not a private
message. The recipient restriction controls who may supply facts or confirm.
For private tests, use a separately installed test app or an independently reviewed
exclusive event route. Provider fan-out alone does not isolate normal DM replies.

### Check incoming replies before opening a conversation

Sending a message, reading history and receiving new replies are separate checks.
An app that can post a question may still receive none of the answers. In Vercel
Connect, inspect the bound connector's event subscriptions and trigger forwarding:

| Conversation surface | Required message event |
|---|---|
| Direct message | `message.im` |
| Private channel, including channels whose IDs start with `C` | `message.groups` |
| Public channel | `message.channels` |

`app_mention` alone does not deliver ordinary thread replies. Determine visibility
from `conversations.info`, not the channel ID prefix. The host now checks the
current connector metadata before publishing to a recipient-bound destination.
Missing events or disabled forwarding fail qualification with the event name;
they must not produce a question the user cannot answer. A metadata check still
does not prove end-to-end delivery: send one real reply and verify its incoming
request, assigned conversation and Agent response before accepting the setup.

Subscriptions apply to the shared app, not just the test deployment. Adding an
event can deliver it to the production destination too. Inspect that handler and
obtain any required production authorization before changing the subscription.
Before testing mentions, exclude the exact test channel on the other destination;
otherwise the production bot may answer too. Keep a failed test pending; do not copy the user's text into a
fabricated webhook or count an operator-only replay as live delivery acceptance.

See the [Vercel Slack setup instructions](https://vercel.com/kb/guide/build-a-slack-bot-with-vercel-connect)
and [Slack private-channel events](https://docs.slack.dev/reference/events/message.groups/).

For a staged shared-app rollout, the main Slack webhook has an opt-in
`SLACK_CHANNEL_MESSAGE_EVENTS=ignore` guard. Deploy and verify this guard on a
destination that must retain mention/DM-only behavior **before** subscribing the
app to channel message events. It drops `message` events from public or private
channels on `/api/webhooks/slack`; `app_mention`, direct messages and interactive
controls keep their existing authenticated path. The workflow-only test endpoint
is separate. The default `process` behavior is unchanged. This is an Instance
rollout choice, not a Workspace business rule or permission to deploy production.
Remove the guard only after channel conversation behavior is explicitly accepted.

To give the workflow Instance exclusive ownership of an approved test channel,
set `SLACK_IGNORED_CHANNEL_IDS` on the other Instance to the exact channel IDs,
separated by commas. Omit the variable when no channels are excluded. Wildcards,
duplicates, direct-message IDs and empty entries are rejected. On the ordinary
Slack webhook this excludes both `message` and `app_mention` for those channels.
Mentions elsewhere, DMs and interactive controls retain their existing paths.
The existing `SLACK_CHANNEL_MESSAGE_EVENTS=ignore` setting can remain in place.

The workflow-only endpoint accepts signed ordinary messages and `app_mention`
events, then checks the persisted conversation and its assigned recipient.
Selection alone grants no authority; unassigned messages have no general-chat
fallback. Test both destinations before inviting a person to reply: the excluded
channel must not wake the ordinary Agent, while the assigned workflow must
receive the mention through the unchanged SDK verifier. A reply from a general
Agent does not prove that the workflow processed it. Retain separate evidence
for ordinary, unmentioned reply delivery if that is also required.

### Channel replies and a silent conversation

In the workflow-only Slack lane, a reply in the main channel can continue one
open fact-collection question for the same recipient. With multiple questions,
the bot links to the possible conversations and asks the person to choose.
The host uses `conversations.history` for the exact channel message and
`conversations.replies` for a thread reply. Both keep the original message ID.
Approval buttons and decision-thread replies retain their existing rules.

Check each hop when a posted question gets no answer:

1. Confirm the person's message exists in the expected channel or thread.
2. Check the app's actual Slack event subscriptions and installed permissions,
   then its membership in that channel. Connector configuration alone is not
   evidence of event delivery.
3. In Vercel Connect Observability, find the corresponding inbound trigger and
   its forward to `/api/workflows/slack` in the intended test environment.
4. Find that request in the deployment logs, then verify the active assignment
   and the host result. A successful read through `receive-reply` proves access
   and routing; it does not prove that a webhook arrived or a model answered.

A posting test, a saved subscription or a successful provider read cannot replace
a real reply test. Do not announce a conversation as ready until a person sends
a reply and receives the resulting Agent answer through the deployed ingress.
For a shared app, keep the production channel-event guard and test workflow-only
routing in place while qualifying this path.

### Trace the test reply

Set `COMPANYOS_SLACK_DIAGNOSTICS=true` on the isolated test deployment to trace
the existing Slack workflow path. It is off by default. This setting changes
logging only; it grants no access and starts no workflow. Redeploy the checked
Core/Workspace pairing, then verify its health and exact source commits.

Search its runtime logs for `slack.workflow.diagnostic`:

```sh
vercel --scope <team> logs --deployment <deployment-url> --no-branch --since 15m --json
```

Select the actual deployment's team explicitly. The CLI can otherwise search a
personal team, and its default branch filter can hide the target requests.
An unsuccessful log query is not evidence that a message never arrived.

| Last observed stage | What it proves and what to check next |
|---|---|
| No `received` | No entry was observed in this deployment. Check the environment, log window and upstream forwarding; absence alone does not identify a provider defect. |
| `filtered` | The request reached the test endpoint but failed its selection rules. `outcome` names the rule, such as `conversations-disabled` or `not-channel-message`. |
| `sdk-dispatch` | The endpoint selected the request. Authentication and handler entry are still unproven. |
| `sdk-returned` | The SDK returned an HTTP status. A 401 is rejected verification; a 200 alone does not prove a model response. |
| `handler-entered` | The SDK dispatched a verified message to the existing conversation handler. |
| `assignment` | The workflow lookup finished. `conversation` can proceed; `unassigned`, `closed` or `ambiguous` explains another route. |
| `deduplicated` | This message already has a processing claim. Inspect the earlier attempt before deciding on recovery. |
| `model-started` / `model-finished` | The model call began / completed. This is separate from posting its response. |
| `reply-posted` | The response publication call succeeded. Verify it in the original conversation. |
| `ingress-failed`, `background-failed`, `handler-failed` or `verification-failed` | Processing failed at the named boundary. Do not count the HTTP acknowledgement as a successful conversation. |

`traceId` groups one local attempt. `messageRef` joins ingress and handler records
using a SHA-256 hash of `channel_id:message_ts`; it is correlation, not identity or
approval evidence. The stream contains fixed stage names, elapsed milliseconds,
HTTP status and hashes. It omits message text, raw payloads, headers, credentials,
raw person/channel IDs and exception messages. Upstream log retention still
applies. Disable the setting after diagnosis.

After these checks, use one real reply to verify delivery through the configured
app. Local signed fixtures test the adapter, not Slack's event subscription or
hosted forwarding. Preserve an existing human answer when delivery fails; do not
repeatedly ask for the business content or treat an operator reread as live ingress.

### A ready deployment that does not answer

A Vercel deployment can build successfully while its runtime configuration is
incompatible. One failure occurs when `COMPANYOS_ARTIFACT_GZIP_BASE64` identifies
a new Core commit but `COMPANYOS_RECORDS_CONFIG_GZIP_BASE64` still identifies the
previous commit. The runtime correctly rejects that pair with:

```text
Connector instance 'records' does not match the immutable Artifact identity.
```

An older runner could then cache the partly constructed Chat. Later requests
received that object with no registered response handlers. HTTP acknowledgements
and SDK deduplication could still succeed, while nobody received an answer.
The earlier health check did not construct the chat, so it missed the failure.

The corrected runner caches the Chat only after configuration validation and
handler registration finish. Its `/api/health` check now constructs that runtime
and returns HTTP 503 when configuration is invalid. This construction sends no
messages and makes no model or chat-provider calls; the health route separately
checks the database.

To deploy or recover:

1. Prepare the Artifact and Records configuration from the same reviewed Core,
   Workspace and Instance. Do not weaken their identity check or copy unrelated
   configuration just to make health pass.
2. Deploy both values to the intended environment. Keep the project's saved
   environment variables aligned with deployment overrides; otherwise the next
   deployment can restore the mismatch. Secrets remain in the provider's secret
   store. Updating project variables alone does not update an existing deployment.
3. Check `/api/health` on the exact candidate before promoting it. Verify HTTP 200,
   `ok: true`, and the expected `coreCommit`, `workspaceCommit` and `artifactHash`.
   A login page or HTTP 200 from a webhook is not this readiness proof.
4. Have an authorized tester send one real message and verify the response in
   the same conversation. Repeat for each required route. A working DM does not
   establish that private-channel events reach a separate workflow endpoint.

`bot-initialization.test.ts` runs in `pnpm test` and therefore in PR CI. It uses
synthetic configuration to prove repeated failure without a cached partial Chat,
then successful recovery with the actual SDK handlers registered. It forbids
network calls during construction. This regression test cannot prove a particular
installation's credentials, subscriptions or forwarding; the deployed checks
above cover those separately.

If delivery still fails after startup is ready, follow [the reply trace](#trace-the-test-reply).
Do not reinstall the app or blame a provider from missing log entries alone.
For the general acceptance rules, see [workflow operations](workflow-engine.md).

### Recover an already submitted conversation reply

An authenticated operator can call `/api/workflows/operator` with
`action: "recover-reply"`, `threadId` and `messageId`. Supply the exact existing
thread and reply IDs. The endpoint accepts no text, approval or clock.
It reads the original message from Slack and checks the current human identity,
delivered assignment and historical workflow before invoking the normal Agent
handler. Edited, missing or wrongly attributed replies fail verification.

For a reply posted as a new channel message, use that message's own thread ID
and optionally supply `authorId` as a lookup hint. The operator uses it only to
find the recipient's active question in that channel. It must then read the
original message and verify its actual author. The hint grants no authority.
There must be exactly one eligible open question; ambiguous matches do not
dispatch a model. Direct-message and child-thread replies cannot use this hint.

This action can invoke the model and post its response under the delivered
question. A channel-root answer continues there too, so the next reply retains
the question's assignment and history.
It keeps normal duplicate claims, the waiting step's Tool allowlist and separate
human write decisions. It cannot recover a button click from a caller's claim.
`receive-reply` remains available for a provider reread without model dispatch.

The response identifies `source: "operator-provider-reread"`. Logs use
`workflow.reply-recovery.dispatch` and `workflow.reply-recovery.completed` with
a hashed reference, without message content or credentials. `dispatchCompleted`
means the normal handler returned; it does not prove a new response, because a
previous processing claim can deduplicate the message. Inspect the original
conversation and stored run before repeating a failed or uncertain attempt.
Recovery is separate from proving automatic Slack event delivery. Keep the
original delivery failure open until that route passes its real reply test.


## Check conversation quality before inviting a tester

The health response lists each Agent's effective `modelTask`, `modelProfile`,
`model` and `modelRoute`. Compare these with the intended Instance binding. Do
not accept a default model merely because the deployment is healthy. Custom
Vercel environments need their own approved configuration and secret assignment;
a Production binding does not prove the same binding exists in a custom test
environment. Use the existing model configuration, and never print secret values.

An authenticated operator can POST `check-conversation` to
`/api/workflows/operator` in an isolated Preview Instance. This model-only check
uses the compiled Agent instructions, materials, declared model task and exact
collection schema. It supports only collection steps with no business Tools.
Production deployments and Production Artifacts reject it. It cannot publish a
message, change workflow state, create a human decision or write provider data.
It does invoke the configured model and incurs that provider's normal usage.

Supply `workflowId`, `stepId`, a synthetic `context` object, and `messages` with
`role` (`user` or `assistant`) and `content`. The final message must be from the
synthetic user; up to ten messages and a 32 KiB request body are accepted. Do not
supply a model, principal, approval or provider credential. Responses identify
`evaluationOnly`, prompt/input hashes, actual model execution evidence, response
text and any proposed `collected` objects. These objects are evaluation results,
not accepted workflow facts or human approvals.

Test clear, incomplete, irrelevant and contradictory replies against the
Workspace's quality expectations. Review the meaning of the result as well as
whether collection occurred. A schema pass does not establish factual support.
Then run real incoming-message and human-decision acceptance separately; this
check cannot establish automatic chat delivery or replace the pilot period.

## Continuing a button decision

The verified button handler first records the decision and replaces its controls.
It then advances that exact persisted run with the normal engine, up to 32 steps
and the engine time budget. It does this even if replacing the card fails.
A continuation failure is logged separately from a decision failure. The stored
cursor remains available to the steps worker; do not request another approval
or create a replacement run merely to retry execution.

Acceptance must include a real click followed by a verified effect and completion
reply without a manual steps call. Also qualify the environment's recurring
steps worker: a successful click does not prove recovery after process loss.
A test environment without a recurring worker has a recovery limitation even
when this immediate continuation succeeds.

For a threaded review, Slack provides the parent `thread_ts` and review message
`ts`. Both are checked against the persisted assignment. Existing direct-message
destinations currently reject caller-supplied thread references; this extension
can be used with qualified channel destinations and does not silently weaken
that direct-message check.
