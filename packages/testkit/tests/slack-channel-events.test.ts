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

test("an exact channel exclusion prevents a second shared-app mention response", async () => {
  for (const type of ["message", "app_mention"]) {
    const original = request({ type, channel: "C10001", text: "<@U90001> outcome", ts: "100.002" });
    const bytes = await original.clone().text();
    assert.equal(await ignoreSlackChannelEvent(original, "process", "C10001,G10001"), true);
    assert.equal(await original.text(), bytes);
    assert.equal(await ignoreSlackChannelEvent(request({ type, channel: "C20001" }), "process", "C10001"), false);
  }
  for (const event of [{ type: "app_mention", channel: "C20001" }, { type: "message", channel: "D10001", channel_type: "im" },
    { type: "assistant_thread_started", channel: "C10001" }]) {
    assert.equal(await ignoreSlackChannelEvent(request(event), "ignore", "C10001"), false);
  }
  const control = new Request("https://example.test", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "payload=%7B%7D" });
  assert.equal(await ignoreSlackChannelEvent(control, "ignore", "C10001"), false);
});

test("channel exclusions reject ambiguous or overly broad configuration", async () => {
  for (const channels of ["", "*", "C10001,", "C10001,C10001", "D10001", "C10", Array.from({ length: 101 }, (_, i) => `C100${i}`).join(",")]) {
    await assert.rejects(ignoreSlackChannelEvent(request({}), "process", channels), /SLACK_IGNORED_CHANNEL_IDS/);
  }
});


test("a reviewed account and person reserves only that person's direct-message route", async () => {
  const original = (user = "U10002", team_id = "T10001", channel = "D10001") => new Request("https://example.test", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "event_callback", team_id,
      event: { type: "message", channel, user, ts: "100.002", text: "Synthetic answer" } }),
  });
  const recipients = ["T10001:U10002"];
  const input = original(), bytes = await input.clone().text();
  assert.equal(await ignoreSlackChannelEvent(input, "process", undefined, recipients), true);
  assert.equal(await input.text(), bytes);
  for (const input of [original("U10003"), original("U10002", "T20001"), original("U10002", "T10001", "C10001")]) {
    assert.equal(await ignoreSlackChannelEvent(input, "process", undefined, recipients), false);
  }
  assert.equal(await ignoreSlackChannelEvent(original(), "process", undefined, []), false);
});

test("DM reservations reject broad or ambiguous configured identities", async () => {
  const { workflowDmRecipients } = await import("../../runner-vercel/src/lib/slack-workflow-dm-routing.ts");
  for (const value of ["", "*", "U10002", "T10001:*", "T10001:D10001", "T10001:U10002,", "T10001:U10002,T10001:U10002"]) {
    assert.throws(() => workflowDmRecipients(value), /SLACK_WORKFLOW_DM_RECIPIENTS/);
  }
});
