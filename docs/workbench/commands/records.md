---
document_id: command.records
title: companyos records
kind: command
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

The first maintained Record Source Connector is Monday. It uses the same
external Agent identity as the maintained Monday callback ingress:

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
are `plan-migration`, `apply-migration`, `plan-sync`, `apply-sync`, and
`status`. Migration and synchronization have independent confirmation hashes.

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
