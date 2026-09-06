import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { capabilityEffectReview } from "../../capabilities/effect-review.ts";
import { CapabilityEffectOutcomeUnknownError, type Connector } from "../../capabilities/contracts.ts";
import { CORE_CAPABILITY_CATALOG } from "../../capabilities/catalog.ts";
import { ConnectorRegistry } from "../../connectors/registry.ts";
import { MondayClient } from "../../connectors/monday/client.ts";
import { MondayWorkItemConnector } from "../../connectors/monday/connector.ts";
import { InMemoryMondayEchoStore } from "../../connectors/monday/echo-guard.ts";
import { engineArtifact, engineFixture, ENGINE_OPERATOR, ENGINE_OWNER } from "../workflow-engine-fixture.ts";
import { workflowDecisionId } from "../../runtime/workflow-engine/decision-notice.ts";
import { parseWorkflowOperatorRequest } from "../../runner-vercel/src/lib/workflow-http.ts";

const ready = async (h: ReturnType<typeof engineFixture>) => {
  let run = await h.engine().openOperator({ workflowId: "friday-close", requestId: randomUUID(), principal: ENGINE_OPERATOR, fields: { sprint_id: "one", next_sprint_id: "two" } });
  await h.engine().advance(run.runId);
  for (const instant of ["2030-01-04T15:20:00.000Z", "2030-01-04T16:00:00.000Z"]) {
    h.now = instant; await h.engine().timers(); run = (await h.engine().advance(run.runId))!;
    assert.equal(run.state.blocked, undefined);
  }
  const decision = run.state.decisions["approve-rollover"]!;
  return h.engine().decide({ principal: ENGINE_OWNER, conversation: h.conversation("direct-jonas-owner", decision.deliveries["jonas-owner"]!), eventId: randomUUID(),
    requestId: workflowDecisionId(run.runId, decision.stepId, decision.boundDigest), decision: "approved" });
};
const response = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json", "api-version": "dev", "x-request-id": "synthetic-request" } });
const item = (id: string, version = "v1") => response({ items: [{ id, name: id, updated_at: version, board: { id: "board-1" }, group: { id: "current" }, column_values: [] }] });

test("actual Monday partial receipts survive the ordinary engine and authenticated operator review without replay", async () => {
  const artifact = engineArtifact();
  const queue: Array<Response | Error> = [item("item-1"), item("item-2"), item("item-3"), response({ change_multiple_column_values: { id: "item-1" } }), item("item-1", "v2"), new Error("private-provider-error")];
  let providerCalls = 0;
  const monday = new MondayWorkItemConnector({ client: new MondayClient({ token: "synthetic-token", apiVersion: "dev", fetcher: async () => {
    providerCalls++; const next = queue.shift(); if (next instanceof Error) throw next; if (!next) throw new Error("Unexpected provider call"); return next;
  } }), actorId: "agent-1", instanceId: artifact.instance.id, bindings: [{ id: "sprint-board", boardId: "board-1", permission: "read-write", fields: { sprint: "sprint_col" } }], echoStore: new InMemoryMondayEchoStore() });
  const h = engineFixture({ artifact, batchConnector: monday });
  for (const id of ["item-2", "item-3"]) h.items.push({ record_id: id, values: { ...h.items[0]!.values, work_item_id: id } });
  const approved = await ready(h), blocked = (await h.engine().advance(approved.runId))!;
  assert.equal(blocked.state.blocked?.code, "effect-needs-review");
  const review = await h.engine().review(blocked.runId, ENGINE_OPERATOR);
  assert.equal(review.effect.status, "unknown");
  assert.deepEqual(review.effect.capabilities[0]?.items, [
    { item_id: "item-1", status: "verified", provider_version: "v2" },
    { item_id: "item-2", status: "unknown" }, { item_id: "item-3", status: "not-attempted" },
  ]);
  assert.equal(review.effect.retryAuthorized, false);
  assert.equal(JSON.stringify(review).includes("private-provider-error"), false);
  assert.equal(JSON.stringify(review).includes("synthetic-token"), false);
  assert.deepEqual(await h.engine().review(blocked.runId, ENGINE_OPERATOR), review);
  await assert.rejects(h.engine().resume(blocked.runId, ENGINE_OPERATOR), /reconciliation/);
  await h.engine().advance(blocked.runId);
  await h.engine().step(blocked.runId);
  const notice = h.calls.filter((call) => call.capability === "communication.message.publish").at(-1)!.input;
  assert.match(notice.content, /"item-1": verified/);
  assert.match(notice.content, /"item-2": unknown/);
  assert.match(notice.content, /"item-3": not-attempted/);
  assert.equal(notice.destination_binding, "direct-jonas-owner");
  assert.equal(notice.content.includes("private-provider-error"), false);
  assert.equal(notice.content.includes("synthetic-token"), false);
  assert.equal(providerCalls, 6); assert.equal(queue.length, 0);
  await assert.rejects(h.engine().review(blocked.runId, ENGINE_OWNER), /authorized human/);
  h.roster.find((member) => member.principals?.includes(ENGINE_OPERATOR))!.status = "inactive";
  await assert.rejects(h.engine().review(blocked.runId, ENGINE_OPERATOR), /authorized human/);
});

test("a partial success-shaped batch response blocks the engine and unknown items stay unknown", async () => {
  const connector: Connector = { id: "test/partial", version: "1.0.0", capabilities: ["work-item.batch-update"], async invoke() {
    return { output: { complete: false, results: [] }, evidence: { secret_provider_payload: "must-not-appear" } };
  } };
  const h = engineFixture({ batchConnector: connector }), approved = await ready(h);
  const run = (await h.engine().advance(approved.runId))!;
  assert.equal(run.state.status, "waiting"); assert.ok(run.state.blocked);
  const review = await h.engine().review(run.runId, ENGINE_OPERATOR);
  assert.deepEqual(review.effect.capabilities[0]?.items, [{ item_id: "item-1", status: "unknown" }]);
  assert.equal(JSON.stringify(review).includes("must-not-appear"), false);
  await assert.rejects(h.engine().resume(run.runId, ENGINE_OPERATOR), /reconciliation/);
  await h.engine().advance(run.runId);
  assert.equal(h.calls.filter((call) => call.capability === "work-item.batch-update").length, 1);
});

test("batch completion must account for the exact requested items and malformed review evidence grants no certainty", async () => {
  for (const resultIds of [[], ["another"], ["one", "one"]]) {
    const connector: Connector = { id: "test/batch", version: "1.0.0", capabilities: ["work-item.batch-update"], async invoke() {
      return { output: { complete: true, results: resultIds.map((work_item_id) => ({ work_item_id })) }, evidence: {} };
    } };
    const registry = new ConnectorRegistry({ contracts: CORE_CAPABILITY_CATALOG, connectors: [connector], bindings: [{ capability: "work-item.batch-update", contractVersion: "1.0.0", connector: connector.id, connectorVersion: connector.version }] });
    await assert.rejects(registry.invoke("work-item.batch-update", { resource_binding: "board", updates: [{ work_item_id: "one", expected_version: "v1", changes: { status: "Done" } }] },
      { instanceId: "test", runId: "run", stepId: "write", agentId: "agent", toolId: "tool", idempotencyKey: "claimed" }), CapabilityEffectOutcomeUnknownError);
  }
  assert.equal(capabilityEffectReview({ version: 1, items: [{ item_id: "one", status: "not-attempted" }, { item_id: "one", status: "verified" }] }), undefined);
  assert.equal(capabilityEffectReview({ version: 1, items: [{ item_id: "one", status: "success" }] }), undefined);
  assert.equal(capabilityEffectReview({ version: 1, items: [{ item_id: "one", status: "verified", provider_version: "x".repeat(256) }] }), undefined);
});

test("operator review is bounded and never accepts caller approval or provider evidence", () => {
  const runId = `workflow:${"a".repeat(64)}`;
  assert.deepEqual(parseWorkflowOperatorRequest({ action: "review", runId, offset: 2 }), { action: "review", runId, offset: 2 });
  for (const extra of [{ offset: -1 }, { offset: 10000 }, { offset: "1" }, { principal: ENGINE_OWNER }, { retry: true }, { evidence: {} }]) {
    assert.throws(() => parseWorkflowOperatorRequest({ action: "review", runId, ...extra }));
  }
});

test("review pages preserve distinct keyed publication receipts after partial collection progress", async () => {
  let receipts = 0;
  const h: ReturnType<typeof engineFixture> = engineFixture({ conversationForReceipt: async ({ destinationBinding, output }) => {
    if (++receipts === 2) throw new Error("Synthetic assignment receipt failure");
    return h.conversation(destinationBinding, output);
  } });
  h.now = "2030-01-08T09:00:00.000Z";
  h.items.push({ record_id: "item-2", values: { ...h.items[0]!.values, work_item_id: "item-2", assignee_ids: ["tim-contributor"] } });
  const opened = await h.engine().openOperator({ workflowId: "board-hygiene", requestId: randomUUID(), principal: ENGINE_OPERATOR, fields: {} });
  const run = (await h.engine().advance(opened.runId))!; assert.ok(run.state.blocked);
  const first = await h.engine().review(run.runId, ENGINE_OPERATOR), second = await h.engine().review(run.runId, ENGINE_OPERATOR, first.nextOffset);
  assert.equal(first.totalEffects, 2); assert.equal(first.nextOffset, 1); assert.equal(second.nextOffset, undefined);
  assert.notEqual(first.itemKey, second.itemKey); assert.notEqual(first.idempotencyKey, second.idempotencyKey);
  assert.equal(first.effect.status, "succeeded"); assert.equal(second.effect.status, "succeeded");
  await assert.rejects(h.engine().review(run.runId, ENGINE_OPERATOR, 2), /exceeds/);
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 2);
});
