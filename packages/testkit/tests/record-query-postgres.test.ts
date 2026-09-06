import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { neon } from "@neondatabase/serverless";
import { createPostgresCompanyRecordsStore, inspectPostgresCompanyRecordProjectionStatus, inspectPostgresCompanyRecordSourceStatus, inspectPostgresCompanyRecordSyncReceipt } from "../../state-postgres/records-store.ts";
import { CompanyRecordsRegistry } from "../../records/registry.ts";
import { CompanyRecordsService } from "../../records/service.ts";
import { synchronizeRecordSnapshot } from "../../records/synchronization.ts";
import type { CompanyRecordProjectionDeclaration, CompanyRecordSourceDeclaration, RecordAccessSubject } from "../../records/contracts.ts";
import { validateJsonSchemaValue } from "../../capabilities/validation.ts";
import { RECORD_QUERY_OUTPUT_SCHEMA } from "../../records/query-schema.ts";
import { RecordIdentityDirectory } from "../../records/identity-directory.ts";
import type { CompanyRecordSourceBinding } from "../../records/source-connector.ts";

const enabled = process.env.RUN_DATABASE_TESTS === "1" && !!process.env.DATABASE_URL;
if (process.env.COMPANYOS_REQUIRE_DATABASE_TESTS === "1" && !enabled) throw new Error("Required Records database configuration is missing");
const skip = enabled ? false : "dedicated database gate supplies the isolated Postgres";
const instant = "2031-02-01T17:00:00.000Z";
const source: CompanyRecordSourceDeclaration = {
  schema_version: 1, id: "fixture-items", record_type: "fixture-record", connection: "connections/fixture.md", resource_binding: "fixture-resource",
  delivery: "poll", identity: { source_field: "id" }, fields: [{ target: "payload", source: "payload", value_type: "json", required: true }],
  access: { read_groups: ["team"], write_roles: [] },
};
const projection: CompanyRecordProjectionDeclaration = {
  schema_version: 1, id: "fixture-view", record_type: source.record_type, source_ids: [source.id],
  fields: [{ name: "payload", path: "payload" }], filters: { status_in: { operator: "in", path: "payload.status" } },
  freshness: { max_age_minutes: 60 }, access: { read_groups: ["team"] }, materialization: { mode: "database-view" },
};
const subject: RecordAccessSubject = { principal_id: "fixture-reader", status: "active", roles: [], group_ids: ["team"] };

test("Postgres current scans preserve exact immutable membership across edits, failed writes and restart", { skip }, async () => {
  const instanceId = `record-current-${randomUUID()}`;
  const registry = new CompanyRecordsRegistry(); registry.registerSource(source); registry.registerProjection(projection);
  const binding: CompanyRecordSourceBinding = { schema_version: 1, instance_id: instanceId, source_id: source.id,
    resource_binding: source.resource_binding, connector: "fixture", connector_version: "1.0.0", secret_ref: "FIXTURE",
    qualification: { receipt_ref: "fixture", digest: "fixture" }, configuration: {} };
  registry.bindSource(binding, {});
  const store = createPostgresCompanyRecordsStore();
  const query = () => new CompanyRecordsService({ instanceId, registry, store: createPostgresCompanyRecordsStore(), now: () => new Date(instant) })
    .query({ subject, query: { projection_id: projection.id, all_pages: true, require_scan_started_after: "2031-02-01T16:59:00.000000100Z" } });
  const sync = (runId: string, ids: string[], status: string, start: string) => synchronizeRecordSnapshot({ instanceId, source, registry, store,
    runId, leaseOwner: "fixture", leaseToken: runId, leaseExpiresAt: "2031-02-01T18:00:00Z",
    inventory: { complete: true, observed_at: instant, scan_started_at: start, binding_digest: registry.sourceBindingDigest(source.id),
      objects: ids.map((id) => ({ id, payload: { status } })), watermark: runId, receipt: {} } });
  await sync("old", [], "old", "2031-02-01T16:59:00.000000099Z");
  await assert.rejects(query(), /started at or after/);
  await sync("first", ["one", "two"], "original", "2031-02-01T16:59:00.000000100Z");
  const first = await query();
  assert.equal(first.rows.length, 2);
  assert.equal(first.scan_started_at, "2031-02-01T16:59:00.0000001Z");
  assert.deepEqual(validateJsonSchemaValue(RECORD_QUERY_OUTPUT_SCHEMA, first), []);
  assert.equal((await query()).snapshot_id, first.snapshot_id);
  const append = store.appendSyncReceipt;
  store.appendSyncReceipt = async () => { throw new Error("Synthetic completion failure"); };
  await assert.rejects(sync("failed", ["one", "three"], "partial", "2031-02-01T16:59:01Z"), /completion failure/);
  store.appendSyncReceipt = append;
  assert.equal((await query()).snapshot_id, first.snapshot_id);
  await sync("edited", ["one"], "current edit", "2031-02-01T16:59:02Z");
  const edited = await query();
  assert.deepEqual(edited.rows.map((row) => row.values), [{ payload: { status: "current edit" } }]);
  assert.equal(edited.source_scan_proofs?.[0]?.run_id, "edited");
  const sql = neon(process.env.DATABASE_URL!);
  const count = await sql`select count(*) as count from companyos_records.object_versions where instance_id = ${instanceId}`;
  assert.equal(Number(count[0]!.count), 5, "earlier audit versions survive absence in the current scan");
  await sync("empty", [], "unused", "2031-02-01T16:59:03Z");
  const empty = await query();
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.synced_through, undefined);
  assert.equal((await query()).snapshot_id, empty.snapshot_id);
});

test("Postgres retains independent source and projection generations with exact materialization evidence", { skip }, async () => {
  const instanceId = `record-binding-${randomUUID()}`;
  const createRegistry = (resource: string, view = projection) => {
    const registry = new CompanyRecordsRegistry(); registry.registerSource(source); registry.registerProjection(view);
    const binding: CompanyRecordSourceBinding = { schema_version: 1, instance_id: instanceId, source_id: source.id,
      resource_binding: source.resource_binding, connector: "fixture/records", connector_version: "1.0.0",
      secret_ref: "env:FIXTURE_TOKEN", qualification: { receipt_ref: "fixture:qualification", digest: "a".repeat(64) },
      configuration: { account: "fixture-account", resource } };
    registry.bindSource(binding, { kind: "fixture-qualified", resource }); return registry;
  };
  const first = createRegistry("resource-a"); const second = createRegistry("resource-b");
  const store = createPostgresCompanyRecordsStore();
  const sync = (registry: CompanyRecordsRegistry, runId: string, ids: string[]) => synchronizeRecordSnapshot({
    instanceId, source, registry, store, runId, leaseOwner: "worker", leaseToken: runId, leaseExpiresAt: "2031-02-01T18:00:00.000Z",
    inventory: { complete: true, observed_at: instant, synced_through: instant, watermark: runId, binding_digest: registry.sourceBindingDigest(source.id),
      receipt: {}, objects: ids.map((id) => ({ id, payload: { status: "open" } })) },
  });
  const query = (registry: CompanyRecordsRegistry) => new CompanyRecordsService({ instanceId, registry,
    store: createPostgresCompanyRecordsStore(), now: () => new Date(instant) }).query({ subject,
    query: { projection_id: projection.id, all_pages: true, require_synced_through: instant } });
  await sync(first, "original", ["one", "two"]);
  const original = await query(createRegistry("resource-a"));
  assert.equal(original.rows.length, 2, "new process reads exact persisted provenance");
  await assert.rejects(query(second), /not completely synchronized/);
  await sync(second, "new-one", ["one"]);
  assert.equal((await query(second)).rows.length, 1);
  assert.equal((await query(first)).snapshot_id, original.snapshot_id);
  const scopes = { [second.projectionStorageId(projection.id)]: [second.sourceStorageId(source.id)] };
  assert.equal((await inspectPostgresCompanyRecordProjectionStatus(instanceId, Object.keys(scopes), scopes))[0]!.rows, 1);
  assert.equal((await inspectPostgresCompanyRecordSourceStatus(instanceId, second.sourceStorageId(source.id))).current_objects, 1);
  assert.equal((await inspectPostgresCompanyRecordSyncReceipt(instanceId, second.sourceStorageId(source.id), "new-one"))?.run_id, "new-one");
  assert.equal(await inspectPostgresCompanyRecordSyncReceipt(instanceId, first.sourceStorageId(source.id), "new-one"), undefined);
  await sync(second, "new-two", ["one", "two"]);
  assert.equal((await query(second)).rows.length, 2);
  const changedProjection = { ...projection, fields: [{ name: "renamed", path: "payload" }], filters: {} };
  const third = createRegistry("resource-b", changedProjection);
  await assert.rejects(query(third), /not completely synchronized/);
  await sync(third, "new-projection", ["one", "two"]);
  assert.deepEqual((await query(third)).rows[0]!.values, { renamed: { status: "open" } });
  assert.deepEqual((await query(second)).rows[0]!.values, { payload: { status: "open" } });
  assert.equal((await query(createRegistry("resource-a"))).snapshot_id, original.snapshot_id);
  const frozen = await second.scopeStore(store).readProjectionSnapshot({ instanceId, projectionId: projection.id, sourceIds: [source.id], limit: 100 });
  assert.equal(frozen.rowSources?.length, 2);
  const sql = neon(process.env.DATABASE_URL!);
  await sql`update companyos_records.object_versions set source_receipt = '{}'::jsonb where instance_id = ${instanceId}`;
  assert.ok(frozen.rowSources!.every((origin) => origin.source_digest === second.sourceDigest(source.id)));
  await assert.rejects(query(second), /source-binding provenance/);
});

test("Postgres preserves immutable complete reads, source proof and JSONB query identity after restart", { skip }, async () => {
  const instanceId = `record-test-${randomUUID()}`;
  const registry = new CompanyRecordsRegistry(); registry.registerSource(source); registry.registerProjection(projection);
  const store = createPostgresCompanyRecordsStore();
  const service = () => new CompanyRecordsService({ instanceId, registry, store: createPostgresCompanyRecordsStore(), now: () => new Date(instant) });
  const objects = Array.from({ length: 205 }, (_, index) => ({ id: `record-${index}`, payload: { index, status: index % 2 ? "complete" : "open" } }));
  await synchronizeRecordSnapshot({ instanceId, source, registry, store, runId: "scan", leaseOwner: "worker", leaseToken: "scan-token",
    leaseExpiresAt: "2031-02-01T18:00:00Z", inventory: { complete: true, observed_at: instant, synced_through: instant, objects, watermark: "scan-watermark", receipt: {} } });
  const query = { projection_id: projection.id, limit: 17, all_pages: true, require_synced_through: instant };
  const first = await service().query({ query, subject });
  assert.equal(first.rows.length, 205); assert.equal(first.synced_through, instant);
  assert.deepEqual(validateJsonSchemaValue(RECORD_QUERY_OUTPUT_SCHEMA, first), []);
  assert.equal((await service().query({ query, subject })).snapshot_id, first.snapshot_id, "new store and service reuse persisted proof");
  const sql = neon(process.env.DATABASE_URL!);
  await sql`update companyos_records.projection_rows set values_json = jsonb_build_object('payload', jsonb_build_object(
    'status', values_json->'payload'->'status', 'index', values_json->'payload'->'index')) where instance_id = ${instanceId}`;
  assert.equal((await service().query({ query, subject })).snapshot_id, first.snapshot_id, "JSONB key order does not change identity");
  assert.equal((await service().query({ query: { ...query, filters: { status_in: ["open"] } }, subject })).rows.length, 103);

  const snapshot = await store.readProjectionSnapshot({ instanceId, projectionId: projection.id, sourceIds: [source.id], limit: 10_000 });
  await sql`update companyos_records.projection_rows set values_json = jsonb_set(values_json, '{payload,status}', '"changed"'::jsonb)
    where instance_id = ${instanceId}`;
  assert.ok(snapshot.rows.every((row) => (row.values.payload as { status: string }).status !== "changed"));
  assert.notEqual((await service().query({ query, subject })).snapshot_id, first.snapshot_id);
  assert.equal((await store.readProjectionSnapshot({ instanceId: "another-instance", projectionId: projection.id, sourceIds: [source.id], limit: 10_000 })).rows.length, 0);
});

test("Postgres never promotes cursors, failed scans or stale source definitions to completeness", { skip }, async () => {
  const instanceId = `record-test-${randomUUID()}`;
  const registry = new CompanyRecordsRegistry(); registry.registerSource(source); registry.registerProjection(projection);
  const store = createPostgresCompanyRecordsStore();
  const service = new CompanyRecordsService({ instanceId, registry, store, now: () => new Date(instant) });
  const query = { projection_id: projection.id, require_synced_through: instant };
  await store.setWatermark(instanceId, source.id, "recent-webhook", instant);
  await assert.rejects(service.query({ query, subject }), /not completely synchronized/);
  await assert.rejects(synchronizeRecordSnapshot({ instanceId, source, registry, store, runId: "bad-scan", leaseOwner: "worker", leaseToken: "bad",
    leaseExpiresAt: "2031-02-01T18:00:00Z", inventory: { complete: true, observed_at: instant, synced_through: instant, objects: [{ id: "missing-fields" }], watermark: "bad", receipt: {} } }), /required field/);
  await assert.rejects(service.query({ query, subject }), /not completely synchronized/);
  await synchronizeRecordSnapshot({ instanceId, source, registry, store, runId: "empty-scan", leaseOwner: "worker", leaseToken: "good",
    leaseExpiresAt: "2031-02-01T18:00:00Z", inventory: { complete: true, observed_at: instant, synced_through: instant, objects: [], watermark: "empty", receipt: {} } });
  assert.equal((await service.query({ query, subject })).rows.length, 0);
  const changed = new CompanyRecordsRegistry(); changed.registerSource({ ...source, resource_binding: "different-resource" }); changed.registerProjection(projection);
  await assert.rejects(new CompanyRecordsService({ instanceId, registry: changed, store, now: () => new Date(instant) }).query({ query, subject }), /not completely synchronized/);
});

test("Postgres restart preserves identity evidence and rejects completeness after a roster change", { skip }, async () => {
  const instanceId = `record-identity-${randomUUID()}`;
  const declaration = { ...source, fields: [{ target: "person", source: "principal", value_type: "identity" as const, required: true, resolve_identity: true }] };
  const view = { ...projection, fields: [{ name: "person", path: "person" }], filters: {} };
  const registry = (id: string) => {
    const result = new CompanyRecordsRegistry({ identities: new RecordIdentityDirectory([{ id, name: "Example Person", role: "contributor", status: "active", mayApprove: [], principals: ["board:account-1:user-1"] }]) });
    result.registerSource(declaration); result.registerProjection(view); return result;
  };
  const original = registry("member-1");
  await synchronizeRecordSnapshot({ instanceId, source: declaration, registry: original, store: createPostgresCompanyRecordsStore(), runId: "scan", leaseOwner: "worker", leaseToken: "token",
    leaseExpiresAt: "2031-02-01T18:00:00Z", inventory: { complete: true, observed_at: instant, synced_through: instant, watermark: "identity-scan", objects: [{ id: "item-1", principal: "board:account-1:user-1" }], receipt: {} } });
  const query = (directory: CompanyRecordsRegistry) => new CompanyRecordsService({ instanceId, registry: directory, store: createPostgresCompanyRecordsStore(), now: () => new Date(instant) }).query({ query: { projection_id: view.id, require_synced_through: instant }, subject });
  const restarted = await query(registry("member-1"));
  assert.equal(restarted.rows[0]!.values.person, "member-1");
  assert.equal(restarted.source_proofs[0]!.source_digest, original.sourceDigest(source.id));
  const version = await createPostgresCompanyRecordsStore().getCurrentObjectVersion(instanceId, source.id, "item-1");
  assert.equal(version!.source_receipt.identity_directory_digest, original.identities!.digest);
  await assert.rejects(query(registry("member-2")), /not completely synchronized/);
});

test("Postgres retains sub-microsecond proof ordering and exact gates after restart", { skip }, async () => {
  const instanceId = `record-precision-${randomUUID()}`;
  const registry = new CompanyRecordsRegistry(); registry.registerSource(source); registry.registerProjection(projection);
  const store = createPostgresCompanyRecordsStore();
  const throughs = [
    ["z-older", "2031-02-01T16:59:59.123456701Z"],
    ["a-newer", "2031-02-01T17:59:59.123456702+01:00"],
  ];
  for (const [runId, through] of throughs) await synchronizeRecordSnapshot({
    instanceId, source, registry, store, runId: runId!, leaseOwner: "worker", leaseToken: runId!,
    leaseExpiresAt: "2031-02-01T18:00:00Z", inventory: { complete: true, observed_at: instant, synced_through: through!, objects: [], watermark: runId!, receipt: {} },
  });
  const service = new CompanyRecordsService({ instanceId, registry, store: createPostgresCompanyRecordsStore(), now: () => new Date(instant) });
  const query = (required: string) => service.query({ query: { projection_id: projection.id, require_synced_through: required }, subject });
  const result = await query("2031-02-01T16:59:59.123456702Z");
  assert.equal(result.source_proofs[0]!.run_id, "a-newer");
  assert.equal(result.synced_through, "2031-02-01T16:59:59.123456702Z");
  await assert.rejects(query("2031-02-01T16:59:59.123456703Z"), /not completely synchronized/);
  assert.deepEqual(validateJsonSchemaValue(RECORD_QUERY_OUTPUT_SCHEMA, result), []);
});
