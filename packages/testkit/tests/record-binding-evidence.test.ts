import assert from "node:assert/strict";
import { test } from "node:test";
import { CompanyRecordsRegistry } from "../../records/registry.ts";
import { CompanyRecordsService } from "../../records/service.ts";
import { InMemoryCompanyRecordsStore } from "../../records/memory-store.ts";
import { synchronizeRecordSnapshot } from "../../records/synchronization.ts";
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
const registryFor = (selected = binding, receipt = qualification) => {
  const registry = new CompanyRecordsRegistry(); registry.registerSource(source); registry.registerProjection(projection);
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

test("fresh binding evidence cannot legitimize rows retained from an earlier resource", async () => {
  const registry = registryFor(); const store = new InMemoryCompanyRecordsStore();
  await sync(registry, store, "original", [{ id: "item-1", title: "One" }, { id: "old-only", title: "Old" }]);
  assert.equal((await query(registry, store)).rows.length, 2);
  const changed = registryFor({ ...binding, configuration: { ...binding.configuration, board_id: "board-b" } });
  await assert.rejects(query(changed, store), /source-binding provenance/);
  await sync(changed, store, "new-partial-set");
  await assert.rejects(query(changed, store), /source-binding provenance/, "old-only row must not silently join the new source");
  await assert.rejects(query(registry, store), /source-binding provenance/, "mixed current projections cannot establish an old Artifact snapshot either");
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
