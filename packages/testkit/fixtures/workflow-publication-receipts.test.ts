import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import type { Connector, JsonValue } from "../../capabilities/contracts.ts";
import { engineFixture, ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";

function receiptFixture(mode: "root-destination" | "reply-destination" | "reply-thread" | "missing-reply-thread" | "valid") {
  let sends = 0;
  const publicationConnector: Connector = { id: "test/receipts", version: "1.0.0", capabilities: ["communication.message.publish"], async invoke(_capability, raw) {
    const input = raw as Record<string, JsonValue>, reply = typeof input.thread_reference === "string";
    const output: Record<string, JsonValue> = { destination_binding: input.destination_binding!, message_id: `receipt-${++sends}`,
      published_at: "2030-01-04T14:30:00.000Z", thread_reference: input.thread_reference ?? "test-root" };
    if ((!reply && mode === "root-destination") || (reply && mode === "reply-destination")) output.destination_binding = "wrong-destination";
    if (reply && mode === "reply-thread") output.thread_reference = "wrong-thread";
    if (reply && mode === "missing-reply-thread") delete output.thread_reference;
    return { output, evidence: { synthetic: true } };
  } };
  return { h: engineFixture({ publicationConnector }), sends: () => sends };
}

test("a mismatched root destination blocks before any dependent message", async () => {
  const { h, sends } = receiptFixture("root-destination");
  const opened = await h.engine().openOperator({ workflowId: "friday-close", requestId: randomUUID(), principal: ENGINE_OPERATOR,
    fields: { sprint_id: "one", next_sprint_id: "two" } });
  const stopped = (await h.engine().advance(opened.runId))!;
  assert.equal(stopped.state.blocked?.code, "effect-needs-review");
  assert.equal(stopped.state.cursor, "open-close-thread");
  assert.equal(stopped.state.wait, undefined);
  assert.equal(sends(), 1);
});

async function closeAtChase(h: ReturnType<typeof engineFixture>) {
  const opened = await h.engine().openOperator({ workflowId: "friday-close", requestId: randomUUID(), principal: ENGINE_OPERATOR,
    fields: { sprint_id: "one", next_sprint_id: "two" } });
  const waiting = (await h.engine().advance(opened.runId))!;
  assert.equal(waiting.state.cursor, "await-chase");
  h.now = "2030-01-04T15:20:00.000Z"; await h.engine().timers();
  return (await h.engine().advance(opened.runId))!;
}

test("a reply receipt cannot widen the destination or change or omit the existing thread", async (t) => {
  for (const mode of ["reply-destination", "reply-thread", "missing-reply-thread"] as const) await t.test(mode, async () => {
    const { h, sends } = receiptFixture(mode), run = await closeAtChase(h);
    assert.equal(run.state.blocked?.code, "effect-needs-review", mode);
    assert.equal(run.state.cursor, "chase");
    assert.equal(run.state.steps.report, undefined);
    assert.equal(run.state.steps.retro, undefined);
    assert.deepEqual(run.state.decisions, {});
    const count = sends(); await h.engine().advance(run.runId);
    assert.equal(sends(), count);
    await h.engine().resume(run.runId, ENGINE_OPERATOR);
    const resumed = (await h.engine().advance(run.runId))!;
    assert.equal(resumed.state.blocked?.code, "effect-needs-review");
    assert.equal(resumed.state.cursor, "chase");
    assert.equal(sends(), count, "resume must reuse the retained bad receipt without resending");
    assert.equal(h.calls.filter((call) => call.capability === "work-item.batch-update").length, 0);
  });
});

test("a matching reply receipt continues in the original thread", async () => {
  const { h, sends } = receiptFixture("valid"), run = await closeAtChase(h);
  assert.equal(run.state.blocked, undefined);
  assert.equal(run.state.cursor, "await-report");
  assert.equal((run.state.steps.chase!.output as any).thread_reference, "test-root");
  assert.equal(sends(), 2);
});
