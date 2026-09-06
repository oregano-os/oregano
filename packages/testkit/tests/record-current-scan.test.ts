import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "../../capabilities/contracts.ts";
import type { CompanyRecordProjectionDeclaration, CompanyRecordSourceDeclaration, RecordQuery } from "../../records/contracts.ts";
import { InMemoryCompanyRecordsStore } from "../../records/memory-store.ts";
import { CompanyRecordsRegistry } from "../../records/registry.ts";
import { CompanyRecordsService } from "../../records/service.ts";
import { synchronizeRecordSnapshot } from "../../records/synchronization.ts";
import { validateJsonSchemaValue } from "../../capabilities/validation.ts";
import { RECORD_QUERY_OUTPUT_SCHEMA } from "../../records/query-schema.ts";
import { recordSourceBindingDigest } from "../../records/source-connector.ts";
import type { CompanyRecordSourceBinding } from "../../records/source-connector.ts";

const deadline = "2031-01-03T17:00:00.000000100Z";
const completed = "2031-01-03T17:01:00.000Z";
const source: CompanyRecordSourceDeclaration = {
  schema_version: 1, id: "fixture-source", record_type: "fixture-item", connection: "connections/fixture.md", resource_binding: "fixture-board",
  delivery: "poll", identity: { source_field: "id" }, fields: [{ target: "content", source: "content", value_type: "string", required: true }],
  access: { read_groups: ["team"], write_roles: [] },
};
const projection: CompanyRecordProjectionDeclaration = {
  schema_version: 1, id: "fixture-view", record_type: source.record_type, source_ids: [source.id],
  fields: [{ name: "content", path: "content" }], materialization: { mode: "database-view" }, freshness: { max_age_minutes: 60 }, access: { read_groups: ["team"] },
};
const subject = { principal_id: "reader", status: "active" as const, roles: [], group_ids: ["team"] };
const object = (id: string, content = id) => ({ id, content });

function fixture(bound = false) {
  const registry = new CompanyRecordsRegistry(); registry.registerSource(source); registry.registerProjection(projection);
  const binding: CompanyRecordSourceBinding = { schema_version: 1, instance_id: "fixture", source_id: source.id, resource_binding: source.resource_binding,
    connector: "fixture", connector_version: "1.0.0", secret_ref: "FIXTURE_SECRET", qualification: { receipt_ref: "fixture", digest: "fixture" }, configuration: {} };
  if (bound) registry.bindSource(binding, {});
  const store = new InMemoryCompanyRecordsStore();
  const service = () => new CompanyRecordsService({ instanceId: "fixture", registry, store, now: () => new Date(completed) });
  const query = (extra: Partial<RecordQuery> = {}) => service().query({ subject, query: { projection_id: projection.id, all_pages: true, require_scan_started_after: deadline, ...extra } });
  const sync = (runId: string, objects: Record<string, JsonValue>[], start: string | undefined = deadline) => synchronizeRecordSnapshot({
    instanceId: "fixture", source, registry, store, runId, leaseOwner: "worker", leaseToken: runId, leaseExpiresAt: "2031-01-03T18:00:00Z",
    inventory: { complete: true, observed_at: completed, ...(start ? { scan_started_at: start } : {}), objects, watermark: runId, receipt: {},
      ...(bound ? { binding_digest: recordSourceBindingDigest(binding, {}) } : {}) },
  });
  return { registry, store, service, query, sync };
}

for (const bound of [false, true]) test(`complete current scans exclude absent objects and preserve observed edits (${bound ? "bound generation" : "unbound source"})`, async () => {
  const h = fixture(bound);
  await assert.rejects(h.query(), /no matching complete current scan/);
  await h.sync("first", [object("one", "original"), object("two", "later absent")]);
  const first = await h.query();
  assert.equal(first.rows.length, 2);
  assert.equal(first.scan_started_at, "2031-01-03T17:00:00.0000001Z");
  assert.equal(first.synced_through, undefined);
  assert.deepEqual(first.source_proofs, []);
  assert.deepEqual(validateJsonSchemaValue(RECORD_QUERY_OUTPUT_SCHEMA, first), []);
  assert.equal((await h.query()).snapshot_id, first.snapshot_id, "new service reads the same completed scan");
  await h.sync("second", [object("one", "visible edit")], "2031-01-03T17:00:01Z");
  const second = await h.query();
  assert.deepEqual(second.rows.map((row) => row.values.content), ["visible edit"]);
  assert.equal(second.source_scan_proofs?.[0]?.run_id, "second");
  assert.notEqual(second.snapshot_id, first.snapshot_id);
  assert.equal(h.store.objectVersions.size, 3, "existing audit versions remain retained");
  assert.equal(h.store.projectionRows.size, 2, "absence is scoped to the successful scan, not a fabricated deletion event");
  await h.sync("empty", [], "2031-01-03T17:00:02Z");
  const empty = await h.query();
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.source_scan_proofs?.[0]?.run_id, "empty");
  assert.equal((await h.query()).snapshot_id, empty.snapshot_id);
  await assert.rejects(h.service().query({ subject, query: { projection_id: projection.id, require_synced_through: deadline } }), /not completely synchronized/);
});

test("current scan gates reject old starts, invented coverage and conflicting query modes", async () => {
  const h = fixture();
  await h.sync("ordinary", [], "");
  await assert.rejects(h.query(), /no matching complete current scan/);
  await h.sync("too-early", [], "2031-01-03T17:00:00.000000099Z");
  await assert.rejects(h.query(), /started at or after/);
  await h.sync("exact", [], "2031-01-03T18:00:00.000000100+01:00");
  assert.deepEqual((await h.query()).rows, []);
  await assert.rejects(h.query({ require_synced_through: deadline }), /not both/);
  await assert.rejects(h.query({ require_scan_started_after: "2031-02-30T17:00:00Z" }), /calendar/);
  await assert.rejects(h.sync("future", [], "2031-01-03T17:02:00Z"), /cannot exceed/);
});

test("failed scans and concurrent ingestion cannot mix current rows into an accepted inventory", async () => {
  const h = fixture(true);
  await h.sync("accepted", [object("one", "accepted content")]);
  const first = await h.query();
  await h.service().ingest({ event: { source_id: source.id, event_id: "partial-event", object_id: "one", kind: "updated", observed_at: completed, receipt: {} }, raw: object("one", "not part of a complete scan") });
  assert.equal((await h.query()).snapshot_id, first.snapshot_id);
  const append = h.store.appendSyncReceipt.bind(h.store);
  h.store.appendSyncReceipt = async () => { throw new Error("Simulated receipt persistence failure"); };
  await assert.rejects(h.sync("failed", [object("one", "failed scan"), object("three")], "2031-01-03T17:00:01Z"), /persistence failure/);
  h.store.appendSyncReceipt = append;
  assert.equal((await h.query()).snapshot_id, first.snapshot_id, "all partially ingested facts remain outside the completed scan");
  await h.sync("recovered", [object("one", "failed scan"), object("three")], "2031-01-03T17:00:02Z");
  assert.equal((await h.query()).rows.length, 2);
});

test("current scan proof requires exact projection, source provenance and immutable membership", async () => {
  const h = fixture(true);
  await h.sync("scan", [object("one")]);
  const receipt = h.store.syncReceipts[0]!;
  const digest = receipt.source_digest;
  receipt.source_digest = "different";
  await assert.rejects(h.query(), /no matching complete current scan/);
  receipt.source_digest = digest;
  const membership = [...receipt.scan_version_ids!];
  receipt.scan_version_ids!.push(membership[0]!);
  await assert.rejects(h.query(), /membership/);
  receipt.scan_version_ids = membership;
  const version = [...h.store.objectVersions.values()][0]!;
  const provenance = version.source_receipt.source_digest;
  version.source_receipt.source_digest = "different";
  await assert.rejects(h.query(), /source-binding provenance/);
  version.source_receipt.source_digest = provenance!;
  h.store.objectVersions.clear();
  await assert.rejects(h.query(), /membership/);
});

test("current scans retain all-pages and authorization boundaries", async () => {
  const h = fixture();
  await h.sync("many", Array.from({ length: 205 }, (_, i) => object(`item-${i}`)));
  assert.equal((await h.query({ limit: 7 })).rows.length, 205);
  const page = await h.query({ all_pages: false, limit: 7 });
  assert.equal(page.rows.length, 7);
  assert.equal((await h.query({ all_pages: false, limit: 7, cursor: page.next_cursor })).rows.length, 7);
  await h.sync("changed", [], "2031-01-03T17:00:01Z");
  await assert.rejects(h.query({ all_pages: false, cursor: page.next_cursor }), /different snapshot/);
  let reads = 0;
  h.store.readProjectionSnapshot = async () => { reads++; throw new Error("must not read"); };
  await assert.rejects(h.service().query({ subject: { ...subject, group_ids: [] }, query: { projection_id: projection.id, require_scan_started_after: deadline } }), /cannot read/);
  assert.equal(reads, 0);
});

test("every contributing source and the exact projection need successful current scan evidence", async () => {
  const registry = new CompanyRecordsRegistry(), store = new InMemoryCompanyRecordsStore();
  const secondSource = { ...source, id: "other-source" };
  const view = { ...projection, source_ids: [source.id, secondSource.id] };
  registry.registerSource(source); registry.registerSource(secondSource); registry.registerProjection(view);
  const sync = (selected: CompanyRecordSourceDeclaration, runId: string, start: string) => synchronizeRecordSnapshot({ instanceId: "fixture", source: selected,
    registry, store, runId, leaseOwner: "worker", leaseToken: runId, leaseExpiresAt: "2031-01-03T18:00:00Z",
    inventory: { complete: true, scan_started_at: start, observed_at: completed, objects: [object("shared-id", selected.id)], watermark: runId, receipt: {} } });
  const query = () => new CompanyRecordsService({ instanceId: "fixture", registry, store, now: () => new Date(completed) })
    .query({ subject, query: { projection_id: view.id, require_scan_started_after: deadline, all_pages: true } });
  await sync(source, "first-source", deadline);
  await assert.rejects(query(), /no matching complete current scan/);
  await sync(secondSource, "second-source", "2031-01-03T17:00:01Z");
  const result = await query();
  assert.equal(result.rows.length, 2);
  assert.equal(result.source_scan_proofs?.length, 2);
  assert.equal(result.scan_started_at, "2031-01-03T17:00:00.0000001Z");
  store.syncReceipts[1]!.projection_digests = { [view.id]: "different" };
  await assert.rejects(query(), /no matching complete current scan/);
});

test("large ordinary inventories remain synchronizable but cannot supply bounded current query proof", async () => {
  const h = fixture();
  await h.sync("earlier", [object("one")]);
  await h.sync("too-large", Array.from({ length: 10_001 }, (_, i) => object(String(i))), "2031-01-03T17:00:01Z");
  assert.equal(h.store.objectVersions.size, 10_002);
  assert.equal(h.store.syncReceipts.length, 2);
  assert.equal(h.store.syncReceipts[1]!.scan_version_ids, undefined);
  await assert.rejects(h.query(), /inventory bound/, "never fall back to a smaller older scan");
});
