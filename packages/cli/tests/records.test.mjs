import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { MondayClient } from "../../connectors/monday/client.ts";
import { MondayRecordSourceConnector } from "../../connectors/monday/records-source.ts";
import { InMemoryCompanyRecordsStore } from "../../records/memory-store.ts";
import { RecordSourceConnectorRegistry } from "../../records/source-connector.ts";
import { writeMondayAgentQualificationState } from "../src/monday-agent-qualification.mjs";
import {
  applyRecordSourceMaterialization,
  inspectRecordWorkspace,
  loadRecordSourceBinding,
  planRecordSourceMaterialization,
  planRecordSourceOperation,
  runRecordSourceOperation,
} from "../src/records-operations.mjs";

const REPO = new URL("../../..", import.meta.url).pathname;

const temporaryWorkspace = () => {
  const root = mkdtempSync(join(tmpdir(), "companyos-records-cli-"));
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "connections"), { recursive: true });
  mkdirSync(join(workspace, "schedules"), { recursive: true });
  mkdirSync(join(workspace, "records", "sources"), { recursive: true });
  mkdirSync(join(workspace, "records", "projections"), { recursive: true });
  writeFileSync(join(workspace, "company.md"), "---\nname: Fixture Company\n---\n");
  writeFileSync(join(workspace, "connections", "monday.md"), "---\ntype: concept\n---\nFixture connection.\n");
  writeFileSync(join(workspace, "schedules", "daily.md"), "---\ntype: concept\n---\nFixture schedule.\n");
  const source = {
    schema_version: 1,
    id: "fixture-items",
    record_type: "work-item",
    connection: "connections/monday.md",
    resource_binding: "fixture-board",
    delivery: "poll",
    reconcile_schedule: "schedules/daily.md",
    identity: { source_field: "id" },
    fields: [
      { target: "title", source: "name", value_type: "string", required: true },
      { target: "status", source: "column_text.status_col", value_type: "status" },
    ],
    access: { read_groups: ["delivery"], write_roles: [] },
  };
  const projection = {
    schema_version: 1,
    id: "fixture-active-items",
    record_type: "work-item",
    fields: [{ name: "title", path: "title" }, { name: "status", path: "status" }],
    freshness: { max_age_minutes: 60 },
    access: { read_groups: ["delivery"] },
    materialization: { mode: "database-view" },
  };
  writeFileSync(join(workspace, "records", "projections", "items.yaml"), YAML.stringify(projection));
  return { root, workspace, source, projection };
};

const writeBinding = (root, overrides = {}) => {
  const path = join(root, "binding.yaml");
  const qualificationPath = join(root, "qualification.json");
  writeFileSync(qualificationPath, `${JSON.stringify({ kind: "fixture-qualification", phase: "complete" }, null, 2)}\n`);
  const binding = {
    schema_version: 1,
    instance_id: "fixture-production",
    source_id: "fixture-items",
    resource_binding: "fixture-board",
    connector: "fixture/record-source",
    connector_version: "1.0.0",
    secret_ref: "env:FIXTURE_PROVIDER_TOKEN",
    qualification: { receipt_ref: "qualification.json", digest: "b".repeat(64) },
    configuration: { board_id: "100001" },
    ...overrides,
  };
  writeFileSync(path, YAML.stringify(binding));
  return { path, binding, qualificationPath };
};

test("records inspection reports only validated Workspace declarations", () => {
  const fixture = temporaryWorkspace();
  try {
    writeFileSync(join(fixture.workspace, "records", "sources", "items.yaml"), YAML.stringify(fixture.source));
    const result = inspectRecordWorkspace({ workspaceRoot: fixture.workspace, sourceId: "fixture-items" });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.sources[0].id, "fixture-items");
    assert.equal(result.projections[0].id, "fixture-active-items");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("records inspection rejects projection paths absent from the selected source", () => {
  const fixture = temporaryWorkspace();
  try {
    writeFileSync(join(fixture.workspace, "records", "sources", "items.yaml"), YAML.stringify(fixture.source));
    const projectionPath = join(fixture.workspace, "records", "projections", "items.yaml");
    const projection = YAML.parse(readFileSync(projectionPath, "utf8"));
    projection.selection = { source_id: "fixture-items" };
    projection.fields.push({ name: "actual_hours", path: "actual_hours" });
    writeFileSync(projectionPath, YAML.stringify(projection));
    const result = inspectRecordWorkspace({ workspaceRoot: fixture.workspace, sourceId: "fixture-items" });
    assert.equal(result.diagnostics.some((entry) => entry.code === "WS055" && entry.message.includes("actual_hours")), true);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("the CLI exposes provider-neutral source and projection inspection", () => {
  const fixture = temporaryWorkspace();
  try {
    writeFileSync(join(fixture.workspace, "records", "sources", "items.yaml"), YAML.stringify(fixture.source));
    const source = spawnSync("node", [join(REPO, "packages/cli/src/cli.mjs"), "records", "source", "inspect", "--workspace", fixture.workspace, "--source", "fixture-items", "--format", "json"], { encoding: "utf8" });
    assert.equal(source.status, 0, source.stderr);
    assert.equal(JSON.parse(source.stdout).sources[0].id, "fixture-items");
    const projection = spawnSync("node", [join(REPO, "packages/cli/src/cli.mjs"), "records", "projection", "inspect", "--workspace", fixture.workspace, "--projection", "fixture-active-items", "--format", "json"], { encoding: "utf8" });
    assert.equal(projection.status, 0, projection.stderr);
    assert.equal(JSON.parse(projection.stdout).projections[0].id, "fixture-active-items");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("materialization requires qualified fields and an exact confirmation hash", () => {
  const fixture = temporaryWorkspace();
  try {
    const draft = join(fixture.root, "source-draft.yaml");
    const qualification = join(fixture.root, "qualification.json");
    const output = join(fixture.workspace, "records", "sources", "items.yaml");
    writeFileSync(draft, YAML.stringify(fixture.source));
    writeMondayAgentQualificationState(qualification, {
      schema_version: 1,
      kind: "monday-external-agent-qualification",
      phase: "complete",
      workspace: fixture.workspace,
      evidence: {
        discovery: {
          discovery_hash: "a".repeat(64),
          authentication_mode: "external-agent",
          identity: { externalAgentId: "700001" },
          resources: [{ id: "100001", scope: "board", permission: "read" }],
          boards: [{ id: "100001", columns: [{ id: "status_col", title: "Status" }] }],
          credentials_retained: false,
        },
      },
    });
    const planned = planRecordSourceMaterialization({
      workspaceRoot: fixture.workspace,
      provider: "monday",
      qualificationPath: qualification,
      boardId: "100001",
      declarationPath: draft,
      outputPath: output,
    });
    assert.deepEqual(planned.diagnostics, []);
    assert.equal(applyRecordSourceMaterialization({ planResult: planned, confirmationHash: "wrong" }).applied, false);
    const applied = applyRecordSourceMaterialization({ planResult: planned, confirmationHash: planned.plan.confirmation_hash });
    assert.equal(applied.applied, true);
    assert.deepEqual(YAML.parse(readFileSync(output, "utf8")), fixture.source);
    assert.deepEqual(applied.evidence.provider_effects, []);
    assert.deepEqual(applied.evidence.database_effects, []);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("Instance bindings reject inline credential-shaped fields", () => {
  const fixture = temporaryWorkspace();
  try {
    const { path } = writeBinding(fixture.root, { configuration: { board_id: "100001", access_token: "not-allowed" } });
    assert.throws(() => loadRecordSourceBinding(path), /Invalid Company Records source binding/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("sync and reconcile reuse one provider-neutral Connector and preserve absence semantics", async () => {
  const fixture = temporaryWorkspace();
  try {
    writeFileSync(join(fixture.workspace, "records", "sources", "items.yaml"), YAML.stringify(fixture.source));
    const { path: bindingPath } = writeBinding(fixture.root);
    const connector = {
      id: "fixture/record-source",
      version: "1.0.0",
      validateBinding({ qualification }) { assert.equal(qualification.kind, "fixture-qualification"); },
      inventory: [
        { id: "item-1", name: "First", column_text: { status_col: "Working" } },
        { id: "item-2", name: "Second", column_text: { status_col: "Done" } },
      ],
      async readCompleteInventory() {
        return {
          complete: true,
          observed_at: "2030-02-01T10:00:00.000Z",
          objects: structuredClone(this.inventory),
          watermark: `fixture:${this.inventory.map((item) => item.id).join(",")}`,
          receipt: { connector: this.id, inventory_digest: "fixture-digest", complete: true, credentials_retained: false },
        };
      },
    };
    const connectorRegistry = new RecordSourceConnectorRegistry([connector]);
    const coreIdentity = { repository: "example/core", ref: "a".repeat(40), core_version: "0.5.12", workbench_version: "0.1.0-experimental.15", clean: true };
    const syncPlan = planRecordSourceOperation({ workspaceRoot: fixture.workspace, sourceId: fixture.source.id, bindingPath, operation: "sync", coreIdentity, connectorRegistry });
    assert.deepEqual(syncPlan.diagnostics, []);
    assert.doesNotMatch(JSON.stringify(syncPlan.plan), /fixture-provider-value|DATABASE_URL=/);
    let invoked = false;
    const guardedRegistry = new RecordSourceConnectorRegistry([{
      ...connector,
      async readCompleteInventory(args) { invoked = true; return connector.readCompleteInventory(args); },
    }]);
    const store = new InMemoryCompanyRecordsStore();
    const rejected = await runRecordSourceOperation({ planResult: syncPlan, confirmationHash: "wrong", connectorRegistry: guardedRegistry, store });
    assert.equal(rejected.applied, false);
    assert.equal(invoked, false);
    const synced = await runRecordSourceOperation({ planResult: syncPlan, confirmationHash: syncPlan.plan.confirmation_hash, connectorRegistry, store, now: () => new Date("2030-02-01T10:00:00.000Z") });
    assert.equal(synced.receipt.inserted, 2);
    assert.equal((await store.getCurrentObjectVersion("fixture-production", "fixture-items", "item-2"))?.deleted, false);

    connector.inventory = [{ id: "item-1", name: "First", column_text: { status_col: "Done" } }];
    const reconcilePlan = planRecordSourceOperation({ workspaceRoot: fixture.workspace, sourceId: fixture.source.id, bindingPath, operation: "reconcile", coreIdentity, connectorRegistry });
    const reconciled = await runRecordSourceOperation({ planResult: reconcilePlan, confirmationHash: reconcilePlan.plan.confirmation_hash, connectorRegistry, store, now: () => new Date("2030-02-01T11:00:00.000Z") });
    assert.equal(reconciled.receipt.missing_from_provider, 1);
    assert.equal((await store.getCurrentObjectVersion("fixture-production", "fixture-items", "item-2"))?.deleted, true);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("the maintained Monday source adapter uses bounded complete pagination and emits payload-free evidence", async () => {
  const requests = [];
  const response = (data, requestId) => new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "api-version": "dev", "x-request-id": requestId },
  });
  const queue = [
    response({ boards: [{ id: "100001", items_page: { cursor: "cursor-2", items: [
      { id: "item-2", name: "Excluded", updated_at: "2030-02-01T09:00:00Z", board: { id: "100001" }, group: { id: "other" }, column_values: [{ id: "status_col", text: "Done", value: "{\"index\":1}" }] },
      { id: "item-1", name: "Included", updated_at: "2030-02-01T09:30:00Z", board: { id: "100001" }, group: { id: "ready" }, column_values: [{ id: "status_col", text: "Working", value: "{\"index\":2}" }] },
    ] } }] }, "request-1"),
    response({ next_items_page: { cursor: null, items: [
      { id: "item-3", name: "Included later", updated_at: "2030-02-01T09:45:00Z", board: { id: "100001" }, group: { id: "ready" }, column_values: [{ id: "status_col", text: "Done", value: null }] },
    ] } }, "request-2"),
  ];
  const fetcher = async (_input, init) => {
    requests.push({ headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return queue.shift();
  };
  const connector = new MondayRecordSourceConnector({
    resolveSecret: (ref) => {
      assert.equal(ref, "env:FIXTURE_PROVIDER_TOKEN");
      return "fixture-provider-value";
    },
    fetcher,
    now: () => new Date("2030-02-01T10:00:00.000Z"),
  });
  const source = {
    schema_version: 1,
    id: "fixture-items",
    record_type: "work-item",
    connection: "connections/monday.md",
    resource_binding: "fixture-board",
    delivery: "poll",
    identity: { source_field: "id" },
    fields: [{ target: "status", source: "column_text.status_col", value_type: "status" }],
    access: { read_groups: ["delivery"], write_roles: [] },
  };
  const inventory = await connector.readCompleteInventory({
    source,
    binding: {
      schema_version: 1,
      instance_id: "fixture-production",
      source_id: "fixture-items",
      resource_binding: "fixture-board",
      connector: "oregano/monday-record-source",
      connector_version: "0.3.0",
      secret_ref: "env:FIXTURE_PROVIDER_TOKEN",
      qualification: { receipt_ref: "qualification.json", digest: "c".repeat(64) },
      configuration: { api_version: "dev", agent_id: "700001", board_id: "100001", permission: "read", group_ids: ["ready"], page_size: 2, max_pages: 5 },
    },
    qualification: {
      kind: "monday-external-agent-qualification",
      phase: "complete",
      evidence: {
        discovery: {
          discovery_hash: "c".repeat(64),
          credentials_retained: false,
          authentication_mode: "external-agent",
          configured_agent_id: "700001",
          identity_mapping_status: "administrator-confirmed",
          identity: { externalAgentId: "800001" },
          resources: [{ id: "100001", scope: "board", permission: "read" }],
          boards: [{
            id: "100001",
            groups: [{ id: "ready", archived: false, deleted: false }],
            columns: [{ id: "status_col", archived: false }],
          }],
        },
      },
    },
  });
  assert.deepEqual(inventory.objects.map((item) => item.id), ["item-1", "item-3"]);
  assert.equal(inventory.receipt.pages, 2);
  assert.deepEqual(inventory.receipt.request_ids, ["request-1", "request-2"]);
  assert.ok(requests.every((request) => request.headers.get("authorization") === "fixture-provider-value"));
  assert.doesNotMatch(JSON.stringify(inventory.receipt), /fixture-provider-value|Included/);
});

test("the maintained Monday source adapter mirrors a complete table surface without widening projections", async () => {
  const requests = [];
  const response = (data, requestId) => new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "api-version": "dev", "x-request-id": requestId },
  });
  const queue = [
    response({ boards: [{
      id: "100001", name: "Synthetic Sprint", board_kind: "public", state: "active",
      groups: [{ id: "backlog", title: "Backlog", archived: false, deleted: false }],
      columns: [
        { id: "name", title: "Name", type: "name", archived: false, revision: "r1", settings: {} },
        { id: "status_col", title: "Status", type: "status", archived: false, revision: "r2", settings: { labels: { 1: "Done" } } },
        { id: "subtasks", title: "Subitems", type: "subtasks", archived: false, revision: "r3", settings: { boardIds: [100002] } },
      ],
      items_page: { cursor: null, items: [{
        id: "item-1", name: "Parent", updated_at: "2030-02-01T09:00:00Z", created_at: "2030-01-01T09:00:00Z",
        state: "active", url: "https://example.invalid/item-1", board: { id: "100001" }, group: { id: "backlog" },
        column_values: [{ id: "status_col", text: "Working", value: "{\"index\":2}" }],
        subitems: [{
          id: "subitem-1", name: "Child", updated_at: "2030-02-01T09:10:00Z", created_at: "2030-01-02T09:00:00Z",
          state: "active", url: "https://example.invalid/subitem-1", board: { id: "100002" }, group: { id: "subitems" },
          parent_item: { id: "item-1" }, column_values: [{ id: "hours", text: "3", value: "3" }], subitems: [],
        }],
      }] },
    }] }, "request-root"),
    response({ boards: [{
      id: "100002", name: "Synthetic Sprint Subitems", board_kind: "public", state: "active",
      groups: [{ id: "subitems", title: "Subitems", archived: false, deleted: false }],
      columns: [{ id: "hours", title: "Hours", type: "numbers", archived: false, revision: "s1", settings: {} }],
    }] }, "request-child"),
  ];
  const connector = new MondayRecordSourceConnector({
    resolveSecret: () => "fixture-provider-value",
    fetcher: async (_input, init) => {
      requests.push(JSON.parse(String(init.body)));
      return queue.shift();
    },
    now: () => new Date("2030-02-01T10:00:00.000Z"),
  });
  const source = {
    schema_version: 1,
    id: "fixture-table",
    record_type: "work-item",
    connection: "connections/monday.md",
    resource_binding: "fixture-board",
    delivery: "hybrid",
    identity: { source_field: "id" },
    fields: [
      { target: "object_kind", source: "object_kind", value_type: "string", required: true },
      { target: "provider_id", source: "provider_id", value_type: "string", required: true },
      { target: "provider_payload", source: "provider_payload", value_type: "json", required: true },
    ],
    access: { read_groups: ["delivery"], write_roles: [] },
  };
  const inventory = await connector.readCompleteInventory({
    source,
    binding: {
      schema_version: 1,
      instance_id: "fixture-production",
      source_id: "fixture-table",
      resource_binding: "fixture-board",
      connector: "oregano/monday-record-source",
      connector_version: "0.3.0",
      secret_ref: "env:FIXTURE_PROVIDER_TOKEN",
      qualification: { receipt_ref: "qualification.json", digest: "d".repeat(64) },
      configuration: {
        api_version: "dev", agent_id: "700001", board_id: "100001", permission: "read-write",
        inventory_mode: "complete-table", page_size: 100, max_pages: 5, max_objects: 100,
      },
    },
    qualification: {
      kind: "monday-external-agent-qualification",
      phase: "complete",
      evidence: { discovery: {
        discovery_hash: "d".repeat(64), credentials_retained: false, authentication_mode: "external-agent",
        configured_agent_id: "700001", identity_mapping_status: "administrator-confirmed",
        identity: { externalAgentId: "800001" },
        resources: [{ id: "100001", scope: "board", permission: "read-write" }],
        boards: [{ id: "100001", groups: [{ id: "backlog", archived: false, deleted: false }], columns: [
          { id: "name", archived: false }, { id: "status_col", archived: false },
          { id: "subtasks", type: "subtasks", archived: false, settings: { boardIds: [100002] } },
        ] }],
      } },
    },
  });
  assert.deepEqual(inventory.objects.map((object) => object.object_kind).sort(), [
    "board", "board", "column", "column", "column", "column", "group", "group", "item", "subitem",
  ]);
  assert.equal(inventory.objects.find((object) => object.id === "item:item-1").provider_payload.columns.status_col.index, 2);
  assert.equal(inventory.objects.find((object) => object.id === "subitem:subitem-1").provider_payload.columns.hours, 3);
  assert.deepEqual(inventory.receipt.object_counts, { board: 2, group: 2, column: 4, item: 1, subitem: 1 });
  assert.deepEqual(inventory.receipt.schema_coverage, [
    { board_id: "100001", columns: [
      { id: "name", title: "Name", type: "name" },
      { id: "status_col", title: "Status", type: "status" },
      { id: "subtasks", title: "Subitems", type: "subtasks" },
    ] },
    { board_id: "100002", columns: [{ id: "hours", title: "Hours", type: "numbers" }] },
  ]);
  assert.deepEqual(inventory.receipt.request_ids, ["request-root", "request-child"]);
  assert.equal(requests[0].query.includes("updates"), false);
  assert.equal(requests[0].query.includes("assets"), false);
  assert.doesNotMatch(JSON.stringify(inventory.receipt), /Parent|Child|Working|fixture-provider-value/);
});

test("complete-table inventory fails closed on filters and deeper subitems", async () => {
  let invoked = false;
  const filtered = new MondayClient({
    token: "fixture-provider-value",
    apiVersion: "dev",
    fetcher: async () => { invoked = true; throw new Error("unexpected provider call"); },
  });
  await assert.rejects(filtered.readCompleteRecordInventory({
    boardId: "100001", columnIds: [], groupIds: ["backlog"], inventoryMode: "complete-table",
  }), /cannot use group filters/);
  assert.equal(invoked, false);

  const response = new Response(JSON.stringify({ data: { boards: [{
    id: "100001", name: "Synthetic Sprint", board_kind: "public", state: "active", groups: [], columns: [],
    items_page: { cursor: null, items: [{
      id: "item-1", name: "Parent", updated_at: "2030-02-01T09:00:00Z", board: { id: "100001" }, group: { id: "backlog" },
      column_values: [], subitems: [{
        id: "subitem-1", name: "Child", updated_at: "2030-02-01T09:10:00Z", board: { id: "100002" }, group: { id: "subitems" },
        parent_item: { id: "item-1" }, column_values: [], subitems: [{ id: "subitem-2" }],
      }],
    }] },
  }] } }), { status: 200, headers: { "api-version": "dev" } });
  const nested = new MondayClient({ token: "fixture-provider-value", apiVersion: "dev", fetcher: async () => response });
  await assert.rejects(nested.readCompleteRecordInventory({
    boardId: "100001", columnIds: [], inventoryMode: "complete-table", allowedSubitemBoardIds: ["100002"],
  }), /supports exactly one subitem level/);
});
