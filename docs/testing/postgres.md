---
document_id: testing.postgres
title: Isolated PostgreSQL Integration Tests
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-09-06
owners: [oregano-maintainers]
audience: [human, agent]
---

# Isolated PostgreSQL integration tests

Every PR and release runs `pnpm test:database` against a fresh PostgreSQL 15.18
service with a dedicated `companyos_test` database and user. No repository
database secret is required. The command refuses remote database hosts,
Company Instance names, missing configuration, disabled database tests,
failed tests, or any skipped test in the required integration suites.

For a local disposable PostgreSQL service listening on loopback:

```sh
COMPANYOS_TEST_DATABASE_URL=postgresql://companyos_test:local-test-only@127.0.0.1:5432/companyos_test pnpm test:database
```

Provision the isolated database/user before running the command; do not use
an existing Company Instance database. The fixed password above is only the
ephemeral CI service credential. A local trust-authenticated cluster may omit
it. The runner never reads `.env.local` or adopts `DATABASE_URL` as a fallback.

The production stores use the installed `@neondatabase/serverless` HTTP
driver unchanged. A short-lived loopback test bridge accepts that driver's
query and transaction envelopes, executes SQL on PostgreSQL, and returns raw
typed rows for the driver to decode. It cannot change its target database
from an incoming request. The bridge preserves transactions, concurrency,
unique constraints, SQLSTATE errors, JSONB and arrays. A transport conformance
test verifies typed results and rollback after a failed transaction.

Required coverage includes approval consumption with competing clicks,
atomic effect claims, persisted effect receipts, unknown-outcome redispatch
refusal, timer leases and recovery, canonical JSONB identity, additive schema
bootstrap, and Brain persistence/identity. The ordinary unit suite may skip
database cases without a local database; it cannot satisfy this separate gate.

This is real database and store evidence, not a hosted Neon qualification or
workflow-engine acceptance. The deployed Instance still needs its exact
database profile qualification, Workflow acceptance, and human decisions.

The required suite also runs generic workflow persistence against the actual
Neon HTTP driver and Postgres. It verifies pinned Artifact reconstruction,
canonical opening redelivery, competing and expired leases, atomic assignment
conflict rollback, private conversation identity, cancellation fencing and an
actual Runtime invocation cancelled after its effect claim but before provider
dispatch. These are state/Runtime boundary tests; full workflow interpreter and
hosted human acceptance are separate gates. Synthetic test clocks and state
positioning do not count as real human approval or an elapsed pilot period.
