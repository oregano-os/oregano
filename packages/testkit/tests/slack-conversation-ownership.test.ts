import assert from "node:assert/strict";
import { test } from "node:test";
import { ignoreUnownedSlackConversation } from "../../runner-vercel/src/lib/slack-conversation-ownership.ts";
import { ignoreSlackChannelEvent } from "../../runner-vercel/src/lib/slack-channel-events.ts";

const bindings = [{ surface: "slack", accountId: "T10001", channelId: "C10001" }];
const recipients = ["T10001:U10001"];
const request = (channel: string, type: string, thread_ts: string | undefined, user = "U10001", team_id = "T10001") =>
  new Request("https://example.test", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "event_callback", team_id, event: { channel, type, thread_ts, user, ts: "20.000001", text: "Synthetic request" } }) });

test("production and workflow ownership partition channel mentions and direct messages", async () => {
  for (const type of ["message", "app_mention"]) for (const thread of [undefined, "10.000001"]) {
    for (const [channel, user, workflowOwns] of [
      ["C10001", "U10001", true], ["C20001", "U10001", false],
      ["G20001", "U10001", false], ["C30001", "U20001", false],
      ["D10001", "U10001", true], ["D10001", "U20001", false],
    ] as const) {
      const input = request(channel, type, thread, user), bytes = await input.clone().text();
      assert.equal(await ignoreUnownedSlackConversation(input, bindings, recipients), !workflowOwns);
      assert.equal(await ignoreSlackChannelEvent(input, "process", "C10001", recipients), workflowOwns);
      assert.equal(await input.text(), bytes);
    }
    for (const channel of ["C10001", "D10001"]) {
      assert.equal(await ignoreUnownedSlackConversation(request(channel, type, thread, "U10001", "T20001"), bindings, recipients), true);
    }
  }
});

test("default agents, unrelated providers and missing declarations never confer channel ownership", async () => {
  for (const declarations of [[], [{ ...bindings[0]!, surface: "teams" }], [{ ...bindings[0]!, channelId: "*" }]]) {
    assert.equal(await ignoreUnownedSlackConversation(request("C10001", "app_mention", undefined), declarations, []), true);
  }
  assert.equal(await ignoreUnownedSlackConversation(request("D10001", "message", undefined), [{ ...bindings[0]!, channelId: "D10001" }], []), true);
});

test("control requests keep original verification while malformed event envelopes cannot start a responder", async () => {
  const control = new Request("https://example.test", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "payload=original" });
  assert.equal(await ignoreUnownedSlackConversation(control, [], []), false);
  assert.equal(await control.text(), "payload=original");
  for (const body of ["invalid-json", "x".repeat(100_001)]) {
    assert.equal(await ignoreUnownedSlackConversation(new Request("https://example.test", { method: "POST", headers: { "content-type": "application/json" }, body }), [], []), true);
  }
});
