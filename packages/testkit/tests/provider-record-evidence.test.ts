import assert from "node:assert/strict";
import { test } from "node:test";
import { MondayRecordSourceConnector } from "../../connectors/monday/records-source.ts";
import { RecordIdentityDirectory } from "../../records/identity-directory.ts";
import { normalizeRecordObject } from "../../records/normalize.ts";
import type { CompanyRecordSourceDeclaration } from "../../records/contracts.ts";
import type { CompanyRecordSourceBinding } from "../../records/source-connector.ts";

const source: CompanyRecordSourceDeclaration = {
  schema_version: 1, id: "assignments", connection: "connections/board.md", resource_binding: "delivery-board",
  record_type: "work-item", delivery: "poll", identity: { source_field: "id" },
  fields: [{ target: "owners", source: "people_principals.owners", value_type: "identity_list", required: true, resolve_identity: true }],
  access: { read_groups: ["delivery"], write_roles: [] },
};
const binding: CompanyRecordSourceBinding = {
  schema_version: 1, instance_id: "fixture-instance", source_id: source.id, resource_binding: source.resource_binding,
  connector: "oregano/monday-record-source", connector_version: "0.3.2", secret_ref: "env:FIXTURE_TOKEN",
  qualification: { receipt_ref: "fixture:qualification", digest: "a".repeat(64) },
  configuration: { board_id: "200002", agent_id: "900001", api_version: "dev", permission: "read", group_ids: ["delivery"] },
};
const board = {
  id: "200002", name: "Delivery", board_kind: "private", state: "active",
  groups: [{ id: "delivery", title: "Delivery", archived: false, deleted: false }],
  columns: [{ id: "owners", title: "Owners", type: "people", archived: false }],
};
const qualification = () => ({
  kind: "monday-external-agent-qualification", phase: "complete", evidence: { discovery: {
    discovery_hash: binding.qualification.digest, authentication_mode: "external-agent", credentials_retained: false,
    configured_agent_id: "900001", identity_mapping_status: "administrator-confirmed", identity: { externalAgentId: "900001" },
    account: { id: "300003" }, resources: [{ scope: "board", id: "200002", permission: "read" }], boards: [structuredClone(board)],
  } },
});
const directory = new RecordIdentityDirectory([
  { id: "alex", name: "Alex Example", role: "contributor", type: "human", status: "active", principals: ["monday:300003:1001"], groups: ["delivery"], mayApprove: [] },
  { id: "other-account", name: "Other Example", role: "contributor", type: "human", status: "active", principals: ["monday:400004:1002"], groups: [], mayApprove: [] },
]);

const fixture = (value: unknown) => {
  const requests: Record<string, any>[] = [];
  const connector = new MondayRecordSourceConnector({
    resolveSecret: () => "fixture-not-evidence", now: () => new Date("2030-01-01T12:00:00.000Z"),
    fetcher: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ data: { boards: [{ ...board, items_page: { cursor: null, items: [{
        id: "800001", name: "Synthetic assignment", updated_at: "2030-01-01T10:00:00.000Z", created_at: "2030-01-01T09:00:00.000Z",
        state: "active", url: "https://example.test/item/800001", board: { id: board.id }, group: { id: "delivery" },
        column_values: [{ id: "owners", text: "", value: value === null ? null : JSON.stringify(value) }],
      }] } }] } }), { status: 200, headers: { "content-type": "application/json", "api-version": "dev", "x-request-id": "fixture-read" } });
    },
  });
  return { connector, requests };
};

test("Monday people evidence keeps account and assignment kind through real Record normalization", async () => {
  const { connector, requests } = fixture({ personsAndTeams: [
    { id: 1001, kind: "team" }, { id: 1001, kind: "person" }, { id: "1002", kind: "person" }, { id: 1001, kind: "person" },
  ] });
  const inventory = await connector.readCompleteInventory({ source, binding, qualification: qualification() });
  assert.deepEqual(requests[0]!.variables.columnIds, ["owners"], "qualified principal paths must select their provider column");
  assert.deepEqual(inventory.objects[0]!.people_principals, { owners: ["monday-team:300003:1001", "monday:300003:1001", "monday:300003:1002"] });
  const record = normalizeRecordObject({ instanceId: binding.instance_id, source, raw: inventory.objects[0]!, observedAt: inventory.observed_at, identities: directory });
  assert.deepEqual(record.values.owners, ["unresolved:monday-team:300003:1001", "alex", "unresolved:monday:300003:1002"]);
  assert.equal(record.source_receipt.identity_directory_digest, directory.digest);
  assert.equal(inventory.receipt.account_id, "300003");
  assert.equal(inventory.synced_through, undefined);
  assert.doesNotMatch(JSON.stringify(inventory), /fixture-not-evidence/);
  assert.ok(requests.every((request) => !request.query.includes("mutation")));
});

test("Monday principal fields require qualified account and actual people column before reading", () => {
  const { connector, requests } = fixture(null);
  const noAccount = qualification();
  delete (noAccount.evidence.discovery as any).account;
  assert.throws(() => connector.validateBinding({ source, binding, qualification: noAccount }), /qualified account/);
  const wrongType = qualification();
  wrongType.evidence.discovery.boards[0]!.columns[0]!.type = "text";
  assert.throws(() => connector.validateBinding({ source, binding, qualification: wrongType }), /qualified people column/);
  assert.equal(requests.length, 0);
});

test("Monday malformed or unknown assignment entries fail instead of dropping owners", async () => {
  for (const value of [
    { personsAndTeams: [{ id: 1001, kind: "unknown" }] },
    { personsAndTeams: [{ id: 9007199254740992, kind: "person" }] },
    { personsAndTeams: [{ id: "1001:alias", kind: "person" }] },
    { personsAndTeams: [null] }, { unexpected: [] }, "invalid-provider-value",
  ]) {
    const { connector } = fixture(value);
    await assert.rejects(() => connector.readCompleteInventory({ source, binding, qualification: qualification() }), /Monday people column/);
  }
  const empty = await fixture(null).connector.readCompleteInventory({ source, binding, qualification: qualification() });
  assert.deepEqual(empty.objects[0]!.people_principals, { owners: [] });
});
