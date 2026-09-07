import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createSlackAdapter } from "@chat-adapter/slack";
import { test } from "node:test";
import { inspectWorkflowSlackRequest, slackMessageReference } from "./workflow-action-ingress.ts";
import { createWorkflowSlackTrace, dispatchWorkflowSlackRequest } from "./workflow-slack-diagnostics.ts";

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
  for (const value of [event, { ...event, thread_ts: "10.000001" }]) {
    const original = await adapterHarness(), isolated = await adapterHarness();
    const entries: Record<string, unknown>[] = [];
    assert.equal((await original.handler(request(value), { waitUntil() {} })).status, 200);
    const input = request(value), expectedBytes = await input.clone().text();
    const response = await dispatchWorkflowSlackRequest(input, { workflowOnly: true, diagnostics: true,
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
  const response = await dispatchWorkflowSlackRequest(request(event, false), { workflowOnly: true, diagnostics: true,
    sink: (entry) => entries.push(entry), handler: sdk.handler, waitUntil() {} });
  assert.equal(response.status, 401);
  assert.deepEqual(sdk.delivered, []);
  assert.equal(entries.at(-1)!.status, 401);
  assert.equal(entries.some((entry) => entry.stage === "handler-entered"), false);
});

test("filtered messages identify their reason and never initialize a general agent", async () => {
  for (const [patch, reason] of [
    [{ channel: "D10001" }, "not-channel-message"], [{ text: "<@U90001> mention" }, "mention"],
    [{ subtype: "message_changed" }, "bot-or-subtype"], [{ bot_id: "B10001" }, "bot-or-subtype"],
    [{ thread_ts: "bad" }, "invalid-message"], [{ type: "app_mention" }, "other-event"],
  ] as const) {
    const entries: Record<string, unknown>[] = [];
    await dispatchWorkflowSlackRequest(request({ ...event, ...patch }), { workflowOnly: true, diagnostics: true,
      sink: (entry) => entries.push(entry), waitUntil() {}, handler: async () => { assert.fail("filtered message reached SDK"); } });
    assert.equal(entries.at(-1)!.stage, "filtered");
    assert.equal(entries.at(-1)!.outcome, reason);
  }
  assert.equal((await inspectWorkflowSlackRequest(request(), false)).reason, "conversations-disabled");
});

test("initialization and background errors remain failures with content-free diagnostic stages", async () => {
  const privateError = new Error("private upstream content and credential");
  const entries: Record<string, unknown>[] = [];
  await assert.rejects(dispatchWorkflowSlackRequest(request(), { workflowOnly: true, diagnostics: true,
    sink: (entry) => entries.push(entry), waitUntil() {}, handler: async () => { throw privateError; } }), (error) => error === privateError);
  assert.equal(entries.at(-1)!.stage, "ingress-failed");
  let background: Promise<unknown> | undefined;
  const response = await dispatchWorkflowSlackRequest(request(), { workflowOnly: true, diagnostics: true,
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
  assert.equal((await dispatchWorkflowSlackRequest(request(), { workflowOnly: true, diagnostics: true,
    sink: () => { throw new Error("logging unavailable"); }, handler: sdk.handler, waitUntil() {} })).status, 200);
  assert.equal(sdk.delivered.length, 1);
  assert.equal(slackMessageReference("invalid-channel", "20.000001"), undefined);
});
