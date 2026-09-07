import assert from "node:assert/strict";
import { test } from "node:test";
import { isWorkflowActionRequest, isWorkflowThreadRequest } from "../../runner-vercel/src/lib/workflow-action-ingress.ts";
import { ignoreSlackChannelEvent } from "../../runner-vercel/src/lib/slack-channel-events.ts";
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

test("workflow channel ingress accepts roots, replies and mentions while excluding direct chat and bots", async () => {
  const event = { type: "message", channel: "C10001", user: "U10001", ts: "20.000001", thread_ts: "10.000001", text: "The intended outcome" };
  const json = (value: unknown) => new Request("https://example.test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "event_callback", event: value }) });
  assert.equal(await isWorkflowThreadRequest(json({ ...event, thread_ts: undefined })), true);
  assert.equal(await isWorkflowThreadRequest(json({ ...event, thread_ts: event.ts })), true);
  const original = json(event), bytes = await original.clone().text();
  assert.equal(await isWorkflowThreadRequest(original), true); assert.equal(await original.text(), bytes);
  for (const type of ["message", "app_mention"]) {
    const mentioned = json({ ...event, type, text: "<@U90001> The intended outcome" }), bytes = await mentioned.clone().text();
    assert.equal(await isWorkflowThreadRequest(mentioned), true);
    assert.equal(await mentioned.text(), bytes);
  }
  for (const change of [{ channel: "D10001" }, { bot_id: "B10001" }, { subtype: "message_changed" }, { ts: "invalid" }, { thread_ts: "invalid" }, { type: "reaction_added" }]) assert.equal(await isWorkflowThreadRequest(json({ ...event, ...change })), false);
});

test("shared destinations assign a mentioned test-channel reply exclusively to workflow handling", async () => {
  for (const type of ["message", "app_mention"]) {
    const input = new Request("https://example.test", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "event_callback", event: { type, channel: "C10001", user: "U10001", ts: "20.000001", text: "<@U90001> My answer" } }) });
    const bytes = await input.clone().text();
    assert.equal(await ignoreSlackChannelEvent(input, "ignore", "C10001"), true);
    assert.equal(await isWorkflowThreadRequest(input), true);
    assert.equal(await input.text(), bytes);
  }
});
