import assert from "node:assert/strict";
import { test } from "node:test";
import { CompanyRecordsRegistry } from "../../records/registry.ts";
import { CompanyRecordsService } from "../../records/service.ts";
import { InMemoryCompanyRecordsStore } from "../../records/memory-store.ts";
import { synchronizeRecordSnapshot } from "../../records/synchronization.ts";
import { reconcileRecordSnapshot } from "../../records/reconciliation.ts";
import { recordSourceBindingDigest, type CompanyRecordSourceBinding } from "../../records/source-connector.ts";
import type { CompanyRecordProjectionDeclaration, CompanyRecordSourceDeclaration } from "../../records/contracts.ts";

const instant = "2031-02-01T17:00:00.000Z";
const source: CompanyRecordSourceDeclaration = {
  schema_version: 1, id: "fixture-items", record_type: "work-item", connection: "connections/board.md",
  resource_binding: "fixture-board", delivery: "poll", identity: { source_field: "id" },
  fields: [{ target: "title", source: "title", value_type: "string", required: true }],
  access: { read_groups: ["team"], write_roles: [] },
};
const projection: CompanyRecordProjectionDeclaration = {
  schema_version: 1, id: "fixture-view", record_type: source.record_type, source_ids: [source.id],
  fields: [{ name: "title", path: "title" }], access: { read_groups: ["team"] },
  freshness: { max_age_minutes: 60 }, materialization: { mode: "database-view" },
};
const binding: CompanyRecordSourceBinding = {
  schema_version: 1, instance_id: "fixture-instance", source_id: source.id, resource_binding: source.resource_binding,
  connector: "fixture/board", connector_version: "1.0.0", secret_ref: "env:FIXTURE_TOKEN",
  qualification: { receipt_ref: "instance:fixture/qualification", digest: "a".repeat(64) },
  configuration: { account_id: "account-a", board_id: "board-a" },
};
const qualification = { kind: "fixture-qualified-read", account: "account-a", resource: "board-a" };
const subject = { principal_id: "fixture:reader", status: "active" as const, roles: [], group_ids: ["team"] };
const registryFor = (selected = binding, receipt = qualification, view = projection) => {
  const registry = new CompanyRecordsRegistry(); registry.registerSource(source); registry.registerProjection(view);
  registry.bindSource(selected, receipt); return registry;
};
const sync = (registry: CompanyRecordsRegistry, store: InMemoryCompanyRecordsStore, runId: string, objects = [{ id: "item-1", title: "One" }], proof = registry.sourceBindingDigest(source.id)) =>
  synchronizeRecordSnapshot({ instanceId: binding.instance_id, source, registry, store, runId,
    leaseOwner: "fixture-worker", leaseToken: runId, leaseExpiresAt: "2031-02-01T18:00:00.000Z",
    inventory: { complete: true, observed_at: instant, synced_through: instant, watermark: runId, receipt: {}, objects, binding_digest: proof } });
const query = (registry: CompanyRecordsRegistry, store: InMemoryCompanyRecordsStore) => new CompanyRecordsService({
  instanceId: binding.instance_id, registry, store, now: () => new Date(instant),
}).query({ subject, query: { projection_id: projection.id, all_pages: true, require_synced_through: instant } });

test("bound source evidence freezes the complete non-secret binding and qualification", () => {
  const selected = structuredClone(binding); const receipt = structuredClone(qualification);
  const registry = registryFor(selected, receipt); const original = registry.sourceDigest(source.id);
  selected.configuration.board_id = "other"; receipt.resource = "other";
  assert.equal(registry.sourceDigest(source.id), original);
  for (const changed of [
    { ...binding, configuration: { ...binding.configuration, board_id: "board-b" } },
    { ...binding, configuration: { ...binding.configuration, account_id: "account-b" } },
    { ...binding, configuration: { ...binding.configuration, oldest_at: instant } },
    { ...binding, connector_version: "2.0.0" },
    { ...binding, secret_ref: "env:OTHER_TOKEN" },
    { ...binding, qualification: { ...binding.qualification, digest: "b".repeat(64) } },
  ]) assert.notEqual(registryFor(changed).sourceDigest(source.id), original);
  assert.notEqual(registryFor(binding, { ...qualification, resource: "other" }).sourceDigest(source.id), original);
  assert.throws(() => registry.bindSource(binding, qualification), /already bound/);
  assert.throws(() => registryFor({ ...binding, resource_binding: "other" }), /does not match/);
});

test("wrong inventory binding and repeated objects fail before writing any source state", async () => {
  const registry = registryFor(); const store = new InMemoryCompanyRecordsStore();
  await assert.rejects(sync(registry, store, "wrong", undefined, "wrong"), /registered Instance binding/);
  await assert.rejects(sync(registry, store, "duplicates", [{ id: "same", title: "One" }, { id: "same", title: "Two" }]), /repeated object/);
  assert.equal(store.sourceEvents.size, 0); assert.equal(store.syncReceipts.length, 0); assert.equal(store.watermarks.size, 0);
  const other = registryFor({ ...binding, instance_id: "another-instance" });
  await assert.rejects(sync(other, store, "other"), /another Company Instance/);
  assert.equal(store.sourceEvents.size, 0);
});

test("old and new resources retain independently readable rows and completion evidence", async () => {
  const registry = registryFor(); const store = new InMemoryCompanyRecordsStore();
  await sync(registry, store, "original", [{ id: "item-1", title: "One" }, { id: "old-only", title: "Old" }]);
  const original = await query(registry, store); assert.equal(original.rows.length, 2);
  const changed = registryFor({ ...binding, configuration: { ...binding.configuration, board_id: "board-b" } });
  await assert.rejects(query(changed, store), /not completely synchronized/);
  await sync(changed, store, "new-partial-set");
  assert.equal((await query(changed, store)).rows.length, 1, "old-only row must not silently join the new source");
  assert.equal((await query(registryFor(), store)).snapshot_id, original.snapshot_id, "restarted old Artifact retains exactly its own view");
});

test("identical provider values still create a version bound to the new resource", async () => {
  const registry = registryFor(); const store = new InMemoryCompanyRecordsStore();
  await sync(registry, store, "original"); const original = await query(registry, store);
  const changedBinding = { ...binding, configuration: { ...binding.configuration, board_id: "board-b" } };
  const changed = registryFor(changedBinding);
  assert.equal(changed.sourceBindingDigest(source.id), recordSourceBindingDigest(changedBinding, qualification));
  await sync(changed, store, "new");
  const updated = await query(changed, store);
  assert.equal(updated.rows[0]!.values.title, "One");
  assert.notEqual(updated.rows[0]!.source_version_id, original.rows[0]!.source_version_id);
  assert.notEqual(updated.source_proofs[0]!.source_digest, original.source_proofs[0]!.source_digest);
  assert.equal(store.objectVersions.size, 2, "immutable earlier evidence remains retained");
});

test("bound reads reject a store without atomic version provenance", async () => {
  const registry = registryFor(); const store = new InMemoryCompanyRecordsStore();
  await sync(registry, store, "original");
  const read = store.readProjectionSnapshot.bind(store);
  store.readProjectionSnapshot = async (args) => { const snapshot = await read(args); delete snapshot.rowSources; return snapshot; };
  await assert.rejects(query(registry, store), /source-binding provenance/);
});

test("projection changes require fresh materialization and preserve both definitions", async () => {
  const store = new InMemoryCompanyRecordsStore(); const first = registryFor();
  await sync(first, store, "first"); const original = await query(first, store);
  const view = { ...projection, fields: [{ name: "renamed", path: "title" }] };
  const next = registryFor(binding, qualification, view);
  assert.equal(first.sourceStorageId(source.id), next.sourceStorageId(source.id));
  assert.notEqual(first.projectionStorageId(projection.id), next.projectionStorageId(projection.id));
  await assert.rejects(query(next, store), /not completely synchronized/, "a synchronized source does not prove a new empty projection");
  await sync(next, store, "next");
  assert.deepEqual((await query(next, store)).rows[0]!.values, { renamed: "One" });
  assert.equal((await query(registryFor(), store)).snapshot_id, original.snapshot_id);
  assert.equal(store.objectVersions.size, 1, "a new projection reuses the source generation without duplicating observations");
  assert.throws(() => first.registerProjection({ ...projection, id: "too-late" }), /frozen/);
});

test("generation leases and reconciliation cannot delete another resource's rows", async () => {
  const store = new InMemoryCompanyRecordsStore(); const first = registryFor();
  const next = registryFor({ ...binding, configuration: { ...binding.configuration, board_id: "board-b" } });
  const firstStore = first.scopeStore(store); const nextStore = next.scopeStore(store);
  const lease = { instanceId: binding.instance_id, sourceId: source.id, owner: "worker", token: "same-token", now: instant, expiresAt: "2031-02-01T18:00:00.000Z" };
  assert.equal(await firstStore.claimSyncLease(lease), true);
  assert.equal(await nextStore.claimSyncLease(lease), true);
  assert.equal(await firstStore.releaseSyncLease(lease), true);
  assert.equal(await nextStore.claimSyncLease(lease), false, "releasing the other generation cannot unlock this one");
  await nextStore.releaseSyncLease(lease);
  await sync(first, store, "old"); await sync(next, store, "new");
  await reconcileRecordSnapshot({ instanceId: binding.instance_id, sourceId: source.id, runId: "delete-new",
    leaseOwner: "worker", leaseToken: "delete", leaseExpiresAt: "2031-02-01T18:00:00.000Z", observedAt: instant,
    objects: [], registry: next, store });
  assert.equal((await query(first, store)).rows.length, 1);
  assert.equal((await query(next, store)).rows.length, 0);
});

test("bound queries never fall back to legacy unqualified rows", async () => {
  const store = new InMemoryCompanyRecordsStore(); const legacy = new CompanyRecordsRegistry();
  legacy.registerSource(source); legacy.registerProjection(projection);
  await sync(legacy, store, "legacy");
  const current = registryFor(); await assert.rejects(query(current, store), /not completely synchronized/);
  await sync(current, store, "empty-qualified", []);
  assert.equal((await query(current, store)).rows.length, 0);
  assert.equal((await query(legacy, store)).rows.length, 1, "legacy evidence is retained without being requalified");
});

test("an orphaned projection row fails closed instead of looking like an empty source", async () => {
  const store = new InMemoryCompanyRecordsStore(); const registry = registryFor();
  await sync(registry, store, "one");
  for (const value of store.projectionRows.values()) value.source_version_id = "unknown-version";
  await assert.rejects(query(registry, store), /source-binding provenance/);
});

test("independent source operations populate the same multi-source projection generation", async () => {
  const store = new InMemoryCompanyRecordsStore();
  const otherSource = { ...source, id: "other-items", resource_binding: "other-board" };
  const otherBinding = { ...binding, source_id: otherSource.id, resource_binding: otherSource.resource_binding };
  const view = { ...projection, source_ids: [source.id, otherSource.id] };
  const make = (which: "first" | "second" | "both") => {
    const registry = new CompanyRecordsRegistry(); registry.registerSource(source); registry.registerSource(otherSource); registry.registerProjection(view);
    if (which !== "second") registry.bindSource(binding, qualification);
    if (which !== "first") registry.bindSource(otherBinding, qualification);
    return registry;
  };
  await sync(make("first"), store, "first");
  const second = make("second");
  await synchronizeRecordSnapshot({ instanceId: binding.instance_id, source: otherSource, registry: second, store,
    runId: "second", leaseOwner: "worker", leaseToken: "second", leaseExpiresAt: "2031-02-01T18:00:00.000Z",
    inventory: { complete: true, observed_at: instant, synced_through: instant, watermark: "second", receipt: {},
      objects: [{ id: "item-1", title: "Two" }], binding_digest: second.sourceBindingDigest(otherSource.id) } });
  const combined = make("both"); const result = await query(combined, store);
  assert.deepEqual(result.rows.map((row) => row.values.title).sort(), ["One", "Two"]);
  assert.equal(result.source_proofs.length, 2);
  const scoped = combined.scopeStore(store);
  const firstPage = await scoped.queryProjectionRows({ instanceId: binding.instance_id, projectionId: projection.id, limit: 1 });
  assert.ok(firstPage.nextCursor);
  const secondPage = await scoped.queryProjectionRows({ instanceId: binding.instance_id, projectionId: projection.id, limit: 1, cursor: firstPage.nextCursor });
  assert.equal(secondPage.nextCursor, undefined);
  assert.notEqual(firstPage.rows[0]!.record_id, secondPage.rows[0]!.record_id);
});
