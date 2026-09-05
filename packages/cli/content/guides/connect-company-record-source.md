---
document_id: guide.connect-company-record-source
title: Connect a Company Record Source
kind: guide
status: implemented
authority: canonical
language: en
updated: 2026-09-05
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
relations:
  depends_on:
    - command.records
    - specification.company-records-sprint-v0.1
    - architecture.company-instance
  related:
    - guide.connect-knowledge-source
---

# Connect a Company Record Source

Use this Guide when a company wants to mirror structured operational objects
from a business provider into the existing Company Instance database so
multiple authorized Agents and Workflows can use fresh, consistent,
provider-neutral projections.

Company Records and Company Knowledge are different. Company Records mirrors
structured objects such as work items, roles, people assignments, statuses,
dates, effort, and governed conversation messages. Company Knowledge ingests documents and evidence for cited
retrieval and review. Neither database projection becomes Handbook authority,
provider authority, or an authorization roster.

For typed arrays and reviewed message forms, follow the
[Record normalization contract](../../specifications/company-record-normalization-v1.md).
Declare literal parser structure in the source, map its actual `parsed.*`
outputs, and keep authenticated sender and provider time in separate fields.
A message template path alone does not define an executable parser. Preserve
malformed answers for workflow evaluation; do not silently discard extra links
or infer identity from a name inside the answer. Provider qualification,
source synchronization and activation still follow the lifecycle below.

The lifecycle is always:

```text
Workspace intent
  -> provider qualification
  -> reviewed source declaration
  -> non-secret Instance binding
  -> local inspection
  -> non-production sync
  -> status and reconciliation evidence
  -> separately confirmed production activation
```

The maintained providers in this release are Monday for operational board
objects and Slack for allowlisted conversations. A future Notion, ClickUp,
Teams, or other adapter must preserve this lifecycle behind the same Record
Source Connector contract; it does not get a parallel synchronization command.

## 1. Interview the company values

Before writing a source declaration, obtain explicit answers for:

- the operational object type and authoritative provider;
- the exact provider resource and optional subset, such as board and groups;
- one stable object identity field;
- every source field and canonical target field;
- required versus optional fields and their value types;
- the people or groups allowed to read the resulting projection;
- any roles allowed to propose later writes;
- delivery mode and reconciliation cadence;
- freshness requirement and projection fields;
- test environment, production environment, data owner, retention concern,
  provider plan, rate limit, and database cost expectations.

Do not guess an answer from a screenshot, field title, sample item, or another
company's Workspace.

## 2. Qualify the existing external Agent

For Monday, use one already reviewed external Agent. The Agent's own
`api_token` is the lasting Instance credential for reads and later allowlisted
effects. Monday currently exposes this pre-release contract only through
`API-Version: dev`; qualification blocks if that contract, identity, or
effective selected-board access drifts. The external Agent token cannot list
its own `agent_knowledge`, so the exact complete grant set in the confirmed
plan is an administrator attestation. The qualification receipt labels that
attestation separately from provider-proven identity and effective
`access_level`; it never claims that the Agent machine-listed all grants.
Monday also exposes different configured UI/callback, authenticated member,
and external subject IDs. The first provider read therefore pauses with a
second confirmation hash. Review that exact identity tuple, then resume with
`--identity-confirmation <hash>`. `access_level: edit` is metadata evidence for
an attested read-write board, not a substitute for a separately confirmed write
proof.

Plan with the explicit target boards:

```bash
companyos records source qualify \
  --provider monday \
  --workspace <company-workspace> \
  --agent-id <exact-external-agent-id> \
  --board-access <roles-board-id>:read \
  --board-access <work-board-id>:read-write \
  --state <outside-workspace-state-file> \
  --plan
```

Review and confirm the hash, inject the existing `MONDAY_API_TOKEN` through the
runtime host's Sensitive secret surface, then apply or resume. Never paste the
token into chat, Git, the command, or the state file. Qualification accepts
only `external_agent_member` or `external_agent_detached_member`, matches the
Agent ID from its provider identity, and requires the complete returned
resource-grant set to equal the confirmed plan. The completed mode-0600 state
file contains non-secret Agent, account, grant, board, group, column, API,
request, and digest evidence. It contains no items, column values, token, or
provider effect.

If the runtime host makes a Sensitive token available only inside a protected
deployment, keep the same qualification lifecycle and add the existing hosted
runtime profile:

```bash
companyos records source qualify \
  --provider monday \
  --workspace <company-workspace> \
  --agent-id <exact-external-agent-id> \
  --board-access <test-board-id>:read-write \
  --runtime-profile vercel-neon \
  --runtime-scope <vercel-team> \
  --runtime-project <vercel-project> \
  --endpoint https://<protected-preview>/api/records/rehearsal \
  --state <outside-workspace-state-file> \
  --plan
```

The first hosted resume obtains a separate provider-read plan and calls no
provider. Confirm its exact hash with
`--provider-read-confirmation <hash>`. The protected Preview then performs one
metadata-only Monday read and returns non-secret discovery evidence. The same
human `--identity-confirmation <hash>` remains mandatory before the receipt is
complete. Only the short-lived rehearsal bearer enters the local process; the
Monday token stays in the deployment and is neither exported nor stored by the
Workbench.

## 3. Author and materialize the Workspace declaration

Create an explicit draft after the interview. This fictional Monday example
uses provider column IDs only because they were present in the qualification
receipt:

```yaml
schema_version: 1
id: delivery-items
record_type: work-item
connection: connections/monday.md
resource_binding: delivery-board
delivery: poll
reconcile_schedule: schedules/daily-records.md
identity:
  source_field: id
fields:
  - target: title
    source: name
    value_type: string
    required: true
  - target: status
    source: column_text.status_col
    value_type: status
  - target: owner
    source: people_principals.people_col
    value_type: identity_list
    resolve_identity: true
access:
  read_groups:
    - delivery
  write_roles: []
```

Monday selected-item inventory exposes the stable item fields `id`, `name`, `updated_at`,
`board_id`, and `group_id`; parsed provider values under
`columns.<column-id>`; and display text under
`column_text.<column-id>`. Choose the representation deliberately. The
Workbench verifies that every named column exists on the qualified board but
does not infer what it means.

The principal mapping above requires Monday Record Source `0.3.2`, qualified
account evidence and the frozen reviewed roster. It resolves exact people to
stable roster IDs; unmatched identities and teams stay explicit. For raw
provider IDs, use `columns.people_col` with `identity_list` and no resolution.
People columns contain arrays, even when only one person is assigned.

Slack Record Source `0.1.1` exposes `author_principal`, `editor_principal`,
`content_author_principal`, precise `occurred_at` and `accepted_at`. For deadline
evaluation map `accepted_at`: it reflects the current content version, including
edits. Keep original authorship, current content authorship and `author_kind`
so the Workspace can reject another editor's content or a bot response. Do not
resolve the unqualified `author_id`. Updating either Connector requires an
explicit Instance version pin and a new synchronization of adopted fields;
it does not activate the source or prove synchronization through a cutoff.

For a reviewed complete table surface, map the built-in fields `object_kind`,
`provider_id`, `provider_payload`, `root_board_id`, `board_id`, `group_id`, and
`parent_item_id`, and set the Instance binding to
`inventory_mode: complete-table`. That mode stores board, active-group,
active-column, main-item, and one-level-subitem objects plus every returned
column value. The child board must be named by the qualified parent subitems
column; any other child board fails closed. It rejects group filters. It does not fetch updates, comments,
attachment binaries, linked foreign-board contents, archived items,
deleted-item history, or deeper subitems. Those are separate reviewed data
classes. A complete raw inventory does not expose complete data to an Agent;
projections remain explicit allowlists.

Preview materialization:

```bash
companyos records source materialize \
  --provider monday \
  --workspace <company-workspace> \
  --qualification <completed-state-file> \
  --board <qualified-board-id> \
  --declaration <source-draft.yaml> \
  --output <company-workspace>/records/sources/delivery-items.yaml \
  --plan
```

Review every value and use `--apply <hash>`. This creates one file only. Review
the resulting Workspace diff normally; the command does not commit, merge,
deploy, activate, synchronize, or change the provider.

Author one or more projections under `records/projections/`. A projection
selects one record type, exposed canonical fields, a freshness bound, read
groups, and database-view or Workspace-proposal materialization. It never
grants provider access.

For Slack, declare each governed conversation as an independent generic
`communication-message` source. Conversation text is ordinary provider data,
not identity, authorization, approval, Agent selection, or routing authority.
This fictional source intentionally uses no Sprint field:

```yaml
schema_version: 1
id: coordination-conversation
record_type: communication-message
connection: connections/slack.md
resource_binding: coordination-conversation
delivery: poll
reconcile_schedule: schedules/daily-records.md
identity:
  source_field: id
fields:
  - { target: source_id, source: source_id, value_type: string, required: true }
  - { target: message_id, source: message_id, value_type: string, required: true }
  - { target: team_id, source: team_id, value_type: string, required: true }
  - { target: conversation_id, source: conversation_id, value_type: string, required: true }
  - { target: thread_id, source: thread_id, value_type: string, required: true }
  - { target: author_id, source: author_id, value_type: identity, required: true }
  - { target: author_kind, source: author_kind, value_type: string, required: true }
  - { target: text, source: text, value_type: string }
  - { target: occurred_at, source: occurred_at, value_type: timestamp, required: true }
  - { target: provider_payload, source: provider_payload, value_type: json, required: true }
access:
  read_groups: [coordination]
  write_roles: []
```

Before the first history read, the protected Preview rehearsal supports
`plan-slack-qualification` followed by `apply-slack-qualification` for the
exact source id. The first action performs no external call. The second reads
only `auth.test` and `conversations.info`: it verifies the bot's exact team,
conversation membership, public/private kind, and required history/read
scopes. It does not read messages, and the returned receipt retains no token
or message content. Put that receipt outside the Workspace and pin its digest
in the non-secret Instance binding before synchronization.

## 4. Create the non-secret Instance binding

Keep this file outside the Company Workspace and Git:

```yaml
schema_version: 1
instance_id: example-staging
source_id: delivery-items
resource_binding: delivery-board
connector: oregano/monday-record-source
connector_version: 0.3.1
secret_ref: env:MONDAY_API_TOKEN
qualification:
  receipt_ref: ./monday-agent-qualification.json
  digest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
configuration:
  api_version: dev
  agent_id: "700001"
  board_id: "100001"
  permission: read
  group_ids:
    - ready_group
  page_size: 100
  max_pages: 100
  max_objects: 50000
```

Replace the fictional digest with the exact `discovery_hash` from the completed
qualification receipt. The relative receipt path resolves from the binding
file. The binding contains identifiers, a qualification pin, and
configuration, not secrets. Store the Agent token and `DATABASE_URL` only in
the selected Instance runtime secret store. The maintained Record Source
Connector performs read-only inventory even when the Agent has an explicitly
reviewed `read-write` grant for a separate work-item Capability. The Workbench
refuses credential-shaped binding fields and fails before secret resolution
when the receipt, digest, Agent, board, permission, active groups, mapped
columns, or `dev` API contract do not match. Unknown or additional Agent
resources also fail qualification rather than becoming implicit access.

`agent_id` is the configured UI/callback Agent ID from the confirmed identity
mapping. It is not the authenticated member ID or the external subject ID.

For a complete-table binding, omit `group_ids` and add:

```yaml
  inventory_mode: complete-table
```

A Slack conversation binding uses the same Instance-only contract:

```yaml
schema_version: 1
instance_id: example-staging
source_id: coordination-conversation
resource_binding: coordination-conversation
connector: oregano/slack-record-source
connector_version: 0.1.0
secret_ref: env:SLACK_BOT_TOKEN
qualification:
  receipt_ref: ./slack-source-qualification.json
  digest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
configuration:
  credential_provider: direct-env
  team_id: T00001
  channel_id: C00001
  conversation_kind: public-channel
  oldest_at: 2030-01-01T00:00:00.000Z
  include_threads: true
  page_size: 100
  max_pages: 100
  max_thread_pages: 20
  max_messages: 50000
```

On the maintained Vercel Runner, the existing Slack Vercel Connect
installation can supply the same app-scoped bot credential without exporting
or duplicating it. Keep the SecretRef shape, point it at the connector handle,
and select the Runner-specific credential provider:

```yaml
secret_ref: env:SLACK_CONNECTOR
configuration:
  credential_provider: vercel-connect-app
  team_id: T00001
  channel_id: C00001
  # remaining source bounds stay unchanged
```

`vercel-connect-app` is a deployment adapter, not a provider-neutral Records
contract. The Runner exchanges its trusted Vercel deployment identity for a
fresh app token at the provider boundary; the token is never written into the
Instance configuration, Artifact, Workspace, database, receipt, or logs.

`oldest_at` and optional `latest_at` are explicit collection boundaries.
Every pass reads one bounded complete inventory, including thread replies,
and fails closed on provider-limited history, pagination overflow, scope or
membership drift, rate limiting, or an incomplete unbounded thread inventory.
When `latest_at` selects a historical window, later live replies are outside
that inventory and do not make the selected window incomplete. The generic
source stores immutable normalized message versions and the raw provider
payload. A Domain may later derive a typed business record with exact source
lineage; this does not create a provider write or grant the derived record new
authority.

The default mode is `selected-items`. Use complete-table only after reviewing
the broader personal and business data scope, provider API quota, database
storage, retention, projection access, and rollback.

## 5. Inspect before any external call

```bash
companyos records source inspect \
  --workspace <company-workspace> \
  --source delivery-items

companyos records projection inspect \
  --workspace <company-workspace>
```

Resolve every error before continuing. Inspection is local and free of
provider and database effects.

Inspection also proves that every projection and selection path is
materialized by the exact Record Source or Sources the projection selects. A
projection cannot defer an unknown provider column until runtime; add the
reviewed source mapping first or remove the projection field.

## 6. Rehearse synchronization outside production

Use a dedicated test provider resource or explicitly safe read-only subset and
an isolated database branch. Explain that apply will read provider objects and
write immutable observations, current pointers, projection rows, a watermark,
and a receipt to that database. It will not write to the provider. Existing
provider API quotas and database compute or storage charges may apply.

When the maintained Vercel Runner is the only runtime that can resolve both an
Instance provider SecretRef and the isolated database binding, use its optional
`/api/records/rehearsal` operator endpoint. It is disabled unless all of these
conditions hold:

- `VERCEL_ENV` is exactly `preview`;
- `VERCEL_GIT_COMMIT_SHA` matches the exact clean Core ref in the compressed
  runtime configuration;
- `COMPANYOS_RECORDS_REHEARSAL_CONFIG_GZIP_BASE64` contains only reviewed
  declarations, non-secret bindings, qualification evidence, Workspace/Core
  refs, and source-confirmation hashes;
- `COMPANYOS_RECORDS_REHEARSAL_SECRET` matches the request bearer value; and
- the database and provider credentials are injected separately through
  Preview-only sensitive variables.

After the protected Preview, isolated database branch, and Preview-only
Sensitive bindings exist, replace ad hoc scripts with one resumable command:

```bash
companyos records source connect \
  --profile vercel-neon \
  --workspace <company-workspace> \
  --source delivery-items \
  --binding <staging-binding.yaml> \
  --runtime-scope <vercel-team> \
  --runtime-project <vercel-project> \
  --endpoint https://<protected-preview>/api/records/rehearsal \
  --state <outside-workspace-state-file> \
  --plan
```

Review the exact Core and Workspace commits, source and projection selection,
binding and qualification evidence, runtime target, costs, and effects. Use
`--apply <connect-hash>` to create only a mode-0600 credential-free local state.
Then run `--status` to see the required Preview variable names. Use
`--status --show-preview-configuration` only in the operator terminal to obtain
the compressed credential-free configuration for the corresponding Vercel
Sensitive value. Never copy it to chat or Git.

Inject the same short-lived `COMPANYOS_RECORDS_REHEARSAL_SECRET` into the one
local process and the protected Preview. The local Vercel CLI must already be
signed into an account that may access the exact deployment; the Workbench does
not log in or grant consent. A first `--resume` obtains the
independent migration and synchronization hashes without reading the provider
or writing the database. After reviewing both effects, continue with:

```bash
companyos records source connect \
  --state <state-file> \
  --resume \
  --migration-confirmation <migration-hash> \
  --sync-confirmation <sync-hash>
```

The command records migration before starting synchronization, so a timeout or
failed provider pass resumes without repeating an unrecorded effect. It calls
status only after apply and completes only when the isolated database proves an
available schema, a watermark, a successful zero-error receipt, and every
selected projection. It retains counts and receipts, never record payloads or
credentials. Remove only
`COMPANYOS_RECORDS_REHEARSAL_CONFIG_GZIP_BASE64` and
`COMPANYOS_RECORDS_REHEARSAL_SECRET` after evidence capture. Infrastructure,
the Instance provider SecretRef, `DATABASE_URL`, and production remain separate
accountable decisions.

The endpoint plans and applies migration and synchronization separately. It
also plans and applies external-Agent qualification separately when the
provider token cannot leave the protected runtime. That qualification reads
only the authenticated identity, account, selected-board metadata, and
effective access, and requires a later human identity-mapping confirmation. It
never enables reconciliation, schedules, webhooks, provider writes, or
production. Its status and apply responses contain metadata, counts, and
receipts, not record payloads. For a maintained Monday `complete-table` source, apply also
returns the active board and column identifiers, titles, and types as
`schema_coverage`, plus a stable schema digest. This is table metadata, never
row content, and lets the operator verify a child-board mapping. Status reports
row counts for the declared projections selected by that source. Remove the
short-lived configuration and rehearsal secret after evidence capture.
Creating the Preview deployment, database branch, and environment variables
remains an Instance change requiring its own review and does not follow from
this Guide automatically.

The synchronization worker uses fixed bounded concurrency after it has received
the complete inventory. A timeout or worker failure can therefore leave partial
immutable rows, but it cannot publish the source watermark or a successful
receipt. Inspect status before retrying. A missing watermark or receipt means
the pass is incomplete even when object and projection counts are non-zero. An
exact retry reuses the same immutable identities and repairs only a missing
materialization of the matching current version; it never promotes an older
replay over newer current state. The StateStore performs that version check and
projection mutation atomically, including while webhooks arrive. Do not delete
partial evidence before retrying.

```bash
companyos records source sync \
  --workspace <company-workspace> \
  --source delivery-items \
  --binding <staging-binding.yaml> \
  --plan
```

The plan resolves no secret and makes no external call. Review its exact Core,
Workspace digests, Instance, Connector, provider resource, SecretRefs, and
database effect. Inject both secrets into the process through the runtime host
and use `--apply <hash>` only after explicit confirmation.

Run payload-free status:

```bash
companyos records source status \
  --workspace <company-workspace> \
  --source delivery-items \
  --binding <staging-binding.yaml>
```

Verify the apply output's payload-free provider request evidence and
`credentials_retained: false`, then verify expected status counts, current
objects, versions, watermark time, and last receipt. Query the projection only
through an authorized test principal and the
`records.query` Tool; Agents do not receive direct database access.

## 7. Reconcile deliberately

Synchronization never interprets a missing item as deletion. Reconciliation
does, but only after one complete bounded provider inventory under the durable
lease:

```bash
companyos records source reconcile \
  --workspace <company-workspace> \
  --source delivery-items \
  --binding <staging-binding.yaml> \
  --plan
```

Review the possible provider-absence tombstone effect and confirm the exact
hash before apply. A tombstone preserves observed evidence; it does not delete
provider data or silently purge retained database history. Core processes
independent objects with the same fixed bounded concurrency used for initial
synchronization. A runtime interruption publishes no watermark or successful
receipt; an exact retry deduplicates prior events and repairs only the immutable
version that is still current. The current-version check and projection change
are atomic, so a concurrent provider event cannot be overwritten or removed.

## 8. Activate production separately

Do not reuse staging approval for production. Before the first production
apply, review:

- exact Core, Workspace, Connector, binding and database environment;
- the provider account, board, groups, fields, scopes and rate limits;
- database region, retention, backup, compute, storage and billing;
- data classification, access groups and freshness target;
- non-production counts, reconciliation behavior and rollback evidence;
- schedule ownership, alerting and revocation procedure.

Production synchronization, schedule activation, webhook activation, provider
writes, Agent provisioning, and Workspace proposal publication are separate
changes. This Guide authorizes none of them automatically.

For the maintained Vercel Runner, production uses neither the Preview endpoint
nor its configuration or bearer. Prepare these separate protected production
values without placing their values in chat, Git, a Workspace, or a command
argument:

- `COMPANYOS_RECORDS_CONFIG_GZIP_BASE64`: reviewed credential-free production
  declarations, qualifications, bindings, exact refs, and local-time schedules;
- `COMPANYOS_RECORDS_ADMIN_SECRET`: operator authentication for explicit
  plan/apply and status requests;
- `COMPANYOS_RECORDS_ENABLED`: the operator mutation kill switch;
- `COMPANYOS_RECORDS_SCHEDULER_ENABLED`: the independent recurring-work switch;
- `CRON_SECRET`, `DATABASE_URL`, and every provider SecretRef value: independent
  Instance-owned secrets.

Deploy with both kill switches off. Confirm that the deployment is production
and that its Artifact Instance, Core commit, and Workspace commit match the
reviewed plan. Use `POST /api/records/operations` to obtain the production
migration plan; review and confirm that hash before apply. The additive database
manifest becomes `1.9.0` and includes the current `companyos_records` Record
Source and Sprint relations; it preserves the
existing control, knowledge, and records data. Next obtain and independently
confirm one `plan-sync` for each source. Initial synchronization reads the exact
qualified provider resource and writes immutable production observations,
projections, watermark, and receipt without inferring deletion or modifying the
provider. An already completed confirmation reuses its receipt.

Review payload-free status and projection counts before enabling the scheduler.
`GET /api/records/reconcile` is authenticated only by `CRON_SECRET`. Vercel wakes
it every 15 minutes, while Core selects due allowlisted sources from their IANA
time zone, local time, weekdays, and bounded lateness window. One stable local
service-day receipt prevents repeat provider reads. A failed due run may retry
inside the window; a complete successful run may record retained tombstones for
objects absent from the complete provider inventory. Disable the scheduler
switch first for rollback, then disable the records switch if all production
records effects must stop. Do not delete schemas or evidence during rollback.

Conversational provider callbacks are not board-change subscriptions. Activate
a webhook or hybrid event path only after that exact provider mode separately
proves signed board-event delivery, resource identity, replay protection, and
the same records reconciliation boundary. Until then, scheduled reconciliation
is the production freshness path.

## 9. Add another provider

Do not copy this command into `companyos notion sync` or
`companyos clickup sync`. A maintained provider contribution implements the
generic Record Source Connector contract, validates its own non-secret
configuration, proves bounded complete inventory and minimum read permission,
emits payload-free evidence, passes synthetic conformance tests, and documents
its qualification and costs. The shared `companyos records` lifecycle remains
unchanged.
