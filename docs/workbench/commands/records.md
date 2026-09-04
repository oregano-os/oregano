---
document_id: command.records
title: companyos records
kind: command
status: implemented
authority: canonical
language: en
updated: 2026-09-04
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
relations:
  depends_on:
    - architecture.company-instance
    - specification.company-records-sprint-v0.1
---

# `companyos records`

`companyos records` is the provider-neutral Workbench surface for structured
operational Company Records. It does not operate Company Knowledge, grant an
Agent a Tool, write to a provider, infer a company mapping, activate a
schedule, commit a Workspace file, or turn synchronized evidence into company
authority.

## Local inspection

```bash
companyos records source inspect \
  --workspace <company-workspace> \
  [--source <source-id>]

companyos records projection inspect \
  --workspace <company-workspace> \
  [--projection <projection-id>]
```

Inspection validates source and projection schemas, duplicate identities,
connection and schedule references, Sprint projection references, safe
materialization targets, and the selected identity. It performs no provider or
database call.

## Qualification

The maintained Record Source Connectors are Monday for board objects and Slack
for allowlisted conversations. Monday uses the same external Agent identity as
the maintained Monday callback ingress:

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

Use the returned hash with `--apply`, then use `--resume` and `--status` with
the same `--provider monday` and state path. The Workbench resolves
`env:MONDAY_API_TOKEN` only after the confirmed hash, requires a real external
Agent token, verifies the exact Agent ID and complete resource-grant set, reads
only selected board metadata with Monday's required `API-Version: dev`, retains
no credential, and does not synchronize an item or change a provider grant.

When the Instance marks that token as non-exportable and only a protected
Vercel Preview can resolve it, add the existing `vercel-neon` runtime profile
to the same qualification plan:

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

After the initial qualification hash is confirmed, the first remote `--resume`
only obtains an exact provider-metadata-read plan. It performs no Monday call.
Resume again with `--provider-read-confirmation <hash>` to perform that one
read inside the protected Preview, then review the returned identity tuple and
finish with `--identity-confirmation <hash>`. The Preview response and local
mode-0600 state contain no credential or item payload. The local process needs
only the matching short-lived rehearsal bearer; the Monday token never leaves
the hosting runtime.

## Reviewed materialization

Author the complete non-secret source declaration outside the target path. The
Workbench does not invent any value. Preview its exact qualified diff:

```bash
companyos records source materialize \
  --provider monday \
  --workspace <company-workspace> \
  --qualification <completed-state-file> \
  --board <qualified-board-id> \
  --declaration <explicit-source-draft.yaml> \
  --output <company-workspace>/records/sources/<name>.yaml \
  --plan
```

After reviewing every mapping and the confirmation hash:

```bash
companyos records source materialize <same-options> --apply <hash>
```

Apply creates exactly one new YAML file and refuses overwrite. It makes no
provider, database, Git, schedule, deployment, or activation change.

## Synchronization and reconciliation

Both operations require an Instance binding outside the Company Workspace and
an exact clean Core identity:

```bash
companyos records source sync \
  --workspace <company-workspace> \
  --source <source-id> \
  --binding <outside-workspace-instance-binding.yaml> \
  --plan

companyos records source reconcile \
  --workspace <company-workspace> \
  --source <source-id> \
  --binding <outside-workspace-instance-binding.yaml> \
  --plan
```

The plan resolves no SecretRef and calls neither provider nor database. It
binds the exact Core identity, source and projection digests, binding digest,
Connector version, Instance, resource, SecretRefs, provider read, and database
effect. Apply requires its exact hash:

```bash
companyos records source sync <same-options> --apply <hash>
companyos records source reconcile <same-options> --apply <hash>
```

`sync` reads one complete provider inventory and appends immutable observations
and rebuildable projections. It does not interpret a missing provider object
as deletion. `reconcile` performs the same bounded complete read under a
durable lease and may then record provider absence as a retained tombstone.
Both are idempotent, advance the watermark only after success, store a durable
receipt, write only the existing Company Instance database, and perform no
provider write.

### Hosted Preview rehearsal

The maintained Vercel Runner exposes an optional authenticated
`POST /api/records/rehearsal` operator endpoint for an isolated Preview when a
local process cannot resolve the Instance secrets. Supported request actions
are `plan-monday-qualification`, `apply-monday-qualification`,
`plan-slack-qualification`, `apply-slack-qualification`,
`plan-migration`, `apply-migration`, `plan-sync`, `apply-sync`, and `status`.
Monday qualification, migration, and synchronization have independent
confirmation hashes. Monday qualification reads only the authenticated external-Agent
identity plus metadata and effective access for the exact selected boards; it
does not read items or modify Monday.

Slack qualification selects one confirmed `communication-message` source and
its Instance binding. Planning performs no provider call. Apply resolves only
the binding's SecretRef and calls Slack identity and conversation-metadata
methods to prove the exact team, channel, public/private kind, membership, and
read scopes. It does not read message history, write to Slack, or retain the
credential. Put the returned content-free receipt outside the Workspace, pin
its digest in the binding, and then use the same generic sync, reconcile, and
status operations as every other Record Source.

Preview migration prepares and qualifies the complete additive Company Instance
database manifest before synchronization. This includes the control, knowledge,
and records schemas required by the deployed Core; it preserves existing data
and returns the database preparation receipt.

The endpoint fails closed outside `VERCEL_ENV=preview`, when the deployed Git
commit differs from the configured exact Core ref, or when its short-lived
bearer secret is missing. Its compressed runtime configuration contains no
credential and is separate from `DATABASE_URL`, provider SecretRefs, and
`COMPANYOS_RECORDS_REHEARSAL_SECRET`. The endpoint does not support
reconciliation, schedules, webhooks, provider writes, or production. Delete
the Preview-only configuration and bearer secret after rehearsal. A maintained
Monday `complete-table` apply response includes payload-free board/column
schema coverage and its digest; `status` includes row counts for the exact
declared projections selected by the source.

Use the high-level resumable operator command instead of temporary scripts:

```bash
companyos records source connect \
  --profile vercel-neon \
  --workspace <company-workspace> \
  --source <source-id> \
  --binding <outside-workspace-instance-binding.yaml> \
  --runtime-scope <vercel-team> \
  --runtime-project <vercel-project> \
  --endpoint https://<protected-preview>/api/records/rehearsal \
  --state <outside-workspace-state-file> \
  --plan

companyos records source connect <same-options> --apply <connect-hash>
companyos records source connect --state <state-file> --status
companyos records source connect --state <state-file> --status \
  --show-preview-configuration
companyos records source connect --state <state-file> --resume
companyos records source connect --state <state-file> --resume \
  --migration-confirmation <migration-hash> \
  --sync-confirmation <sync-hash>
```

Plan and initialization make no external call. `--status` lists the required
Preview-only Sensitive names; `--show-preview-configuration` emits the
credential-free compressed configuration only on explicit request for entry in
the operator's Vercel UI. It is company metadata and still must not enter chat
or Git. The matching short-lived `COMPANYOS_RECORDS_REHEARSAL_SECRET` is
injected into the one local resume process and is sent to `vercel curl` through
standard input, not an argument or state field.
Resume uses the locally signed-in Vercel CLI session only to reach the exact
protected deployment. It does not sign in, grant consent, or change the linked
project; missing account or team access fails visibly.

The first resume obtains migration and synchronization plans only. The second
resume requires both exact hashes, records migration before synchronization so
an interruption is resumable, and then requires payload-free status proving a
watermark, zero-error receipt, and all selected projections. It does not create
the Preview, database branch, or Sensitive values; remove only the two
Workbench-owned rehearsal values afterwards. Production is always a separate
plan.

### Hosted production runtime

The maintained Vercel Runner exposes production Company Records through two
surfaces that are never shared with Preview:

- `POST /api/records/operations` uses the Instance-owned
  `COMPANYOS_RECORDS_ADMIN_SECRET` and supports `plan-migration`,
  `apply-migration`, `plan-sync`, `apply-sync`, `plan-reconcile`,
  `apply-reconcile`, and `status`;
- `GET /api/records/reconcile` accepts only the hosting scheduler bearer in
  `CRON_SECRET` and runs due configured reconciliation.

`COMPANYOS_RECORDS_CONFIG_GZIP_BASE64` contains only reviewed declarations,
qualification evidence, non-secret bindings, exact identities, local-time
schedule declarations, and SecretRefs. Credentials remain separate protected
production variables. Every request requires `VERCEL_ENV=production`, the
exact deployed Core commit, and the matching production Artifact Instance,
Core, and Workspace refs. `COMPANYOS_RECORDS_ENABLED=true` enables confirmed
operator effects; `COMPANYOS_RECORDS_SCHEDULER_ENABLED=true` separately enables
recurring reconciliation. Either can be turned off without deleting evidence.

The Runner wakes the scheduler every 15 minutes, but Core—not Vercel—decides
whether a source is due from its configured IANA time zone, local time,
weekdays, retry window, and exact service-day receipt. An already completed
confirmation or service day returns the prior outcome without another provider
read. Production responses contain counts and receipts, never record payloads
or credentials. These endpoints do not modify the provider or send messages.
Production configuration and apply remain an explicit Company Instance rollout
decision; this command reference grants no such approval.

## Payload-free status

```bash
companyos records source status \
  --workspace <company-workspace> \
  --source <source-id> \
  --binding <outside-workspace-instance-binding.yaml>
```

Status reads the existing database only. It reports schema availability,
event, current-object and version counts, watermark time, and the latest sync
or reconciliation summary. It returns no record payload and does not create a
missing schema.

## Secrets and production

The binding must also pin its non-secret external-Agent qualification receipt
and digest. It may contain only a `secret_ref`, never a credential. The
maintained commands accept `env:NAME` references and resolve them only after a
valid apply hash. `MONDAY_API_TOKEN` is the existing external Agent token;
`DATABASE_URL` is resolved independently from the process environment. Inject
both through the selected runtime host's protected secret mechanism; never put
a value in chat, Git, a Workspace file, a binding, a plan, or a command
argument.

Provider API calls and database storage or compute may count against the
company's existing provider plans. The Workbench does not purchase or upgrade
a plan and cannot determine the account's commercial terms. The accountable
human reviews rate limits, billing, environment, and production scope before
confirming apply. A production run remains a separate Instance decision after
non-production rehearsal.
