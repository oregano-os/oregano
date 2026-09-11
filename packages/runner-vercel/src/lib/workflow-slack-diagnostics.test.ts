import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createSlackAdapter } from "@chat-adapter/slack";
import { test } from "node:test";
import { inspectWorkflowSlackRequest, slackMessageReference } from "./workflow-action-ingress.ts";
import { createWorkflowSlackTrace, dispatchWorkflowSlackRequest } from "./workflow-slack-diagnostics.ts";
import { workflowInboundThreadId } from "./workflow-conversations.ts";

const channelBindings = [{ surface: "slack", accountId: "T10001", channelId: "C10001" }];
const secret = "synthetic-signing-key";
const event = { type: "message", channel: "C10001", channel_type: "group", user: "U10001", ts: "20.000001", text: "Synthetic private business facts" };
function request(value: unknown = event, valid = true) {
  const body = JSON.stringify({ type: "event_callback", team_id: "T10001", event_id: "Ev10001", event: value });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  return new Request("https://example.test/api/workflows/slack", { method: "POST", body,
    headers: { "content-type": "application/json", "x-slack-request-timestamp": timestamp,
      "x-slack-signature": valid ? signature : "v0=invalid", authorization: "private-header-never-log" } });
}
async function adapterHarness() {
  const delivered: string[] = [];
  const adapter = createSlackAdapter({ signingSecret: secret, botToken: "synthetic-token", botUserId: "U90001",
    logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } });
  await adapter.initialize({ getState: () => ({ set: async () => {} }),
    processMessage: (_adapter: unknown, threadId: string) => { delivered.push(threadId); return Promise.resolve(); } } as unknown as Parameters<typeof adapter.initialize>[0]);
  return { delivered, handler: adapter.handleWebhook.bind(adapter) };
}

test("existing SDK and isolated ingress both dispatch signed channel roots and thread replies", async () => {
  for (const value of [event, { ...event, thread_ts: "10.000001" },
    { ...event, type: "app_mention", text: "<@U90001> The intended outcome", thread_ts: "10.000001" }]) {
    const original = await adapterHarness(), isolated = await adapterHarness();
    const entries: Record<string, unknown>[] = [];
    assert.equal((await original.handler(request(value), { waitUntil() {} })).status, 200);
    const input = request(value), expectedBytes = await input.clone().text();
    const response = await dispatchWorkflowSlackRequest(input, { workflowOnly: true, channelBindings, diagnostics: true,
      sink: (entry) => entries.push(entry), waitUntil() {}, handler: async (originalRequest, options) => {
        assert.equal(await originalRequest.clone().text(), expectedBytes);
        return isolated.handler(originalRequest, options);
      } });
    assert.equal(response.status, 200);
    assert.equal(isolated.delivered.length, 1);
    assert.deepEqual(isolated.delivered, original.delivered);
    assert.deepEqual(entries.map((entry) => entry.stage), ["received", "sdk-dispatch", "sdk-returned"]);
    assert.equal(entries[1]!.messageRef, slackMessageReference(value.channel, value.ts));
    for (const privateValue of [value.text, "synthetic-token", "private-header-never-log", value.user, value.channel]) {
      assert.equal(JSON.stringify(entries).includes(privateValue), false);
    }
  }
});

test("diagnostics do not authenticate an unsigned message or bypass the existing SDK verifier", async () => {
  const sdk = await adapterHarness(), entries: Record<string, unknown>[] = [];
  const response = await dispatchWorkflowSlackRequest(request(event, false), { workflowOnly: true, channelBindings, diagnostics: true,
    sink: (entry) => entries.push(entry), handler: sdk.handler, waitUntil() {} });
  assert.equal(response.status, 401);
  assert.deepEqual(sdk.delivered, []);
  assert.equal(entries.at(-1)!.status, 401);
  assert.equal(entries.some((entry) => entry.stage === "handler-entered"), false);
});

test("an explicitly routed DM uses the same SDK verification for roots and replies", async () => {
  const previous = process.env.SLACK_WORKFLOW_DM_RECIPIENTS;
  process.env.SLACK_WORKFLOW_DM_RECIPIENTS = "T10001:U10001";
  try {
    for (const thread_ts of [undefined, "10.000001"]) {
      const value = { ...event, channel: "D10001", channel_type: "im", thread_ts };
      const sdk = await adapterHarness();
      const response = await dispatchWorkflowSlackRequest(request(value), {
        workflowOnly: true, channelBindings, diagnostics: false, handler: sdk.handler, waitUntil() {},
      });
      assert.equal(response.status, 200);
      assert.deepEqual(sdk.delivered.map((id) => workflowInboundThreadId(id, event.ts)), [`slack:D10001:${thread_ts ?? event.ts}`]);
      const invalid = await adapterHarness();
      assert.equal((await dispatchWorkflowSlackRequest(request(value, false), {
        workflowOnly: true, channelBindings, diagnostics: false, handler: invalid.handler, waitUntil() {},
      })).status, 401);
      assert.deepEqual(invalid.delivered, []);
    }
  } finally {
    if (previous === undefined) delete process.env.SLACK_WORKFLOW_DM_RECIPIENTS;
    else process.env.SLACK_WORKFLOW_DM_RECIPIENTS = previous;
  }
});

test("filtered messages identify their reason and never initialize a general agent", async () => {
  for (const [patch, reason] of [
    [{ channel: "D10001" }, "not-channel-message"],
    [{ subtype: "message_changed" }, "bot-or-subtype"], [{ bot_id: "B10001" }, "bot-or-subtype"],
    [{ thread_ts: "bad" }, "invalid-message"], [{ type: "reaction_added" }, "other-event"],
  ] as const) {
    const entries: Record<string, unknown>[] = [];
    await dispatchWorkflowSlackRequest(request({ ...event, ...patch }), { workflowOnly: true, channelBindings, diagnostics: true,
      sink: (entry) => entries.push(entry), waitUntil() {}, handler: async () => { assert.fail("filtered message reached SDK"); } });
    assert.equal(entries.at(-1)!.stage, "filtered");
    assert.equal(entries.at(-1)!.outcome, reason);
  }
  assert.equal((await inspectWorkflowSlackRequest(request(), false)).reason, "conversations-disabled");
});

test("initialization and background errors remain failures with content-free diagnostic stages", async () => {
  const privateError = new Error("private upstream content and credential");
  const entries: Record<string, unknown>[] = [];
  await assert.rejects(dispatchWorkflowSlackRequest(request(), { workflowOnly: true, channelBindings, diagnostics: true,
    sink: (entry) => entries.push(entry), waitUntil() {}, handler: async () => { throw privateError; } }), (error) => error === privateError);
  assert.equal(entries.at(-1)!.stage, "ingress-failed");
  let background: Promise<unknown> | undefined;
  const response = await dispatchWorkflowSlackRequest(request(), { workflowOnly: true, channelBindings, diagnostics: true,
    sink: (entry) => entries.push(entry), waitUntil: (task) => { background = task; }, handler: async (_request, options) => {
      options.waitUntil(Promise.reject(privateError)); return new Response(null, { status: 200 });
    } });
  assert.equal(response.status, 200);
  await assert.rejects(background!, (error) => error === privateError);
  assert.equal(entries.some((entry) => entry.stage === "background-failed"), true);
  assert.equal(JSON.stringify(entries).includes(privateError.message), false);
});

test("diagnostics can be disabled and a broken sink never changes response delivery", async () => {
  const trace = createWorkflowSlackTrace({ enabled: false, sink: () => assert.fail("disabled diagnostics emitted") });
  trace.emit("handler-entered");
  const sdk = await adapterHarness();
  assert.equal((await dispatchWorkflowSlackRequest(request(), { workflowOnly: true, channelBindings, diagnostics: true,
    sink: () => { throw new Error("logging unavailable"); }, handler: sdk.handler, waitUntil() {} })).status, 200);
  assert.equal(sdk.delivered.length, 1);
  assert.equal(slackMessageReference("invalid-channel", "20.000001"), undefined);
});


test("unowned channels never initialize the SDK or general coordinator", async () => {
  for (const channel of ["C20001", "C30001", "G20001"]) {
    for (const type of ["message", "app_mention"]) {
      for (const thread_ts of [undefined, "10.000001"]) {
        const entries: Record<string, unknown>[] = [];
        const response = await dispatchWorkflowSlackRequest(request({ ...event, channel, type, thread_ts }), {
          workflowOnly: true, channelBindings, diagnostics: true, sink: (entry) => entries.push(entry),
          waitUntil() {}, handler: async () => { assert.fail("unowned conversation initialized a responder"); },
        });
        assert.equal(response.status, 200);
        assert.equal(entries.at(-1)!.outcome, "unowned-conversation");
      }
    }
  }
});

test("one full test webhook owns compiled channels and reserved DMs while production excludes them", async () => {
  const { ignoreSlackChannelEvent } = await import("./slack-channel-events.ts");
  const { ignoreUnownedSlackConversation } = await import("./slack-conversation-ownership.ts");
  const recipients = ["T10001:U10001"];
  for (const value of [event, { ...event, type: "app_mention" }, { ...event, channel: "D10001", channel_type: "im" }]) {
    const input = request(value);
    assert.equal(await ignoreSlackChannelEvent(input, undefined, "C10001", recipients), true);
    assert.equal(await ignoreSlackChannelEvent(input, undefined, undefined, []), false);
    assert.equal(await ignoreUnownedSlackConversation(input, channelBindings, recipients), false);
    const sdk = await adapterHarness();
    assert.equal((await sdk.handler(input, { waitUntil() {} })).status, 200);
    assert.equal(sdk.delivered.length, 1);
  }
  for (const value of [{ ...event, channel: "C20001" }, { ...event, channel: "D10001", channel_type: "im", user: "U20001" }]) {
    assert.equal(await ignoreUnownedSlackConversation(request(value), channelBindings, recipients), true);
  }
  const sdk = await adapterHarness();
  assert.equal((await sdk.handler(request(event, false), { waitUntil() {} })).status, 401);
  assert.equal(sdk.delivered.length, 0);
});
