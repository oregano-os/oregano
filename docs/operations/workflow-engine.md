---
document_id: operations.workflow-engine
title: Hosted Workflow Engine Operations
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-09-06
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
   including manifest `3.0.0`. Workers qualify before use; they do not apply an
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
