import assert from "node:assert/strict";
import { test } from "node:test";
import { RecordIdentityDirectory } from "../../records/identity-directory.ts";
import { CompanyRecordsRegistry } from "../../records/registry.ts";
import { InMemoryCompanyRecordsStore } from "../../records/memory-store.ts";
import { CompanyRecordsService } from "../../records/service.ts";
import { synchronizeRecordSnapshot } from "../../records/synchronization.ts";
import { reconcileRecordSnapshot } from "../../records/reconciliation.ts";
import type { CompanyRecordSourceDeclaration } from "../../records/contracts.ts";
import type { RosterMember } from "../../state-store/roster.ts";

const roster: RosterMember[] = [
  { id: "mara", name: "Mara Example", role: "contributor", status: "active", mayApprove: [], groups: ["delivery"], principals: ["slack:T10001:U10001", "board:account-1:user-1"] },
  { id: "bot", name: "Fixture Agent", role: "agent", type: "agent", status: "active", mayApprove: [], groups: [], principals: ["slack-bot:T10001:B10001"] },
];
const source: CompanyRecordSourceDeclaration = {
  schema_version: 1, id: "fixture-assignments", record_type: "assignment", connection: "connections/provider.md", resource_binding: "fixture-board", delivery: "poll", identity: { source_field: "id" },
  fields: [{ target: "people", source: "principals", value_type: "identity_list", required: true, resolve_identity: true }],
  access: { read_groups: ["delivery"], write_roles: [] },
};
const observedAt = "2030-01-01T12:00:00.000Z";
const fixture = (members = roster) => {
  const identities = new RecordIdentityDirectory(members);
  const registry = new CompanyRecordsRegistry({ identities }); registry.registerSource(source);
  registry.registerProjection({ schema_version: 1, id: "assignments", record_type: source.record_type, source_ids: [source.id], fields: [{ name: "people", path: "people" }], freshness: { max_age_minutes: 60 }, access: { read_groups: ["delivery"] }, materialization: { mode: "database-view" } });
  return { identities, registry };
};

test("Record identity lookup uses complete provider principals and never names or agent identities", () => {
  const directory = new RecordIdentityDirectory(roster);
  assert.equal(directory.resolve("slack:T10001:U10001"), "mara");
  assert.equal(directory.resolve("board:account-1:user-1"), "mara");
  assert.equal(directory.resolve("board:account-2:user-1"), "unresolved:board:account-2:user-1");
  assert.equal(directory.resolve("slack-bot:T10001:B10001"), "unresolved:slack-bot:T10001:B10001");
  assert.throws(() => directory.resolve("Mara Example"), /fully qualified/);
  assert.throws(() => directory.resolve("user-1"), /fully qualified/);
});

test("identity directories reject ambiguity, freeze input and have order-independent evidence", () => {
  const input = structuredClone(roster);
  const directory = new RecordIdentityDirectory(input);
  input[0]!.principals!.push("board:account-1:new-user");
  directory.members()[0]!.name = "Mutation";
  assert.equal(directory.resolve("board:account-1:new-user"), "unresolved:board:account-1:new-user");
  assert.equal(directory.digest, new RecordIdentityDirectory([...roster].reverse().map((member) => ({ ...member, principals: [...member.principals!].reverse() }))).digest);
  assert.throws(() => new RecordIdentityDirectory([...roster, { ...roster[0]!, id: "another" }]), /ambiguous principal/);
  assert.throws(() => new RecordIdentityDirectory([...roster, roster[0]!]), /distinct stable/);
  assert.throws(() => new RecordIdentityDirectory([{ ...roster[0]!, id: "unresolved:fake" }]), /distinct stable/);
});

test("shared normalization maps typed identities and binds the frozen directory in evidence", () => {
  const { registry, identities } = fixture();
  const version = registry.normalize({ instanceId: "fixture-test", source, observedAt, raw: { id: "item-1", principals: ["board:account-1:user-1", "board:account-1:user-2"] } });
  assert.deepEqual(version.values.people, ["mara", "unresolved:board:account-1:user-2"]);
  assert.equal(version.source_receipt.identity_directory_digest, identities.digest);
  const missing = new CompanyRecordsRegistry(); missing.registerSource(source);
  assert.throws(() => missing.normalize({ instanceId: "fixture-test", source, observedAt, raw: { id: "item-1", principals: [] } }), /frozen roster/);
  const bad = structuredClone(source); bad.fields[0]!.source = "parsed.people";
  assert.throws(() => registry.registerSource({ ...bad, id: "bad-source" }), /never parsed text/);
});

test("changing the reviewed roster invalidates earlier source-completeness evidence until a new sync", async () => {
  const { registry } = fixture();
  const store = new InMemoryCompanyRecordsStore();
  const sync = (selected: CompanyRecordsRegistry, runId: string) => synchronizeRecordSnapshot({ instanceId: "fixture-test", source, registry: selected, store, runId, leaseOwner: "worker", leaseToken: runId, leaseExpiresAt: "2030-01-01T12:10:00.000Z", inventory: { complete: true, observed_at: observedAt, synced_through: observedAt, watermark: runId, objects: [{ id: "item-1", principals: ["board:account-1:user-1"] }], receipt: {} } });
  await sync(registry, "sync-1");
  const query = (selected: CompanyRecordsRegistry) => new CompanyRecordsService({ instanceId: "fixture-test", registry: selected, store, now: () => new Date(observedAt) }).query({ query: { projection_id: "assignments", all_pages: true, require_synced_through: observedAt }, subject: { principal_id: "companyos:fixture:reader", status: "active", group_ids: ["delivery"], roles: [] } });
  assert.deepEqual((await query(registry)).rows[0]!.values.people, ["mara"]);
  const changed = fixture(roster.map((member) => member.id === "mara" ? { ...member, id: "mara-renamed" } : member)).registry;
  assert.notEqual(changed.sourceDigest(source.id), registry.sourceDigest(source.id));
  await assert.rejects(query(changed), /not completely synchronized/);
  await sync(changed, "sync-2");
  assert.deepEqual((await query(changed)).rows[0]!.values.people, ["mara-renamed"]);
});

test("reconciliation reuses the same directory and cannot run without it even on an empty inventory", async () => {
  const { registry } = fixture();
  const store = new InMemoryCompanyRecordsStore();
  const args = { instanceId: "fixture-test", sourceId: source.id, registry, store, runId: "reconcile-1", leaseOwner: "worker", leaseToken: "lease", observedAt, leaseExpiresAt: "2030-01-01T12:10:00.000Z", objects: [{ id: "item-1", principals: ["board:account-1:user-1"] }] };
  await reconcileRecordSnapshot(args);
  assert.deepEqual([...store.projectionRows.values()][0]!.values.people, ["mara"]);
  const missing = new CompanyRecordsRegistry(); missing.registerSource(source);
  await assert.rejects(reconcileRecordSnapshot({ ...args, registry: missing, objects: [] }), /frozen roster/);
});
