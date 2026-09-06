import assert from "node:assert/strict";
import { test } from "node:test";
import { MondayRecordSourceConnector } from "../../connectors/monday/records-source.ts";
import { normalizeRecordObject } from "../../records/normalize.ts";
import { RecordIdentityDirectory } from "../../records/identity-directory.ts";
import type { CompanyRecordSourceDeclaration } from "../../records/contracts.ts";
import type { CompanyRecordSourceBinding } from "../../records/source-connector.ts";

const source: CompanyRecordSourceDeclaration = {
  schema_version: 1, id: "mapped-items", record_type: "work-item", connection: "connections/board.md", resource_binding: "delivery-board",
  delivery: "poll", identity: { source_field: "id" }, access: { read_groups: ["delivery"], write_roles: [] },
  fields: [
    { target: "owners", source: "mapped.people_principals.owner", value_type: "identity_list", resolve_identity: true },
    { target: "classification", source: "mapped.column_text.classification", value_type: "status" },
    { target: "status", source: "mapped.column_text.status", value_type: "status" },
    { target: "location", source: "mapped.group", value_type: "string" },
  ],
};
const identities = new RecordIdentityDirectory([{ id: "alex", name: "Alex Example", role: "contributor", type: "human", status: "active",
  principals: ["monday:300003:1001"], groups: ["delivery"], mayApprove: [] }]);

function fixture(suffix = "a", complete = false) {
  const boardId = suffix === "a" ? "200002" : "200003";
  const columns = [{ id: `owners_${suffix}`, title: "Owners", type: "people", archived: false },
    { id: `kind_${suffix}`, title: "Classification", type: "status", archived: false },
    { id: `stage_${suffix}`, title: "Execution", type: "status", archived: false }];
  const board: any = { id: boardId, name: "Synthetic delivery", board_kind: "private", state: "active",
    groups: [{ id: `group_${suffix}`, title: "Delivery", archived: false, deleted: false }], columns };
  const mapping = { columns: { owner: { id: columns[0]!.id, type: "people" }, classification: { id: columns[1]!.id, type: "status" },
    status: { id: columns[2]!.id, type: "status" } }, groups: { delivery: `group_${suffix}` } };
  const binding: CompanyRecordSourceBinding = { schema_version: 1, instance_id: "fixture-instance", source_id: source.id, resource_binding: source.resource_binding,
    connector: "oregano/monday-record-source", connector_version: "0.3.3", secret_ref: "env:FIXTURE_TOKEN", qualification: { receipt_ref: "fixture:qualification", digest: "a".repeat(64) },
    configuration: { board_id: boardId, agent_id: "900001", api_version: "dev", permission: "read", mapping,
      ...(complete ? { inventory_mode: "complete-table" } : { group_ids: [`group_${suffix}`] }) } };
  if (complete) board.columns.push({ id: "children", title: "Children", type: "subtasks", settings: { boardIds: ["200004"] } });
  const qualification: any = { kind: "monday-external-agent-qualification", phase: "complete", evidence: { discovery: {
    discovery_hash: binding.qualification.digest, authentication_mode: "external-agent", credentials_retained: false,
    configured_agent_id: "900001", identity_mapping_status: "administrator-confirmed", identity: { memberId: "700007", kind: "external_agent_member", externalAgentId: "900001" },
    account: { id: "300003" }, resources: [{ scope: "board", id: boardId, permission: "read" }], boards: [structuredClone(board)],
  } } };
  const value = [{ id: columns[0]!.id, text: "Alex", value: JSON.stringify({ personsAndTeams: [{ id: 1001, kind: "person" }] }) },
    { id: columns[1]!.id, text: "Active", value: '{"index":1}' }, { id: columns[2]!.id, text: "Blocked", value: '{"index":2}' }];
  const item: any = { id: "800001", name: "Synthetic task", updated_at: "2030-01-01T10:00:00Z", created_at: "2030-01-01T09:00:00Z",
    state: "active", board: { id: boardId }, group: { id: `group_${suffix}` }, column_values: value };
  if (complete) item.subitems = [{ ...structuredClone(item), id: "800002", board: { id: "200004" }, subitems: [] }];
  const requests: any[] = [];
  let secrets = 0;
  const h = { source: structuredClone(source), binding, qualification, board, item, requests, secrets: () => secrets,
    mutate: (_body: any, _request: any) => {},
    connector: undefined as unknown as MondayRecordSourceConnector };
  h.connector = new MondayRecordSourceConnector({ resolveSecret: () => { secrets++; return "fixture-not-a-credential"; }, now: () => new Date("2030-01-01T12:00:00Z"),
    fetcher: async (_url, init) => {
      const request = JSON.parse(String(init?.body)); requests.push(request);
      assert.doesNotMatch(request.query, /mutation/);
      let body: any;
      if (request.query.includes("QualifyCompanyOSExternalAgent")) body = { data: { me: { id: "700007", name: "Synthetic Agent", kind: "external_agent_member",
        email: "agent-900001@agent.monday.com", account: { id: "300003", name: "Synthetic account" } }, boards: [structuredClone(board)] } };
      else if (request.variables.boardIds?.[0] === "200004") body = { data: { boards: [{ ...structuredClone(board), id: "200004" }] } };
      else body = { data: { boards: [{ ...structuredClone(board), items_page: { cursor: null, items: [structuredClone(item)] } }] } };
      h.mutate(body, request);
      return Response.json(body, { headers: { "api-version": "dev", "x-request-id": `synthetic-${requests.length}` } });
    } });
  return h;
}

test("one Record declaration reads equivalent qualified schemas with different generated IDs", async () => {
  const records = [], inventories = [];
  for (const suffix of ["a", "b"]) {
    const h = fixture(suffix);
    h.connector.validateBinding(h);
    const inventory = await h.connector.readCompleteInventory(h); inventories.push(inventory);
    const raw = inventory.objects[0]!;
    assert.equal(raw.group_id, `group_${suffix}`);
    assert.deepEqual((raw.columns as any)[`owners_${suffix}`], ["1001"]);
    assert.equal((raw.column_text as any)[`kind_${suffix}`], "Active");
    assert.equal((raw.provider_payload as any).group_id, `group_${suffix}`);
    assert.deepEqual((raw.mapped as any).columns.owner, ["1001"]);
    assert.deepEqual(h.requests[1].variables.columnIds, [`kind_${suffix}`, `owners_${suffix}`, `stage_${suffix}`]);
    assert.deepEqual(inventory.receipt.mapping, h.binding.configuration.mapping);
    records.push(normalizeRecordObject({ instanceId: h.binding.instance_id, source, raw, observedAt: inventory.observed_at, identities }).values);
  }
  assert.deepEqual(records[0], { owners: ["alex"], classification: "Active", status: "Blocked", location: "delivery" });
  assert.deepEqual(records[0], records[1]);
  assert.notEqual(inventories[0]!.binding_digest, inventories[1]!.binding_digest);
  assert.notEqual(inventories[0]!.watermark, inventories[1]!.watermark);
});

test("invalid Instance mappings fail before credentials or provider reads", () => {
  for (const change of [
    (h: ReturnType<typeof fixture>) => { delete h.binding.configuration.mapping; },
    (h: ReturnType<typeof fixture>) => { (h.binding.configuration.mapping as any).extra = true; },
    (h: ReturnType<typeof fixture>) => { (h.binding.configuration.mapping as any).columns.owner.id = "missing"; },
    (h: ReturnType<typeof fixture>) => { (h.binding.configuration.mapping as any).columns.owner.type = "text"; },
    (h: ReturnType<typeof fixture>) => { (h.binding.configuration.mapping as any).columns.status.id = "kind_a"; },
    (h: ReturnType<typeof fixture>) => { (h.binding.configuration.mapping as any).groups.extra = "group_a"; },
    (h: ReturnType<typeof fixture>) => { (h.binding.configuration.mapping as any).groups.delivery = "missing"; },
    (h: ReturnType<typeof fixture>) => { (h.binding.configuration.mapping as any).columns = JSON.parse('{"__proto__":{"id":"owners_a","type":"people"}}'); },
    (h: ReturnType<typeof fixture>) => { (h.binding.configuration.mapping as any).groups = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`key_${i}`, `group_${i}`])); },
    (h: ReturnType<typeof fixture>) => { h.source.fields[0]!.source = "mapped.people_principals.undeclared"; },
    (h: ReturnType<typeof fixture>) => { h.source.fields[0]!.source = "mapped.people_principals.classification"; },
    (h: ReturnType<typeof fixture>) => { h.source.fields[0]!.source = "mapped.column_text.owner.nested"; },
    (h: ReturnType<typeof fixture>) => { h.qualification.evidence.discovery.boards[0].columns.push(structuredClone(h.board.columns[0])); },
  ]) {
    const h = fixture(); change(h);
    assert.throws(() => h.connector.validateBinding(h), /Monday/);
    assert.equal(h.secrets(), 0); assert.equal(h.requests.length, 0);
  }
});

test("mapped schema is revalidated before item reads and against returned column metadata", async () => {
  for (const change of ["column-type", "archived-column", "deleted-group", "returned-column-type"]) {
    const h = fixture();
    h.mutate = (body, request) => {
      const identity = request.query.includes("QualifyCompanyOSExternalAgent"), board = body.data.boards[0];
      if (identity && change === "column-type") board.columns[1].type = "text";
      if (identity && change === "archived-column") board.columns[1].archived = true;
      if (identity && change === "deleted-group") board.groups[0].deleted = true;
      if (!identity && change === "returned-column-type") board.columns[1].type = "text";
    };
    await assert.rejects(h.connector.readCompleteInventory(h), /Monday mapping.*no longer matches/);
    assert.equal(h.requests.length, change === "returned-column-type" ? 2 : 1);
  }
});

test("complete inventories preserve child and metadata evidence without inheriting root mappings", async () => {
  const h = fixture("a", true);
  const inventory = await h.connector.readCompleteInventory(h);
  assert.equal(inventory.complete, true);
  const root = inventory.objects.find((item) => item.object_kind === "item")!;
  const child = inventory.objects.find((item) => item.object_kind === "subitem")!;
  assert.equal((root.mapped as any).group, "delivery");
  assert.deepEqual(child.mapped, {});
  assert.equal((child.column_text as any).kind_a, "Active");
  assert.deepEqual((child.provider_payload as any).columns.owners_a.personsAndTeams, [{ id: 1001, kind: "person" }]);
  assert.ok(inventory.objects.filter((item) => item.object_kind !== "item").every((item) => Object.keys(item.mapped as object).length === 0));
  assert.deepEqual(normalizeRecordObject({ instanceId: h.binding.instance_id, source, raw: child, observedAt: inventory.observed_at, identities }).values, {});
});
