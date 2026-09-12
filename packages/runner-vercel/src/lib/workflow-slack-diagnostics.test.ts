import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createSlackAdapter } from "@chat-adapter/slack";
import { test } from "node:test";
import { inspectWorkflowSlackRequest, slackMessageReference } from "./workflow-action-ingress.ts";
import { createWorkflowSlackTrace, dispatchWorkflowSlackRequest } from "./workflow-slack-diagnostics.ts";
import { workflowInboundThreadId } from "./workflow-conversations.ts";
import { ignoreSlackChannelEvent } from "./slack-channel-events.ts";

const channelBindings = [{ surface: "slack", accountId: "T10001", channelId: "C10001" }];
const secret = "synthetic-signing-key";
const event = { type: "message", channel: "C10001", channel_type: "group", user: "U10001", ts: "20.000001", text: "Synthetic private business facts" };
function request(value: unknown = event, valid = true) {
  const body = JSON.stringify({ type: "event_callback", team_id: "T10001", event_id: "Ev10001", event: value });
  return signedRequest(body, "application/json", valid);
}
function signedRequest(body: string, contentType: string, valid = true) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  return new Request("https://example.test/api/workflows/slack", { method: "POST", body,
    headers: { "content-type": contentType, "x-slack-request-timestamp": timestamp,
      "x-slack-signature": valid ? signature : "v0=invalid", authorization: "private-header-never-log" } });
}
function actionRequest(channel: string, container = false, valid = true, user = "U20001", team = "T10001") {
  const payload = { type: "block_actions", user: { id: user }, team: { id: team },
    ...(container ? { container: { channel_id: channel, message_ts: event.ts } }
      : { channel: { id: channel }, message: { ts: event.ts } }),
    actions: [{ action_id: "companyos.workflow.approve", value: "synthetic-decision" }] };
  return signedRequest(new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
    "application/x-www-form-urlencoded", valid);
}
async function adapterHarness() {
  const delivered: string[] = [], actions: string[] = [];
  const adapter = createSlackAdapter({ signingSecret: secret, botToken: "synthetic-token", botUserId: "U90001",
    logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } });
  await adapter.initialize({ getState: () => ({ set: async () => {} }),
    processMessage: (_adapter: unknown, threadId: string) => { delivered.push(threadId); return Promise.resolve(); },
    processAction: (action: { threadId: string; actionId: string }) => {
      actions.push(`${action.threadId}:${action.actionId}`); return Promise.resolve();
    } } as unknown as Parameters<typeof adapter.initialize>[0]);
  return { delivered, actions, handler: adapter.handleWebhook.bind(adapter) };
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
        workflowOnly: true, channelBindings, excludedChannelIds: "C20001", diagnostics: false, handler: sdk.handler, waitUntil() {},
      });
      assert.equal(response.status, 200);
      assert.deepEqual(sdk.delivered.map((id) => workflowInboundThreadId(id, event.ts)), [`slack:D10001:${thread_ts ?? event.ts}`]);
      const invalid = await adapterHarness();
      assert.equal((await dispatchWorkflowSlackRequest(request(value, false), {
        workflowOnly: true, channelBindings, excludedChannelIds: "C20001", diagnostics: false, handler: invalid.handler, waitUntil() {},
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

test("both ingress guards drop excluded channel buttons and messages before any responder initializes", async () => {
  const excludedChannelIds = "C10001,G10001,C30001";
  for (const channel of excludedChannelIds.split(",")) {
    for (const input of [actionRequest(channel), actionRequest(channel, true),
      request({ ...event, channel }), request({ ...event, channel, type: "app_mention" })]) {
      const bytes = await input.clone().text();
      assert.equal(await ignoreSlackChannelEvent(input, "process", excludedChannelIds, []), true);
      for (const workflowOnly of [false, true]) {
        const entries: Record<string, unknown>[] = [];
        const response = await dispatchWorkflowSlackRequest(input, {
          workflowOnly, channelBindings, excludedChannelIds, diagnostics: true, sink: (entry) => entries.push(entry),
          waitUntil() {}, handler: async () => { assert.fail("excluded channel initialized a responder"); },
        });
        assert.equal(response.status, 200);
        assert.equal(entries.at(-1)!.outcome, "unowned-conversation");
      }
      assert.equal(await input.text(), bytes);
    }
  }
});

test("production and DM buttons retain SDK verification and original request bytes on both paths", async () => {
  const excludedChannelIds = "C10001,G10001,C30001";
  for (const channel of ["C20001", "G20001", "D10001"]) {
    for (const container of [false, true]) {
      for (const valid of [false, true]) {
        const primary = await adapterHarness(), alternate = await adapterHarness();
        const input = actionRequest(channel, container, valid), bytes = await input.clone().text();
        assert.equal(await ignoreSlackChannelEvent(input, "process", excludedChannelIds, ["T10001:U10001"]), false);
        const direct = await primary.handler(input.clone(), { waitUntil() {} });
        const response = await dispatchWorkflowSlackRequest(input, {
          workflowOnly: false, excludedChannelIds, diagnostics: false, waitUntil() {},
          handler: async (original, options) => {
            assert.equal(await original.clone().text(), bytes);
            return alternate.handler(original, options);
          },
        });
        assert.equal(direct.status, valid ? 200 : 401);
        assert.equal(response.status, direct.status);
        assert.deepEqual(primary.actions, valid ? [`slack:${channel}:${event.ts}:companyos.workflow.approve`] : []);
        assert.deepEqual(alternate.actions, primary.actions);
      }
    }
  }
});

test("channel exclusions preserve ordinary production messages and exact DM ownership", async () => {
  const excludedChannelIds = "C10001,G10001,C30001", recipients = ["T10001:U10001"];
  for (const value of [{ ...event, channel: "C20001" }, { ...event, channel: "G20001", type: "app_mention" },
    { ...event, channel: "D10001", channel_type: "im", user: "U20001" }]) {
    const sdk = await adapterHarness(), input = request(value);
    assert.equal(await ignoreSlackChannelEvent(input, "process", excludedChannelIds, recipients), false);
    assert.equal((await sdk.handler(input, { waitUntil() {} })).status, 200);
    assert.equal(sdk.delivered.length, 1);
  }
  assert.equal(await ignoreSlackChannelEvent(request({ ...event, channel: "D10001", channel_type: "im" }),
    "process", excludedChannelIds, recipients), true);
});

test("malformed form payloads cannot dispatch actions and still reach the primary SDK verifier unchanged", async () => {
  for (const valid of [false, true]) {
    const sdk = await adapterHarness();
    const input = signedRequest("payload=%7B", "application/x-www-form-urlencoded", valid);
    assert.equal(await ignoreSlackChannelEvent(input, "process", "C10001", []), false);
    assert.equal((await sdk.handler(input.clone(), { waitUntil() {} })).status, valid ? 400 : 401);
    assert.deepEqual(sdk.actions, []);
    const entries: Record<string, unknown>[] = [];
    assert.equal((await dispatchWorkflowSlackRequest(input, { workflowOnly: false, excludedChannelIds: "C10001",
      diagnostics: true, sink: (entry) => entries.push(entry), waitUntil() {},
      handler: async () => { assert.fail("malformed action initialized a responder"); },
    })).status, 200);
    assert.equal(entries.at(-1)!.outcome, "invalid-payload");
  }
});

test("reserved DM buttons belong only to the workflow receiver while other people and accounts retain production actions", async () => {
  const previous = process.env.SLACK_WORKFLOW_DM_RECIPIENTS;
  process.env.SLACK_WORKFLOW_DM_RECIPIENTS = "T10001:U10001";
  const excludedChannelIds = "C10001,G10001,C30001";
  try {
    for (const container of [false, true]) {
      for (const valid of [false, true]) {
        const input = actionRequest("D10001", container, valid, "U10001");
        const bytes = await input.clone().text();
        assert.equal(await ignoreSlackChannelEvent(input, "process", excludedChannelIds), true);
        assert.equal((await dispatchWorkflowSlackRequest(input, { workflowOnly: false, excludedChannelIds,
          diagnostics: false, waitUntil() {},
          handler: async () => { assert.fail("production initialized a responder for a reserved DM button"); },
        })).status, 200);
        // The workflow-only webhook passes [] to the same guard before SDK authentication.
        assert.equal(await ignoreSlackChannelEvent(input, "process", excludedChannelIds, []), false);
        const sdk = await adapterHarness();
        assert.equal((await dispatchWorkflowSlackRequest(input, { workflowOnly: true, excludedChannelIds,
          diagnostics: false, waitUntil() {}, handler: async (original, options) => {
            assert.equal(await original.clone().text(), bytes);
            return sdk.handler(original, options);
          },
        })).status, valid ? 200 : 401);
        assert.deepEqual(sdk.actions, valid ? [`slack:D10001:${event.ts}:companyos.workflow.approve`] : []);
      }
      for (const [user, team] of [["U20001", "T10001"], ["U10001", "T20001"]]) {
        const input = actionRequest("D10001", container, true, user, team);
        assert.equal(await ignoreSlackChannelEvent(input, "process", excludedChannelIds), false);
        const sdk = await adapterHarness();
        assert.equal((await dispatchWorkflowSlackRequest(input, { workflowOnly: false, excludedChannelIds,
          diagnostics: false, waitUntil() {}, handler: sdk.handler,
        })).status, 200);
        assert.deepEqual(sdk.actions, [`slack:D10001:${event.ts}:companyos.workflow.approve`]);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.SLACK_WORKFLOW_DM_RECIPIENTS;
    else process.env.SLACK_WORKFLOW_DM_RECIPIENTS = previous;
  }
});

test("oversized signed actions cannot bypass configured ownership even though the SDK can dispatch them", async () => {
  const previous = process.env.SLACK_WORKFLOW_DM_RECIPIENTS;
  process.env.SLACK_WORKFLOW_DM_RECIPIENTS = "T10001:U10001";
  try {
    for (const channel of ["C10001", "D10001"]) {
      const payload = { type: "block_actions", team: { id: "T10001" }, user: { id: "U10001" }, channel: { id: channel },
        message: { ts: event.ts, text: "x".repeat(100_000) },
        actions: [{ action_id: "companyos.workflow.approve", value: "synthetic-decision" }] };
      const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
      assert.ok(body.length > 100_000);
      const input = signedRequest(body, "application/x-www-form-urlencoded");
      const unguarded = await adapterHarness();
      assert.equal(await ignoreSlackChannelEvent(input, "process", undefined, []), false);
      assert.equal((await unguarded.handler(input.clone(), { waitUntil() {} })).status, 200);
      assert.deepEqual(unguarded.actions, [`slack:${channel}:${event.ts}:companyos.workflow.approve`]);
      const excludedChannelIds = channel === "C10001" ? "C10001" : undefined;
      assert.equal(await ignoreSlackChannelEvent(input, "process", excludedChannelIds), true);
      assert.equal((await dispatchWorkflowSlackRequest(input, { workflowOnly: false, excludedChannelIds,
        diagnostics: false, waitUntil() {},
        handler: async () => { assert.fail("an oversized action bypassed routing ownership"); },
      })).status, 200);
      assert.equal(await input.text(), body);
    }
  } finally {
    if (previous === undefined) delete process.env.SLACK_WORKFLOW_DM_RECIPIENTS;
    else process.env.SLACK_WORKFLOW_DM_RECIPIENTS = previous;
  }
});
