import test from "node:test";
import assert from "node:assert/strict";
import { ignoreSlackChannelEvent } from "../../runner-vercel/src/lib/slack-channel-events.ts";
const request = (event: unknown) => new Request("https://example.test/api/webhooks/slack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "event_callback", event }) });

test("legacy blanket ignore no longer drops owned thread follow-ups", async () => {
  for (const channel of ["C10001", "G10001"]) {
    const event = { type: "message", channel, channel_type: "group", thread_ts: "100.001", ts: "100.002", text: "A reply" };
    assert.equal(await ignoreSlackChannelEvent(request(event)), false);
    assert.equal(await ignoreSlackChannelEvent(request(event), "process"), false);
    const req = request(event), bytes = await req.clone().text();
    assert.equal(await ignoreSlackChannelEvent(req, "ignore"), false);
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

test("exact exclusions drop JSON and form buttons for either Slack channel location", async () => {
  const excluded = "C10001,G10001,C30001";
  for (const channel of excluded.split(",")) {
    for (const location of [{ channel: { id: channel } }, { container: { channel_id: channel } },
      { channel: { id: "C20001" }, container: { channel_id: channel } }]) {
      for (const form of [false, true]) {
        const payload = JSON.stringify({ type: "block_actions", ...location,
          actions: [{ action_id: "companyos.workflow.approve", value: "synthetic-decision" }] });
        const input = new Request("https://example.test/api/webhooks/slack", { method: "POST",
          headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
          body: form ? new URLSearchParams({ payload }).toString() : payload });
        const bytes = await input.clone().text();
        assert.equal(await ignoreSlackChannelEvent(input, "process", excluded, []), true);
        assert.equal(await input.text(), bytes);
      }
    }
  }
});

test("channel exclusions retain production and DM controls without claiming malformed payloads", async () => {
  for (const location of [{ channel: { id: "C20001" } }, { container: { channel_id: "G20001" } },
    { channel: { id: "D10001" } }, {}]) {
    const input = new Request("https://example.test", { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ payload: JSON.stringify({ type: "block_actions", ...location }) }).toString() });
    assert.equal(await ignoreSlackChannelEvent(input, "process", "C10001,G10001,C30001", ["T10001:U10001"]), false);
  }
  for (const [contentType, body] of [["application/json", "{"],
    ["application/x-www-form-urlencoded", "payload=%7B"],
    ["application/x-www-form-urlencoded", "command=%2Fsynthetic"]]) {
    const input = new Request("https://example.test", { method: "POST", headers: { "content-type": contentType! }, body });
    assert.equal(await ignoreSlackChannelEvent(input, "process", "C10001", []), false);
    assert.equal(await input.clone().text(), body);
    // The separate isolated-receiver allowlist must still fail closed.
    assert.equal(await ignoreSlackChannelEvent(input, "process", "C10001", [], "C20001"), true);
  }
});

test("over-limit bodies fail closed only when exact routing ownership is configured", async () => {
  for (const contentType of ["application/json", "application/x-www-form-urlencoded"]) {
    const input = new Request("https://example.test", { method: "POST", headers: { "content-type": contentType }, body: " ".repeat(100_001) });
    assert.equal(await ignoreSlackChannelEvent(input, "process", "C10001", []), true);
    assert.equal(await ignoreSlackChannelEvent(input, "process", undefined, ["T10001:U10001"]), true);
    assert.equal(await ignoreSlackChannelEvent(input, "process", undefined, [], "C10001"), true);
    assert.equal(await ignoreSlackChannelEvent(input, "process", undefined, []), false);
    assert.equal(await ignoreSlackChannelEvent(input, "ignore", undefined, []), false);
    assert.equal((await input.text()).length, 100_001);
  }
  const boundary = new Request("https://example.test", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "url_verification" }).padEnd(100_000, " ") });
  assert.equal(await ignoreSlackChannelEvent(boundary, "process", "C10001", []), false);
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

test("DM button reservations require the exact account and person in JSON or form payloads", async () => {
  const recipients = ["T10001:U10002"];
  for (const form of [false, true]) {
    for (const container of [false, true]) {
      for (const [team, user, channel, excluded] of [
        ["T10001", "U10002", "D10001", true],
        ["T20001", "U10002", "D10001", false],
        ["T10001", "U20002", "D10001", false],
        ["T10001", "U10002", "C10001", false],
        [undefined, "U10002", "D10001", false],
        ["T10001", undefined, "D10001", false],
      ] as const) {
        const payload = JSON.stringify({ type: "block_actions", team: { id: team }, user: { id: user },
          ...(container ? { container: { channel_id: channel } } : { channel: { id: channel } }) });
        const input = new Request("https://example.test", { method: "POST",
          headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
          body: form ? new URLSearchParams({ payload }).toString() : payload });
        const bytes = await input.clone().text();
        assert.equal(await ignoreSlackChannelEvent(input, "process", undefined, recipients), excluded);
        assert.equal(await input.clone().text(), bytes);
        assert.equal(await ignoreSlackChannelEvent(input, "process", undefined, []), false);
      }
    }
  }
});


test("an isolated receiver admits only exact owned channel events and controls", async () => {
  const owns = (input: Request) => ignoreSlackChannelEvent(input, "process", undefined, [], "C10001,G10001");
  for (const type of ["message", "app_mention"]) {
    for (const channel of ["C10001", "G10001"]) assert.equal(await owns(request({ type, channel })), false);
    for (const channel of ["C20001", "D10001"]) assert.equal(await owns(request({ type, channel })), true);
  }
  const control = (channel?: string) => new Request("https://example.test", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ payload: JSON.stringify({ type: "block_actions", ...(channel ? { channel: { id: channel } } : {}) }) }).toString() });
  const input = control("C10001"), bytes = await input.clone().text();
  assert.equal(await owns(input), false); assert.equal(await input.text(), bytes);
  assert.equal(await owns(control("C20001")), true);
  assert.equal(await owns(control()), true);
  for (const ids of ["", "*", "D10001", "C10001,C10001"]) await assert.rejects(ignoreSlackChannelEvent(request({}), "process", undefined, [], ids), /SLACK_OWNED_CHANNEL_IDS/);
});
