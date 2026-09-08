import { canonicalRecordInstant } from "../../records/instant.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateJsonSchemaValue } from "../../capabilities/validation.ts";
import { CORE_CAPABILITY_CATALOG } from "../../capabilities/catalog.ts";
import type { CompanyRecordProjectionDeclaration, CompanyRecordSourceDeclaration, RecordAccessSubject } from "../../records/contracts.ts";
import { InMemoryCompanyRecordsStore } from "../../records/memory-store.ts";
import { CompanyRecordsRegistry } from "../../records/registry.ts";
import { CompanyRecordsService } from "../../records/service.ts";
import { drainRecordPages, MAX_RECORD_QUERY_ROWS } from "../../records/query.ts";
import { RECORD_QUERY_OUTPUT_SCHEMA } from "../../records/query-schema.ts";
import { synchronizeRecordSnapshot } from "../../records/synchronization.ts";
import { STANDARD_RECORDS_TOOLS } from "../../standard-tools/records.ts";
import { STANDARD_COMMUNICATION_TOOLS } from "../../standard-tools/communication.ts";

const instant = "2031-01-03T17:00:00.000Z";
const source: CompanyRecordSourceDeclaration = {
  schema_version: 1, id: "fixture-items", record_type: "fixture-item", connection: "connections/board.md", resource_binding: "test-board",
  delivery: "poll", identity: { source_field: "id" }, access: { read_groups: ["team"], write_roles: [] },
  fields: ["item_id", "status", "changed_at", "fields"].map((name) => ({ target: name, source: name, value_type: "json" as const, required: true })),
};
const projection: CompanyRecordProjectionDeclaration = {
  schema_version: 1, id: "fixture-view", record_type: source.record_type, source_ids: [source.id],
  fields: source.fields.map((field) => ({ name: field.target, path: field.target })),
  filters: {
    ids: { operator: "in", path: "item_id" }, status_in: { operator: "in", path: "status" },
    changed_since: { operator: "after", path: "changed_at" },
    missing_any_of: { operator: "missing-any", path: "fields", fields: ["summary", "effort"] },
  },
  freshness: { max_age_minutes: 60 }, access: { read_groups: ["team"] }, materialization: { mode: "database-view" },
};
const subject: RecordAccessSubject = { principal_id: "reader", status: "active", roles: [], group_ids: ["team"] };
const fixture = async (size = 3) => {
  const registry = new CompanyRecordsRegistry(); registry.registerSource(source); registry.registerProjection(projection);
  const store = new InMemoryCompanyRecordsStore();
  const service = new CompanyRecordsService({ instanceId: "test-instance", registry, store, now: () => new Date(instant) });
  const objects = Array.from({ length: size }, (_, index) => ({ id: `item-${index}`, item_id: `item-${index}`,
    status: index % 2 ? "complete" : "open", changed_at: instant, fields: { summary: index % 2 ? "" : "Prepared", effort: 0 } }));
  const sync = (through?: string, runId = "sync-1") => synchronizeRecordSnapshot({
    instanceId: "test-instance", source, registry, store, runId, leaseOwner: "worker", leaseToken: runId,
    leaseExpiresAt: "2031-01-03T18:00:00Z", inventory: { complete: true, observed_at: instant, objects,
      watermark: runId, receipt: {}, ...(through ? { synced_through: through } : {}) },
  });
  await sync();
  return { registry, store, service, sync };
};

test("standard Tools expose the actual Capability schemas, including typed message receipts", () => {
  assert.deepEqual(STANDARD_RECORDS_TOOLS[0]!.contract.outputSchema, CORE_CAPABILITY_CATALOG.find((value) => value.id === "records.query")!.outputSchema);
  const message = STANDARD_COMMUNICATION_TOOLS[0]!.contract.outputSchema;
  assert.ok(validateJsonSchemaValue(message, { message_id: "message-1" }).length > 0);
  assert.deepEqual(validateJsonSchemaValue(message, { message_id: "message-1", destination_binding: "test-channel", published_at: instant, thread_reference: "thread-1" }), []);
});

test("all_pages reads beyond one page and declared filters have generic semantics", async () => {
  const { service } = await fixture(205);
  const query = (filters = {}) => service.query({ query: { projection_id: projection.id, all_pages: true, limit: 7, filters }, subject });
  const all = await query(); assert.equal(all.rows.length, 205); assert.equal(all.next_cursor, undefined);
  assert.deepEqual(validateJsonSchemaValue(RECORD_QUERY_OUTPUT_SCHEMA, all), []);
  assert.equal((await query({ status_in: ["complete"] })).rows.length, 102);
  assert.equal((await query({ ids: ["item-0", "item-204"] })).rows.length, 2);
  assert.equal((await query({ ids: [] })).rows.length, 0);
  assert.equal((await query({ changed_since: "2031-01-03T18:00:00+01:00" })).rows.length, 205, "inclusive instant comparison");
  assert.equal((await query({ missing_any_of: ["summary"] })).rows.length, 102);
  assert.equal((await query({ missing_any_of: ["effort"] })).rows.length, 0, "zero is a present value");
  await assert.rejects(query({ missing_any_of: ["secret"] }), /declared field/);
  await assert.rejects(query({ status_in: "open" }), /bounded array/);
  await assert.rejects(query({ changed_since: "yesterday" }), /ISO timestamp/);
  await assert.rejects(query({ invented: "open" }), /not declared/);
});

test("freshness and a webhook watermark cannot replace complete-source evidence", async () => {
  const { service, store, sync } = await fixture();
  await store.setWatermark("test-instance", source.id, "cursor-newer-than-cutoff");
  const query = { projection_id: projection.id, all_pages: true, require_synced_through: instant };
  await assert.rejects(service.query({ query, subject }), /not completely synchronized/);
  await sync("2031-01-03T16:50:00Z", "sync-2");
  await assert.rejects(service.query({ query, subject }), /not completely synchronized/);
  await sync(instant, "sync-3");
  const result = await service.query({ query, subject });
  assert.equal(result.synced_through, instant); assert.equal(result.source_proofs[0]?.run_id, "sync-3");
  assert.deepEqual(validateJsonSchemaValue(RECORD_QUERY_OUTPUT_SCHEMA, result), []);
});

test("failed synchronization cannot advance source completeness", async () => {
  const { service, store, registry, sync } = await fixture();
  await sync("2031-01-03T16:50:00Z", "sync-good");
  await assert.rejects(synchronizeRecordSnapshot({ instanceId: "test-instance", source, registry, store,
    runId: "sync-bad", leaseOwner: "worker", leaseToken: "bad", leaseExpiresAt: "2031-01-03T18:00:00Z",
    inventory: { complete: true, observed_at: instant, synced_through: instant, watermark: "new", receipt: {}, objects: [{ id: "broken" }] },
  }), /required field/);
  const result = await service.query({ query: { projection_id: projection.id }, subject });
  assert.equal(result.synced_through, "2031-01-03T16:50:00.000Z");
  await assert.rejects(sync("2031-01-03T17:01:00Z", "future-proof"), /no later than/);
  await assert.rejects(synchronizeRecordSnapshot({ instanceId: "test-instance", source: { ...source, resource_binding: "another-resource" }, registry, store,
    runId: "wrong-source", leaseOwner: "worker", leaseToken: "wrong", leaseExpiresAt: "2031-01-03T18:00:00Z",
    inventory: { complete: true, observed_at: instant, synced_through: instant, watermark: "wrong", receipt: {}, objects: [] },
  }), /registered declaration/);
});

test("a complete empty source is distinguishable from an unsynchronized empty projection", async () => {
  const { service, sync } = await fixture(0);
  const query = { projection_id: projection.id, require_synced_through: instant };
  await assert.rejects(service.query({ query, subject }), /not completely synchronized/);
  await sync(instant, "complete-empty");
  assert.equal((await service.query({ query, subject })).rows.length, 0);
});

test("source selection and the slowest source constrain completeness", async () => {
  const { registry, service } = await fixture();
  registry.registerSource({ ...source, id: "another-source" });
  registry.registerProjection({ ...projection, id: "two-sources", source_ids: [source.id, "another-source"] });
  await service.ingest({ event: { source_id: "another-source", event_id: "e", object_id: "other", kind: "created", observed_at: instant, receipt: {} },
    raw: { id: "other", item_id: "other", status: "open", changed_at: instant, fields: {} } });
  assert.equal((await service.query({ query: { projection_id: projection.id }, subject })).rows.length, 3);
  await assert.rejects(service.query({ query: { projection_id: "two-sources", require_synced_through: instant }, subject }), /not completely synchronized/);
});

test("authorization happens before reading snapshot data or completion receipts", async () => {
  const { service, store } = await fixture();
  store.readProjectionSnapshot = async () => { throw new Error("must not be called"); };
  await assert.rejects(service.query({ query: { projection_id: projection.id }, subject: { ...subject, group_ids: [] } }), /cannot read projection/);
  assert.equal(store.accessDecisions.at(-1)?.allowed, false);
});

test("page cursors bind to an immutable query snapshot and fail after changes", async () => {
  const { service, store } = await fixture();
  const first = await service.query({ query: { projection_id: projection.id, limit: 1 }, subject });
  const second = await service.query({ query: { projection_id: projection.id, limit: 1, cursor: first.next_cursor }, subject });
  assert.notEqual(first.rows[0]?.record_id, second.rows[0]?.record_id);
  assert.equal(first.snapshot_id, second.snapshot_id);
  await assert.rejects(service.query({ query: { projection_id: projection.id, all_pages: true, cursor: first.next_cursor }, subject }), /partial cursor/);
  [...store.projectionRows.values()][0]!.values.status = "modified";
  await assert.rejects(service.query({ query: { projection_id: projection.id, cursor: first.next_cursor }, subject }), /different snapshot/);
});

test("snapshot reads are isolated from subsequent store mutations and JSON key order", async () => {
  const { store, service } = await fixture();
  const first = await service.query({ query: { projection_id: projection.id }, subject });
  for (const row of store.projectionRows.values()) row.values = Object.fromEntries(Object.entries(row.values).reverse());
  assert.equal((await service.query({ query: { projection_id: projection.id }, subject })).snapshot_id, first.snapshot_id);
  const snapshot = await store.readProjectionSnapshot({ instanceId: "test-instance", projectionId: projection.id, sourceIds: [source.id], limit: 200 });
  store.projectionRows.clear();
  assert.equal(snapshot.rows.length, 3);
});

test("all-pages rejects repeated cursors, duplicate records and bounded overflow", async () => {
  const { service, store } = await fixture();
  const row = (await service.query({ query: { projection_id: projection.id }, subject })).rows[0]!;
  let calls = 0;
  await assert.rejects(drainRecordPages(async () => ({ rows: [{ ...row, record_id: `id-${calls++}` }], nextCursor: "same" })), /repeated continuation/);
  await assert.rejects(drainRecordPages(async () => ({ rows: [row], nextCursor: `page-${calls++}` })), /repeated record/);
  await assert.rejects(drainRecordPages(async () => ({ rows: [], nextCursor: "empty" })), /empty or repeated/);
  store.readProjectionSnapshot = async () => ({ rows: Array.from({ length: MAX_RECORD_QUERY_ROWS + 1 }, () => row), sourceReceipts: [] });
  await assert.rejects(service.query({ query: { projection_id: projection.id }, subject }), /snapshot bound/);
});

test("Record cutoffs retain fractional precision and reject invalid calendar instants", async () => {
  assert.equal(canonicalRecordInstant("1969-12-31T23:59:59.123456789Z"), "1969-12-31T23:59:59.123456789Z");
  assert.equal(canonicalRecordInstant("2032-02-29T18:00:00.123456789+01:00"), "2032-02-29T17:00:00.123456789Z");
  const { service, store, sync } = await fixture();
  const query = (filters: Record<string, string>) => service.query({ query: { projection_id: projection.id, filters }, subject });
  assert.equal((await query({ changed_since: "2031-01-03T17:00:00.000000001Z" })).rows.length, 0);
  const rows = [...store.projectionRows.values()];
  rows[0]!.values.changed_at = "2031-01-03T18:00:00.000000002+01:00";
  assert.equal((await query({ changed_since: "2031-01-03T17:00:00.000000002Z" })).rows.length, 1);
  assert.equal((await query({ changed_since: "2031-01-03T17:00:00.000000003Z" })).rows.length, 0);
  for (const invalid of ["2031-02-29T17:00:00Z", "2031-04-31T17:00:00Z", "2031-01-03T24:00:00Z", "2031-01-03T17:00:00.0000000001Z"]) {
    await assert.rejects(query({ changed_since: invalid }), /ISO timestamp/);
  }
  await sync(instant, "exact-boundary");
  await assert.rejects(service.query({ query: { projection_id: projection.id, require_synced_through: "2031-01-03T17:00:00.000000001Z" }, subject }), /not completely synchronized/);
  await assert.rejects(sync("2031-01-03T17:00:00.000000001Z", "future-nanosecond"), /no later than/);
});

test("memory chooses the actual latest proof within a microsecond and the earliest source bound", async () => {
  const { service, store, registry } = await fixture(0);
  const add = async (sourceId: string, runId: string, through: string) => store.appendSyncReceipt({
    instance_id: "test-instance", source_id: sourceId, source_digest: registry.sourceDigest(sourceId), run_id: runId,
    started_at: instant, completed_at: instant, synced_through: through, watermark: runId,
    observed: 0, inserted: 0, unchanged: 0, deleted: 0, errors: 0,
  });
  // Opposing run-id order catches a false equality after timestamp rounding.
  await add(source.id, "z-older", "2031-01-03T16:59:59.123456701Z");
  await add(source.id, "a-newer", "2031-01-03T17:59:59.123456702+01:00");
  const first = await service.query({ query: { projection_id: projection.id }, subject });
  assert.equal(first.source_proofs[0]!.run_id, "a-newer");
  assert.equal(first.synced_through, "2031-01-03T16:59:59.123456702Z");
  registry.registerSource({ ...source, id: "other-items" });
  registry.registerProjection({ ...projection, id: "both", source_ids: [source.id, "other-items"] });
  await add("other-items", "other", "2031-01-03T16:59:59.1234567Z");
  const all = await service.query({ query: { projection_id: "both" }, subject });
  assert.equal(all.synced_through, "2031-01-03T16:59:59.1234567Z", "numeric order, not lexical fractional-string order");
});
