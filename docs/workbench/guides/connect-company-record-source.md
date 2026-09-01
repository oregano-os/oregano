---
document_id: guide.connect-company-record-source
title: Connect a Company Record Source
kind: guide
status: implemented
authority: canonical
language: en
updated: 2026-09-01
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
    - command.monday-qualify
    - guide.connect-knowledge-source
---

# Connect a Company Record Source

Use this Guide when a company wants to mirror structured operational objects
from a business provider into the existing Company Instance database so
multiple authorized Agents and Workflows can use fresh, consistent,
provider-neutral projections.

Company Records and Company Knowledge are different. Company Records mirrors
structured objects such as work items, roles, people assignments, statuses,
dates, and effort. Company Knowledge ingests documents and evidence for cited
retrieval and review. Neither database projection becomes Handbook authority,
provider authority, or an authorization roster.

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

The maintained provider in this release is Monday. A future Notion, ClickUp,
or other adapter must preserve this lifecycle behind the same Record Source
Connector contract; it does not get a parallel synchronization command.

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

## 2. Qualify the provider without retaining a human credential

For Monday, register one OAuth 2.1 app version with the exact loopback redirect
and only `boards:read` and `me:read`. Explain before consent that the browser
authorization creates a read-only app authorization and may route an
administrator through provider installation. It does not create or modify a
board, item, Agent, webhook, or permission.

Plan with the explicit target boards:

```bash
companyos records source qualify \
  --provider monday \
  --workspace <company-workspace> \
  --client-id <non-secret-client-id> \
  --app-version-id <exact-app-version-id> \
  --redirect-uri http://127.0.0.1:43127/callback \
  --board <test-board-id> \
  --state <outside-workspace-state-file> \
  --plan
```

Review and confirm the hash, inject `MONDAY_OAUTH_CLIENT_SECRET` through the
runtime host's Sensitive secret surface, then apply and resume. Never paste the
secret into chat, Git, the command, or the state file. The completed state file
contains non-secret actor, account, scope, board, group, column, API, request,
and digest evidence. It contains no items, column values, access token, refresh
token, authorization code, verifier, or client secret.

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
    source: columns.people_col
    value_type: identity
access:
  read_groups:
    - delivery
  write_roles: []
```

Monday inventory exposes the stable item fields `id`, `name`, `updated_at`,
`board_id`, and `group_id`; parsed provider values under
`columns.<column-id>`; and display text under
`column_text.<column-id>`. Choose the representation deliberately. The
Workbench verifies that every named column exists on the qualified board but
does not infer what it means.

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

## 4. Create the non-secret Instance binding

Keep this file outside the Company Workspace and Git:

```yaml
schema_version: 1
instance_id: example-staging
source_id: delivery-items
resource_binding: delivery-board
connector: oregano/monday-record-source
connector_version: 0.1.0
secret_ref: env:MONDAY_RECORDS_TOKEN
qualification:
  receipt_ref: ./monday-read-qualification.json
  digest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
configuration:
  api_version: "2026-07"
  board_id: "100001"
  group_ids:
    - ready_group
  page_size: 100
  max_pages: 100
```

Replace the fictional digest with the exact `discovery_hash` from the completed
qualification receipt. The relative receipt path resolves from the binding
file. The binding contains identifiers, a qualification pin, and
configuration, not secrets. Install the provider credential and `DATABASE_URL`
only in the selected Instance runtime secret store. The maintained Connector
uses the provider token only for read-only inventory. The Workbench refuses
credential-shaped binding fields and fails before secret resolution when the
receipt, digest, board, active groups, mapped columns, or exact read-only scopes
do not match.

The human OAuth token from qualification is deliberately discarded and is not
the production synchronization credential. The accountable administrator must
separately create or select the least-privileged Instance credential, explain
its scopes and provider cost, and store it in the protected secret surface.

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

## 6. Rehearse synchronization outside production

Use a dedicated test provider resource or explicitly safe read-only subset and
an isolated database branch. Explain that apply will read provider objects and
write immutable observations, current pointers, projection rows, a watermark,
and a receipt to that database. It will not write to the provider. Existing
provider API quotas and database compute or storage charges may apply.

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
provider data or silently purge retained database history.

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

## 9. Add another provider

Do not copy this command into `companyos notion sync` or
`companyos clickup sync`. A maintained provider contribution implements the
generic Record Source Connector contract, validates its own non-secret
configuration, proves bounded complete inventory and minimum read permission,
emits payload-free evidence, passes synthetic conformance tests, and documents
its qualification and costs. The shared `companyos records` lifecycle remains
unchanged.
