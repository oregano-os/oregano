import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { CORE_CAPABILITY_CATALOG } from "../../capabilities/catalog.ts";
import { CapabilityEffectOutcomeUnknownError } from "../../capabilities/contracts.ts";
import { CompanyRecordsConnector } from "../../connectors/company-records.ts";
import { MondayClient } from "../../connectors/monday/client.ts";
import { MondayWorkItemConnector } from "../../connectors/monday/connector.ts";
import { InMemoryMondayEchoStore } from "../../connectors/monday/echo-guard.ts";
import { classifyMondayBoardEventEcho, InMemoryMondayReplayStore, normalizeMondayBoardEvent, routeMondayAgentCallback } from "../../connectors/monday/webhook.ts";
import { ConnectorRegistry } from "../../connectors/registry.ts";
import type { CompanyRecordProjectionDeclaration } from "../../records/contracts.ts";
import { InMemoryCompanyRecordsStore } from "../../records/memory-store.ts";
import { CompanyRecordsRegistry } from "../../records/registry.ts";
import { CompanyRecordsService } from "../../records/service.ts";
import { STANDARD_RECORDS_TOOLS } from "../../standard-tools/records.ts";
import { STANDARD_WORK_ITEM_TOOLS } from "../../standard-tools/work-items.ts";

const response = (data: unknown, apiVersion = "dev"): Response => new Response(JSON.stringify({ data }), {
  status: 200,
  headers: { "content-type": "application/json", "api-version": apiVersion, "x-request-id": "request-fixture" },
});

const item = (version: string, status: string) => ({
  items: [{
    id: "item-1", name: "Prepare launch", updated_at: version,
    board: { id: "board-1" }, group: { id: "current" },
    column_values: [{ id: "status_col", text: status, value: JSON.stringify({ label: status }) }],
  }],
});

const identifiedItem = (id: string, version: string, status = "Working") => ({
  items: [{
    id, name: `Item ${id}`, updated_at: version,
    board: { id: "board-1" }, group: { id: "current" },
    column_values: [{ id: "status_col", text: status, value: JSON.stringify({ label: status }) }],
  }],
});

test("the Monday Connector uses explicit versioning, exact board scope, optimistic concurrency, and read-after-write", async () => {
  const queue = [response(item("v1", "Working")), response({ change_multiple_column_values: { id: "item-1" } }), response(item("v2", "Done"))];
  const requests: Array<{ headers: Headers; body: any }> = [];
  const fetcher = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const next = queue.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  };
  const echoStore = new InMemoryMondayEchoStore();
  const connector = new MondayWorkItemConnector({
    client: new MondayClient({ token: "fixture-secret-not-evidence", apiVersion: "dev", fetcher }),
    bindings: [{ id: "sprint-board", boardId: "board-1", permission: "read-write", fields: { status: "status_col" } }],
    actorId: "agent-1",
    instanceId: "fixture-instance",
    echoStore,
    now: () => new Date("2030-02-01T10:00:00.000Z"),
  });
  const registry = new ConnectorRegistry({
    contracts: CORE_CAPABILITY_CATALOG,
    connectors: [connector],
    bindings: [{ capability: "work-item.update", contractVersion: "1.0.0", connector: connector.id, connectorVersion: connector.version }],
  });
  const result = await registry.invoke("work-item.update", {
    resource_binding: "sprint-board", work_item_id: "item-1", changes: { status: { label: "Done" } }, expected_version: "v1",
  }, { instanceId: "fixture-instance", runId: "run-1", stepId: "update", agentId: "sprint-agent", toolId: "work-item-update", idempotencyKey: "effect-1" });
  assert.equal((result.output as any).provider_version, "v2");
  assert.deepEqual((result.output as any).changed_fields, ["status"]);
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.headers.get("api-version") === "dev"));
  assert.ok(requests.every((request) => request.headers.get("authorization") === "fixture-secret-not-evidence"));
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret-not-evidence/);
  assert.equal(requests[1].body.variables.boardId, "board-1");
  assert.deepEqual(JSON.parse(requests[1].body.variables.values), { status_col: { label: "Done" } });
  const echo = await echoStore.consumeMatch({ instanceId: "fixture-instance", resourceBinding: "sprint-board", workItemId: "item-1", providerVersion: "v2", actorId: "agent-1", now: "2030-02-01T10:01:00.000Z" });
  assert.equal(echo?.idempotencyKey, "effect-1");
});

test("Monday resource discovery returns only exact board structure in requested order", async () => {
  const requests: Array<{ body: any; headers: Headers }> = [];
  const fetcher = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return response({
      me: { id: "member-1", name: "Fixture Member", account: { id: "account-1", name: "Fixture Account" } },
      boards: [
        { id: "200002", name: "Roles", board_kind: "private", state: "active", permissions: "view", access_level: "view", workspace: null, groups: [{ id: "hq", title: "Headquarters", archived: false, deleted: false }], columns: [{ id: "people", title: "People", type: "people", archived: false, revision: "rev-2", settings: null }] },
        { id: "200001", name: "Sprint", board_kind: "private", state: "active", permissions: "edit", access_level: "edit", workspace: { id: "workspace-1", name: "Tests" }, groups: [{ id: "ready", title: "Ready", archived: false, deleted: false }], columns: [{ id: "status", title: "Status", type: "status", archived: false, revision: "rev-1", settings: {} }] },
      ],
    }, "dev");
  };
  const client = new MondayClient({ token: "fixture-memory-token", apiVersion: "dev", fetcher });
  const result = await client.discoverResources(["200001", "200002"]);
  assert.deepEqual(result.data.boards.map((board) => board.id), ["200001", "200002"]);
  assert.equal(result.data.boards[0].columns[0].revision, "rev-1");
  assert.deepEqual(requests[0].body.variables.boardIds, ["200001", "200002"]);
  assert.doesNotMatch(requests[0].body.query, /items|updates|column_values/);
  assert.equal(requests[0].headers.get("api-version"), "dev");
});

test("Monday record inventory normalizes populated and empty People columns while retaining raw provider evidence", async () => {
  const fetcher = async (): Promise<Response> => response({
    boards: [{
      id: "200002",
      name: "Roles",
      board_kind: "private",
      state: "active",
      groups: [{ id: "hq", title: "Headquarters", archived: false, deleted: false }],
      columns: [{ id: "people", title: "People", type: "people", archived: false, revision: "rev-2", settings: null }],
      items_page: {
        cursor: null,
        items: [{
          id: "item-1",
          name: "Head of Operations",
          updated_at: "2030-02-01T10:00:00.000Z",
          created_at: "2030-01-01T10:00:00.000Z",
          state: "active",
          url: "https://example.test/item-1",
          board: { id: "200002" },
          group: { id: "hq" },
          column_values: [{
            id: "people",
            text: "Alex Example, Sam Example",
            value: JSON.stringify({ personsAndTeams: [{ id: 1001, kind: "person" }, { id: "1002", kind: "person" }, { id: 1001, kind: "person" }] }),
          }],
        }, {
          id: "item-2",
          name: "Unassigned role",
          updated_at: "2030-02-01T10:00:00.000Z",
          created_at: "2030-01-01T10:00:00.000Z",
          state: "active",
          url: "https://example.test/item-2",
          board: { id: "200002" },
          group: { id: "hq" },
          column_values: [{ id: "people", text: "", value: null }],
        }],
      },
    }],
  });
  const client = new MondayClient({ token: "fixture-memory-token", apiVersion: "dev", fetcher });
  const result = await client.readCompleteRecordInventory({ boardId: "200002", columnIds: ["people"], groupIds: ["hq"] });
  assert.deepEqual(result.objects[0].columns.people, ["1001", "1002"]);
  assert.equal(result.objects[0].column_text.people, "Alex Example, Sam Example");
  assert.deepEqual((result.objects[0].provider_payload.columns as any).people.personsAndTeams[0], { id: 1001, kind: "person" });
  assert.deepEqual(result.objects[1].columns.people, []);
  assert.equal(result.objects[1].column_text.people, "");
  assert.equal((result.objects[1].provider_payload.columns as any).people, "");
});

test("the Monday Connector refuses stale versions, unknown fields, read-only effects, and missing claims", async () => {
  const fetcher = async (): Promise<Response> => response(item("v2", "Working"));
  const connector = new MondayWorkItemConnector({
    client: new MondayClient({ token: "fixture-token", apiVersion: "dev", fetcher }),
    bindings: [{ id: "read-only-board", boardId: "board-1", permission: "read", fields: { status: "status_col" } }],
    actorId: "agent-1", instanceId: "fixture-instance", echoStore: new InMemoryMondayEchoStore(),
  });
  await assert.rejects(() => connector.invoke("work-item.update", { resource_binding: "read-only-board", work_item_id: "item-1", changes: { status: "Done" }, expected_version: "v1" },
    { instanceId: "fixture-instance", runId: "run", stepId: "step", agentId: "agent", toolId: "tool", idempotencyKey: "effect" }), /changed since expected version/);
  await assert.rejects(() => connector.invoke("work-item.update", { resource_binding: "read-only-board", work_item_id: "item-1", changes: { private_field: "x" }, expected_version: "v2" },
    { instanceId: "fixture-instance", runId: "run", stepId: "step", agentId: "agent", toolId: "tool", idempotencyKey: "effect" }), /read-only|does not allow/);
  await assert.rejects(() => connector.invoke("work-item.comment", { resource_binding: "read-only-board", work_item_id: "item-1", body: "Hello" },
    { instanceId: "fixture-instance", runId: "run", stepId: "step", agentId: "agent", toolId: "tool" }), /idempotency key/);
});

test("the Monday Connector preflights and verifies one frozen batch before reporting success", async () => {
  const queue = [
    response(identifiedItem("item-1", "v1")), response(identifiedItem("item-2", "v1")),
    response({ change_multiple_column_values: { id: "item-1" } }), response(identifiedItem("item-1", "v2", "Planned")),
    response({ change_multiple_column_values: { id: "item-2" } }), response(identifiedItem("item-2", "v2", "Planned")),
  ];
  const requests: any[] = [];
  const connector = new MondayWorkItemConnector({
    client: new MondayClient({ token: "fixture-token", apiVersion: "dev", fetcher: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const next = queue.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    } }),
    bindings: [{ id: "sprint-board", boardId: "board-1", permission: "read-write", fields: { status: "status_col" } }],
    actorId: "agent-1", instanceId: "fixture-instance", echoStore: new InMemoryMondayEchoStore(),
  });
  const result = await connector.invoke("work-item.batch-update", {
    resource_binding: "sprint-board",
    updates: [
      { work_item_id: "item-1", expected_version: "v1", changes: { status: { label: "Planned" } } },
      { work_item_id: "item-2", expected_version: "v1", changes: { status: { label: "Planned" } } },
    ],
  }, { instanceId: "fixture-instance", runId: "run-batch", stepId: "rollover", agentId: "sprint", toolId: "batch", idempotencyKey: "batch-1" });
  assert.equal((result.output as any).complete, true);
  assert.deepEqual((result.output as any).results.map((entry: any) => entry.provider_version), ["v2", "v2"]);
  assert.equal(requests.filter((request) => String(request.query).includes("change_multiple_column_values")).length, 2);
});

test("the Monday Connector performs zero batch writes when any preflight version is stale", async () => {
  const queue = [response(identifiedItem("item-1", "v1")), response(identifiedItem("item-2", "v2"))];
  const requests: any[] = [];
  const connector = new MondayWorkItemConnector({
    client: new MondayClient({ token: "fixture-token", apiVersion: "dev", fetcher: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return queue.shift()!;
    } }),
    bindings: [{ id: "sprint-board", boardId: "board-1", permission: "read-write", fields: { status: "status_col" } }],
    actorId: "agent-1", instanceId: "fixture-instance", echoStore: new InMemoryMondayEchoStore(),
  });
  await assert.rejects(() => connector.invoke("work-item.batch-update", {
    resource_binding: "sprint-board",
    updates: [
      { work_item_id: "item-1", expected_version: "v1", changes: { status: "Planned" } },
      { work_item_id: "item-2", expected_version: "v1", changes: { status: "Planned" } },
    ],
  }, { instanceId: "fixture-instance", runId: "run-stale", stepId: "rollover", agentId: "sprint", toolId: "batch", idempotencyKey: "batch-stale" }), /item-2.*changed since expected version/);
  assert.equal(requests.filter((request) => String(request.query).includes("change_multiple_column_values")).length, 0);
});

test("the Monday Connector rejects a non-homogeneous batch before any write", async () => {
  const queue = [response(identifiedItem("item-1", "v1")), response(identifiedItem("item-2", "v1"))];
  const requests: any[] = [];
  const connector = new MondayWorkItemConnector({
    client: new MondayClient({ token: "fixture-token", apiVersion: "dev", fetcher: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return queue.shift()!;
    } }),
    bindings: [{ id: "sprint-board", boardId: "board-1", permission: "read-write", fields: { status: "status_col" } }],
    actorId: "agent-1", instanceId: "fixture-instance", echoStore: new InMemoryMondayEchoStore(),
  });
  await assert.rejects(() => connector.invoke("work-item.batch-update", {
    resource_binding: "sprint-board",
    updates: [
      { work_item_id: "item-1", expected_version: "v1", changes: { status: "Planned" } },
      { work_item_id: "item-2", expected_version: "v1", changes: { status: "Ready" } },
    ],
  }, { instanceId: "fixture-instance", runId: "run-mixed", stepId: "rollover", agentId: "sprint", toolId: "batch", idempotencyKey: "batch-mixed" }), /homogeneous frozen change set/);
  assert.equal(requests.filter((request) => String(request.query).includes("change_multiple_column_values")).length, 0);
});

test("the Monday Connector records outcome-unknown evidence after a partial batch effect", async () => {
  const queue: Array<Response | Error> = [
    response(identifiedItem("item-1", "v1")), response(identifiedItem("item-2", "v1")),
    response({ change_multiple_column_values: { id: "item-1" } }), response(identifiedItem("item-1", "v2", "Planned")),
    new Error("provider unavailable"),
  ];
  const connector = new MondayWorkItemConnector({
    client: new MondayClient({ token: "fixture-token", apiVersion: "dev", fetcher: async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next!;
    } }),
    bindings: [{ id: "sprint-board", boardId: "board-1", permission: "read-write", fields: { status: "status_col" } }],
    actorId: "agent-1", instanceId: "fixture-instance", echoStore: new InMemoryMondayEchoStore(),
  });
  await assert.rejects(() => connector.invoke("work-item.batch-update", {
    resource_binding: "sprint-board",
    updates: [
      { work_item_id: "item-1", expected_version: "v1", changes: { status: "Planned" } },
      { work_item_id: "item-2", expected_version: "v1", changes: { status: "Planned" } },
    ],
  }, { instanceId: "fixture-instance", runId: "run-partial", stepId: "rollover", agentId: "sprint", toolId: "batch", idempotencyKey: "batch-partial" }), (error: unknown) => {
    assert.ok(error instanceof CapabilityEffectOutcomeUnknownError);
    assert.deepEqual(((error as CapabilityEffectOutcomeUnknownError).evidence as any).completed, [{
      work_item_id: "item-1", previous_version: "v1", provider_version: "v2", changed_fields: ["status"],
    }]);
    return true;
  });
});

test("signed Monday agent callbacks reject tampering and replay before AgentResolver routing", async () => {
  const now = 1_782_326_623_754;
  const rawBody = JSON.stringify({ event: "agent_triggered", triggerType: "mention", payload: { boardId: "board-1", itemId: "item-1", text: "status?" } });
  const signingSecret = "fixture-signing-secret";
  const signature = `sha256=${createHmac("sha256", signingSecret).update(`${now}.${rawBody}`).digest("hex")}`;
  const args = {
    rawBody,
    headers: { "x-monday-agent-id": "agent-1", "x-monday-timestamp": String(now), "x-monday-signature": signature },
    signingSecret,
    now,
    replayStore: new InMemoryMondayReplayStore(),
    accountId: "account-1",
    routing: { bindings: [{ id: "sprint-board-route", agentId: "sprint-agent", surface: "monday", accountId: "account-1", channelId: "board:board-1" }] },
    agentIds: ["sprint-agent", "support-agent"],
  };
  const routed = await routeMondayAgentCallback(args);
  assert.equal(routed.resolution.agentId, "sprint-agent");
  assert.equal(routed.resolution.reason, "binding");
  await assert.rejects(() => routeMondayAgentCallback(args), /replay/);
  await assert.rejects(() => routeMondayAgentCallback({ ...args, replayStore: new InMemoryMondayReplayStore(), rawBody: rawBody + " " }), /signature/);
});

test("non-conversational Monday board events normalize directly without an Agent route", () => {
  assert.deepEqual(normalizeMondayBoardEvent({ eventId: "event-1", boardId: "board-1", workItemId: "item-1", actorId: "member-1", providerVersion: "v3" }), {
    eventId: "event-1", boardId: "board-1", workItemId: "item-1", actorId: "member-1", providerVersion: "v3",
  });
});

test("self-authored Monday events are suppressed once by durable echo evidence", async () => {
  const echoStore = new InMemoryMondayEchoStore();
  await echoStore.remember({ instanceId: "fixture-instance", resourceBinding: "sprint-board", workItemId: "item-1", providerVersion: "v3", actorId: "agent-1", idempotencyKey: "effect-1", expiresAt: "2030-02-01T10:10:00.000Z" });
  const input = { eventId: "event-1", boardId: "board-1", workItemId: "item-1", actorId: "agent-1", providerVersion: "v3" };
  const first = await classifyMondayBoardEventEcho({ value: input, instanceId: "fixture-instance", resourceBinding: "sprint-board", now: "2030-02-01T10:00:00.000Z", echoStore });
  const second = await classifyMondayBoardEventEcho({ value: input, instanceId: "fixture-instance", resourceBinding: "sprint-board", now: "2030-02-01T10:00:01.000Z", echoStore });
  assert.equal(first.suppressed, true);
  assert.equal(first.receipt?.idempotencyKey, "effect-1");
  assert.equal(second.suppressed, false);
});

test("Company Records and work-item standard Tools expose only provider-neutral Capability calls", async () => {
  assert.deepEqual(STANDARD_RECORDS_TOOLS.map((tool) => tool.contract.grantId), ["oregano:records/query"]);
  assert.deepEqual(STANDARD_WORK_ITEM_TOOLS.map((tool) => tool.contract.grantId), [
    "oregano:work-items/read",
    "oregano:work-items/update",
    "oregano:work-items/confirmed-update",
    "oregano:work-items/comment",
    "oregano:work-items/batch-update",
  ]);
  for (const tool of [...STANDARD_RECORDS_TOOLS, ...STANDARD_WORK_ITEM_TOOLS]) {
    assert.match(tool.compiledSource, /context\.capabilities\.call/);
    assert.doesNotMatch(tool.compiledSource, /monday|fetch|process\.env/i);
  }

  const projection: CompanyRecordProjectionDeclaration = {
    schema_version: 1, id: "participants", record_type: "person-role", fields: [{ name: "name", path: "name" }],
    freshness: { max_age_minutes: 60 }, access: { read_groups: ["delivery"] }, materialization: { mode: "database-view" },
  };
  const recordsRegistry = new CompanyRecordsRegistry();
  recordsRegistry.registerProjection(projection);
  const service = new CompanyRecordsService({ instanceId: "fixture-instance", registry: recordsRegistry, store: new InMemoryCompanyRecordsStore(), now: () => new Date("2030-02-01T10:00:00.000Z") });
  const connector = new CompanyRecordsConnector(service);
  const registry = new ConnectorRegistry({ contracts: CORE_CAPABILITY_CATALOG, connectors: [connector], bindings: [{ capability: "records.query", contractVersion: "2.0.0", connector: connector.id, connectorVersion: connector.version }] });
  const result = await registry.invoke("records.query", { projection_id: "participants" }, {
    instanceId: "fixture-instance", runId: "run", stepId: "read", agentId: "sprint-agent", toolId: "records-query",
    subject: { principalId: "human:member-1", principalType: "human", status: "active", groupIds: ["delivery"] },
  });
  assert.equal((result.output as any).projection_id, "participants");
});
