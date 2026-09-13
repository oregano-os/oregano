import assert from "node:assert/strict";
import { test } from "node:test";
import { MondayClient } from "../../connectors/monday/client.ts";
import { MondayWorkItemConnector } from "../../connectors/monday/connector.ts";
import { InMemoryMondayEchoStore } from "../../connectors/monday/echo-guard.ts";
import { CORE_CAPABILITY_CATALOG } from "../../capabilities/catalog.ts";
import { STANDARD_WORK_ITEM_TOOLS } from "../../standard-tools/work-items.ts";
import { validateJsonSchemaValue } from "../../capabilities/validation.ts";

const binding = { id: "cards", boardId: "200002", permission: "read" as const, fields: { attachment: "files" } };
const context = { instanceId: "fixture", runId: "read", stepId: "read", agentId: "agent", toolId: "read" };
const update = (id: string, body = "A saved note") => ({ id, item_id: "300003", body });
function fixture(pages: any[][] = [[]], mutate?: (item: any, page: number) => void) {
  const calls: any[] = [];
  const client = new MondayClient({ token: "synthetic", apiVersion: "dev", fetcher: async (_, init) => {
    const request = JSON.parse(String(init?.body)); calls.push(request);
    const item = { id: "300003", board: { id: binding.boardId }, name: "Card", updated_at: "v1", group: { id: "group" },
      column_values: [{ id: "files", value: '{"files":[{"assetId":42,"name":"brief.pdf"}]}', text: "brief.pdf" }],
      updates: pages[request.variables.page - 1] ?? [] };
    if (request.variables.page) mutate?.(item, request.variables.page);
    return new Response(JSON.stringify({ data: { items: [item] } }), { headers: { "x-request-id": `receipt-${calls.length}` } });
  } });
  const connector = new MondayWorkItemConnector({ client, bindings: [binding], instanceId: "fixture", actorId: "agent", echoStore: new InMemoryMondayEchoStore() });
  return { calls, read: (include_comments?: boolean) => connector.invoke("work-item.read", {
    resource_binding: "cards", work_item_id: "300003", fields: ["attachment"], ...(include_comments === undefined ? {} : { include_comments }),
  }, context) };
}

test("comment reads are opt-in on the existing authorized read contract and preserve file values", async () => {
  const h = fixture([[update("note")]]);
  const ordinary = await h.read(); assert.equal(h.calls.length, 1); assert.equal((ordinary.output as any).work_item.comments, undefined);
  const result = await h.read(true), output = result.output as any;
  assert.equal(h.calls.length, 3);
  assert.deepEqual(output.work_item.comments, { items: [{ id: "note", body: "A saved note" }], complete: true });
  assert.equal(output.work_item.fields.attachment.files[0].assetId, 42);
  assert.deepEqual(result.evidence.comment_request_ids, ["receipt-3"]);
  const input = { resource_binding: "cards", work_item_id: "300003", include_comments: true };
  assert.deepEqual(validateJsonSchemaValue(CORE_CAPABILITY_CATALOG.find(c => c.id === "work-item.read")!.inputSchema, input), []);
  assert.deepEqual(validateJsonSchemaValue(STANDARD_WORK_ITEM_TOOLS[0]!.contract.inputSchema, input), []);
});

test("current comments paginate to exhaustion without any creation-time cutoff", async () => {
  const h = fixture([Array.from({ length: 100 }, (_, i) => update(String(i))), [update("older", "Old but still present")]]);
  const result = await h.read(true);
  assert.deepEqual(h.calls.filter(call => call.variables.page).map(call => call.variables.page), [1, 2]);
  assert.equal((result.output as any).work_item.comments.items.length, 101);
  assert.equal((result.output as any).work_item.comments.complete, true);
  assert.ok(h.calls.every(call => !/from_date|to_date|mutation/.test(call.query)));
});

test("every comment page enforces exact card and resource identity", async () => {
  for (const change of [(item: any) => { item.id = "other"; }, (item: any) => { item.board.id = "other"; },
    (item: any) => { item.updates[0].item_id = "other"; }]) {
    const h = fixture([[update("one")]], change);
    await assert.rejects(h.read(true), /escaped|identity/);
  }
  const h = fixture([Array.from({ length: 100 }, (_, i) => update(String(i))), [update("tail")]], (item, page) => { if (page === 2) item.board.id = "other"; });
  await assert.rejects(h.read(true), /escaped/);
});

test("truncation is explicit and a changing or malformed page never proves absence", async () => {
  const bounded = fixture([[update("large", "x".repeat(120_001))]]);
  assert.deepEqual(((await bounded.read(true)).output as any).work_item.comments, { items: [], complete: false });
  const duplicate = fixture([Array.from({ length: 100 }, (_, i) => update(String(i))), [update("0")]]);
  await assert.rejects(duplicate.read(true), /changed during pagination/);
  await assert.rejects(fixture([[{ id: "empty" }]]).read(true), /identity or body/);
  const tenPages = fixture(Array.from({ length: 10 }, (_, p) => Array.from({ length: 100 }, (_, i) => update(`${p}-${i}`))));
  const result = (await tenPages.read(true)).output as any;
  assert.equal(result.work_item.comments.items.length, 1000); assert.equal(result.work_item.comments.complete, false);
});
