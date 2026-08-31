import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { CompanyRecordProjectionDeclaration, CompanyRecordSourceDeclaration } from "../../records/contracts.ts";
import { recordDigest } from "../../records/identity.ts";
import { InMemoryCompanyRecordsStore } from "../../records/memory-store.ts";
import { CompanyRecordsRegistry } from "../../records/registry.ts";
import { reconcileRecordSnapshot } from "../../records/reconciliation.ts";
import { CompanyRecordsService, RecordAccessDeniedError } from "../../records/service.ts";

const source: CompanyRecordSourceDeclaration = {
  schema_version: 1,
  id: "fixture-items",
  record_type: "work-item",
  connection: "connections/board.md",
  resource_binding: "primary-board",
  delivery: "hybrid",
  identity: { source_field: "id" },
  fields: [
    { target: "title", source: "name", value_type: "string", required: true },
    { target: "status", source: "columns.status", value_type: "status" },
  ],
  access: { read_groups: ["delivery"], write_roles: ["process-owner"] },
};

const projection: CompanyRecordProjectionDeclaration = {
  schema_version: 1,
  id: "active-items",
  record_type: "work-item",
  selection: { status: "active" },
  fields: [{ name: "title", path: "title" }, { name: "status", path: "status" }],
  freshness: { max_age_minutes: 60 },
  access: { read_groups: ["delivery"] },
  materialization: { mode: "database-view" },
};

const fixture = () => {
  const registry = new CompanyRecordsRegistry();
  registry.registerSource(source);
  registry.registerProjection(projection);
  const store = new InMemoryCompanyRecordsStore();
  const service = new CompanyRecordsService({
    instanceId: "fixture-instance",
    registry,
    store,
    now: () => new Date("2030-02-01T10:00:00.000Z"),
  });
  return { registry, store, service };
};

test("Company Records normalization is deterministic and source events are idempotent", async () => {
  assert.equal(recordDigest({ b: 2, a: 1 }), recordDigest({ a: 1, b: 2 }));
  const { service, store } = fixture();
  const input = {
    event: {
      source_id: source.id,
      event_id: "event-1",
      object_id: "item-1",
      kind: "updated" as const,
      observed_at: "2030-02-01T09:59:00.000Z",
      cursor: "cursor-1",
      receipt: { delivery: "fixture" },
    },
    raw: { id: "item-1", name: "Prepare brief", columns: { status: "active" } },
  };
  const first = await service.ingest(input);
  const duplicate = await service.ingest(input);
  assert.equal(first.duplicate, false);
  assert.equal(first.projected[0], projection.id);
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.sourceEvents.size, 1);
  assert.equal(store.objectVersions.size, 1);
  assert.equal(store.projectionRows.size, 1);
  assert.equal(await store.getWatermark("fixture-instance", source.id), "cursor-1");
});

test("Company Records queries enforce projection groups and return freshness evidence", async () => {
  const { service, store } = fixture();
  await service.ingest({
    event: { source_id: source.id, event_id: "event-1", object_id: "item-1", kind: "created", observed_at: "2030-02-01T09:59:00.000Z", receipt: {} },
    raw: { id: "item-1", name: "Prepare brief", columns: { status: "active" } },
  });
  const allowed = await service.query({
    query: { projection_id: projection.id, filters: { status: "active" } },
    subject: { principal_id: "human:member-1", status: "active", roles: [], group_ids: ["delivery"] },
  });
  assert.equal(allowed.rows.length, 1);
  assert.equal(allowed.rows[0].values.title, "Prepare brief");
  assert.equal(allowed.fresh_until, "2030-02-01T11:00:00.000Z");
  await assert.rejects(() => service.query({
    query: { projection_id: projection.id },
    subject: { principal_id: "human:member-2", status: "active", roles: [], group_ids: ["other"] },
  }), RecordAccessDeniedError);
  assert.deepEqual(store.accessDecisions.map((decision) => decision.allowed), [true, false]);
});

test("deleted or unselected records are removed from rebuildable projections", async () => {
  const { service, store } = fixture();
  await service.ingest({
    event: { source_id: source.id, event_id: "event-1", object_id: "item-1", kind: "created", observed_at: "2030-02-01T09:00:00.000Z", receipt: {} },
    raw: { id: "item-1", name: "Prepare brief", columns: { status: "active" } },
  });
  await service.ingest({
    event: { source_id: source.id, event_id: "event-2", object_id: "item-1", kind: "updated", observed_at: "2030-02-01T09:30:00.000Z", receipt: {} },
    raw: { id: "item-1", name: "Prepare brief", columns: { status: "closed" } },
  });
  assert.equal(store.objectVersions.size, 2);
  assert.equal(store.projectionRows.size, 0);
});

test("complete snapshots reconcile provider deletion under a durable lease", async () => {
  const { registry, store } = fixture();
  const common = {
    instanceId: "fixture-instance",
    sourceId: source.id,
    leaseOwner: "worker-1",
    leaseExpiresAt: "2030-02-01T10:05:00.000Z",
    registry,
    store,
  };
  await reconcileRecordSnapshot({
    ...common,
    runId: "run-1",
    leaseToken: "lease-1",
    observedAt: "2030-02-01T10:00:00.000Z",
    objects: [
      { id: "item-1", name: "First", columns: { status: "active" } },
      { id: "item-2", name: "Second", columns: { status: "active" } },
    ],
    watermark: "page-1",
  });
  const second = await reconcileRecordSnapshot({
    ...common,
    runId: "run-2",
    leaseToken: "lease-2",
    observedAt: "2030-02-01T10:10:00.000Z",
    leaseExpiresAt: "2030-02-01T10:15:00.000Z",
    objects: [{ id: "item-1", name: "First", columns: { status: "active" } }],
    watermark: "page-2",
  });
  assert.equal(second.missing_from_provider, 1);
  assert.equal((await store.getCurrentObjectVersion("fixture-instance", source.id, "item-2"))?.deleted, true);
  assert.equal(store.projectionRows.size, 1);
  assert.equal(store.syncLeases.size, 0);
  assert.equal(store.syncReceipts.length, 2);
  assert.equal(await store.getWatermark("fixture-instance", source.id), "page-2");
});

test("synchronization leases fail closed for an active owner", async () => {
  const { store } = fixture();
  assert.equal(await store.claimSyncLease({ instanceId: "fixture-instance", sourceId: source.id, owner: "worker-1", token: "lease-1", now: "2030-02-01T10:00:00.000Z", expiresAt: "2030-02-01T10:05:00.000Z" }), true);
  assert.equal(await store.claimSyncLease({ instanceId: "fixture-instance", sourceId: source.id, owner: "worker-2", token: "lease-2", now: "2030-02-01T10:01:00.000Z", expiresAt: "2030-02-01T10:06:00.000Z" }), false);
  assert.equal(await store.releaseSyncLease({ instanceId: "fixture-instance", sourceId: source.id, token: "wrong" }), false);
  assert.equal(await store.releaseSyncLease({ instanceId: "fixture-instance", sourceId: source.id, token: "lease-1" }), true);
});

test("the additive records schema contains durable deduplication, projection, access, and reconciliation tables", () => {
  const sql = readFileSync(new URL("../../state-postgres/records-schema.sql", import.meta.url), "utf8");
  for (const table of ["source_events", "object_versions", "current_objects", "projection_rows", "access_decisions", "sync_receipts", "source_watermarks", "sync_leases", "durable_timers"]) {
    assert.match(sql, new RegExp(`create table if not exists companyos_records\\.${table}`));
  }
  assert.match(sql, /primary key \(instance_id, source_id, event_id\)/);
  assert.match(sql, /primary key \(instance_id, projection_id, record_id\)/);
  assert.doesNotMatch(sql, /api[_-]?key|password|database_url/i);
});
