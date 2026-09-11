---
document_id: guide.retire-knowledge
title: Retire Knowledge from an existing Instance
kind: guide
status: implemented
authority: canonical
language: en
updated: 2026-09-11
owners:
  - oregano-maintainers
audience:
  - human
  - agent
---

# Retire Knowledge from an existing Instance

In Core 0.12.0 and Workbench 0.1.0-experimental.22, the entire
Brain/Knowledge subsystem, including Handbook search, has been
removed. Handbook source files and the structured roster remain in the
Workspace. The current database manifest is `companyos-postgres@3.0.0` and
qualifies 15 control/Workflow tables and 14 Records/Sprint tables with receipt version
`2`. Historical `1.0.0` through `2.0.0` identities remain recognizable for
upgrade; their schema constructors are not retained.

## Repository and Workspace transition

Remove `oregano:knowledge/*` grants and retired Knowledge-only bindings.
Preserve Granola provider configuration, its Workspace declaration and secrets
for later use as described in [Preserve Granola](retain-granola.md). Do not
convert them into broad file scopes. Inspect each Agent's existing `scope.read`
and review articles with old visibility/allowed-principal/allowed-group
metadata before including them as ordinary materials. Preserve article bodies,
roster identities, general groups, approval authority and protected Git paths.
Retire Brain inbox/archive data separately from Handbook content; never delete
provider originals as part of this migration.

Build a fresh Artifact from the new exact Core and reviewed Workspace pair.
It contains no Knowledge bundle, search capability or Knowledge model override.
Test the replacement runtime before changing a live Instance.

## Explicit database retirement

The target is the `companyos_knowledge` schema, not the shared database or Neon
project. `companyos` and `companyos_records` must remain. Ordinary preparation
and health neither create nor delete the retired schema; a transitional
Instance can run the new Core before its old data is explicitly removed.

1. Identify the exact Instance, database/branch and old writers. Decide whether
   a temporary recovery copy is needed and record its retention separately.
2. Stop or replace old source webhooks, schedules, workers and deployments so
   they cannot continue writing or recreate the schema.
3. Run `companyos database prepare`, then `companyos database verify` through
   the existing secret transport. Requalify old setup receipts against the new
   manifest instead of relabeling them.
4. With that same exact `DATABASE_URL` bound only in process memory, inspect:

   ```sh
   node scripts/retire-knowledge.mjs --preview
   ```

5. Verify the displayed host, database and schema. Once writers are stopped,
   execute the exact target-bound operation:

   ```sh
   node scripts/retire-knowledge.mjs --confirm <preview-hash> --writers-stopped
   ```

The migration drops the retired tables together with `RESTRICT`, then drops
the schema with `RESTRICT`, all in one atomic statement. Cross-schema foreign
keys, dependent views, or unexpected remaining objects abort the operation
and roll back all table removal. Inspect and resolve those dependencies; do
not replace the operation with a broad cascade. The operation is repeatable
when the schema is already absent. It does not remove shared extensions.

6. Confirm the retirement receipt and schema absence. Re-run health, setup
   verification and the retained business checks. Retire dedicated raw-asset
   storage only after checking ownership. Preserve Granola API and webhook
   credentials, its provider installation and retained configuration. Keep shared
   `DATABASE_URL`, `CRON_SECRET` and model/provider credentials that other
   components use.

An old runtime must not be redeployed against the retired database. After
schema deletion, application rollback alone cannot restore removed data; any
rollback requires the corresponding recovery copy and exact old pairing.

## Verification scope

The local regression suite uses an explicitly supplied isolated PostgreSQL
server to exercise fresh initialization, historical upgrade, repeated
retirement, preservation of Core/Records rows, and rollback on cross-schema
foreign-key/view dependencies or unexpected schema functions. A successful
local test does not claim that any live Company Instance has been migrated.
This incompatible change requires a minor Core release before 1.0; publication
and production rollout require their normal exact-target decisions.
