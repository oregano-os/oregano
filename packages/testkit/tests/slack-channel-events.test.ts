import test from "node:test";
import assert from "node:assert/strict";
import { ignoreSlackChannelEvent } from "../../runner-vercel/src/lib/slack-channel-events.ts";
const request = (event: unknown) => new Request("https://example.test/api/webhooks/slack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "event_callback", event }) });

test("staged channel events cannot wake the other shared-app deployment", async () => {
  for (const channel of ["C10001", "G10001"]) {
    const event = { type: "message", channel, channel_type: "group", thread_ts: "100.001", ts: "100.002", text: "A reply" };
    assert.equal(await ignoreSlackChannelEvent(request(event)), false);
    assert.equal(await ignoreSlackChannelEvent(request(event), "process"), false);
    const req = request(event), bytes = await req.clone().text();
    assert.equal(await ignoreSlackChannelEvent(req, "ignore"), true);
    assert.equal(await req.text(), bytes);
  }
});
test("the staging guard preserves mentions, direct messages and interactive requests", async () => {
  for (const event of [{ type: "app_mention", channel: "C10001" }, { type: "message", channel: "D10001", channel_type: "im" }]) {
    assert.equal(await ignoreSlackChannelEvent(request(event), "ignore"), false);
  }
  const control = new Request("https://example.test", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "payload=%7B%7D" });
  assert.equal(await ignoreSlackChannelEvent(control, "ignore"), false);
  await assert.rejects(ignoreSlackChannelEvent(request({}), "typo"), /must be/);
});
