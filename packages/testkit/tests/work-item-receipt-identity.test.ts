import assert from "node:assert/strict";
import { test } from "node:test";
import { CapabilityEffectOutcomeUnknownError } from "../../capabilities/contracts.ts";
import { MondayClient } from "../../connectors/monday/client.ts";
import { MondayWorkItemConnector } from "../../connectors/monday/connector.ts";
import { InMemoryMondayEchoStore } from "../../connectors/monday/echo-guard.ts";

const response = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json", "api-version": "dev" } });
const item = (id = "one", version = "v1") => ({ id, name: id, updated_at: version, board: { id: "board" }, group: { id: "current" }, column_values: [] });
const read = (id = "one", version = "v1") => response({ items: [item(id, version)] });
const binding = { id: "work-board", boardId: "board", permission: "read-write" as const, fields: { status: "status_col" } };
const context = { instanceId: "test-instance", runId: "test-run", stepId: "write", agentId: "coordinator", toolId: "update", idempotencyKey: "claimed-effect" };
const input = { resource_binding: binding.id, work_item_id: "one", expected_version: "v1", changes: { status: "Done" } };
const fixture = (queue: Array<Response | Error>) => {
  const calls: string[] = [];
  const client = new MondayClient({ token: "synthetic-token", apiVersion: "dev", fetcher: async (_url, options) => {
    calls.push(JSON.parse(String(options?.body)).query);
    const next = queue.shift(); if (next instanceof Error) throw next; if (!next) throw new Error("Unexpected synthetic request"); return next;
  } });
  const connector = new MondayWorkItemConnector({ client, actorId: "agent", instanceId: context.instanceId, bindings: [binding], echoStore: new InMemoryMondayEchoStore() });
  return { client, connector, calls };
};

test("work-item preflight rejects a wrong or ambiguous provider identity before writing", async () => {
  for (const items of [[item("another")], [item(), item("another")]]) {
    const h = fixture([response({ items })]);
    await assert.rejects(h.connector.invoke("work-item.update", input, context), /different or ambiguous/);
    assert.equal(h.calls.length, 1); assert.equal(h.calls.some((call) => call.startsWith("mutation")), false);
  }
});

test("batch mutation and readback must identify the exact item before it gains a verified receipt", async () => {
  for (const receipt of ["mutation", "readback"]) {
    const queue = [read(), read("two"), response({ change_multiple_column_values: { id: receipt === "mutation" ? "another" : "one" } })];
    if (receipt === "readback") queue.push(read("another", "v2"));
    const h = fixture(queue);
    await assert.rejects(h.connector.invoke("work-item.batch-update", { resource_binding: binding.id, updates: [
      { work_item_id: "one", expected_version: "v1", changes: { status: "Done" } },
      { work_item_id: "two", expected_version: "v1", changes: { status: "Done" } },
    ] }, context), (error: unknown) => {
      assert.ok(error instanceof CapabilityEffectOutcomeUnknownError);
      assert.deepEqual((error.evidence as any).completed, []);
      assert.deepEqual((error.evidence as any).effect_review.items, [{ item_id: "one", status: "unknown" }, { item_id: "two", status: "not-attempted" }]);
      return true;
    });
    assert.equal(h.calls.filter((call) => call.startsWith("mutation")).length, 1);
    assert.equal(queue.length, 0);
  }
});

test("single update and comment retain unknown outcomes after losing required post-write proof", async () => {
  const cases = [
    { capability: "work-item.update", input, responses: [read(), response({ change_multiple_column_values: { id: "one" } }), new Error("private-readback-failure")] },
    { capability: "work-item.comment", input: { resource_binding: binding.id, work_item_id: "one", body: "Synthetic note" }, responses: [read(), response({ create_update: null })] },
    { capability: "work-item.comment", input: { resource_binding: binding.id, work_item_id: "one", body: "Synthetic note" }, responses: [read(), response({ create_update: { id: "comment-one" } }), read("another")] },
  ];
  for (const entry of cases) {
    const h = fixture(entry.responses);
    await assert.rejects(h.connector.invoke(entry.capability, entry.input, context), (error: unknown) => {
      assert.ok(error instanceof CapabilityEffectOutcomeUnknownError);
      assert.deepEqual((error.evidence as any).effect_review.items, [{ item_id: "one", status: "unknown" }]);
      assert.equal(JSON.stringify(error.evidence).includes("private-readback-failure"), false);
      return true;
    });
    assert.equal(h.calls.filter((call) => call.startsWith("mutation")).length, 1);
  }
});

test("invalid batch fields are refused during the complete preflight before any mutation", async () => {
  const h = fixture([read(), read("two")]);
  await assert.rejects(h.connector.invoke("work-item.batch-update", { resource_binding: binding.id, updates: [
    { work_item_id: "one", expected_version: "v1", changes: { status: "Done" } },
    { work_item_id: "two", expected_version: "v1", changes: { unmapped: "Done" } },
  ] }, context), (error: unknown) => {
    assert.ok(error instanceof Error); assert.equal(error instanceof CapabilityEffectOutcomeUnknownError, false); assert.match(error.message, /allowed fields/); return true;
  });
  assert.equal(h.calls.filter((call) => call.startsWith("mutation")).length, 0);
});
