import assert from "node:assert/strict";
import { test } from "node:test";
import { isWorkflowActionRequest, isWorkflowThreadRequest } from "../../runner-vercel/src/lib/workflow-action-ingress.ts";
const request = (payload: unknown) => new Request("https://example.test/api/workflows/slack", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ payload: JSON.stringify(payload) }),
});
test("action-only ingress ignores ordinary messages and existing Tool controls", async () => {
  for (const payload of [null, { type: "event_callback", event: { type: "message" } }, { type: "block_actions", actions: [{ action_id: "companyos.approve" }] },
    { type: "block_actions", actions: [{ action_id: "companyos.workflow.approve" }, { action_id: "companyos.approve" }] }]) assert.equal(await isWorkflowActionRequest(request(payload)), false);
  assert.equal(await isWorkflowActionRequest(new Request("https://example.test", { method: "POST", body: "invalid" })), false);
});
test("action-only ingress preserves original bytes for the SDK signature verifier", async () => {
  for (const choice of ["approve", "reject"]) {
    const input = request({ type: "block_actions", actions: [{ action_id: `companyos.workflow.${choice}`, value: "a".repeat(64) }] });
    const expected = await input.clone().text();
    assert.equal(await isWorkflowActionRequest(input), true);
    assert.equal(await input.text(), expected);
  }
});

test("thread-only ingress excludes direct chat, mentions, bot messages and non-thread events", async () => {
  const event = { type: "message", channel: "C10001", user: "U10001", ts: "20.000001", thread_ts: "10.000001", text: "The intended outcome" };
  const json = (value: unknown) => new Request("https://example.test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "event_callback", event: value }) });
  const original = json(event), bytes = await original.clone().text();
  assert.equal(await isWorkflowThreadRequest(original), true); assert.equal(await original.text(), bytes);
  for (const change of [{ channel: "D10001" }, { text: "<@U10001> hello" }, { thread_ts: undefined }, { bot_id: "B10001" }, { subtype: "message_changed" }, { thread_ts: event.ts }]) assert.equal(await isWorkflowThreadRequest(json({ ...event, ...change })), false);
});
