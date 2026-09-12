import assert from "node:assert/strict";
import test from "node:test";
import { inspectWorkflowSlackRequest } from "../../runner-vercel/src/lib/workflow-action-ingress.ts";
import { ignoreSlackChannelEvent } from "../../runner-vercel/src/lib/slack-channel-events.ts";
import { requireWorkflowReplyRoute, workflowDmRecipients } from "../../runner-vercel/src/lib/slack-workflow-dm-routing.ts";
import { parseWorkflowOperatorRequest } from "../../runner-vercel/src/lib/workflow-http.ts";
import { WorkflowSlackTransport } from "../../connectors/slack/workflow-transport.ts";
import { engineFixture } from "../workflow-engine-fixture.ts";

const recipients = ["T10001:U10002"];
const request = (event: Record<string, unknown> = {}, team = "T10001") => new Request("https://example.test", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "event_callback", team_id: team,
    event: { type: "message", channel: "D10001", user: "U10002", ts: "20.000001", text: "1. Done. 2. In progress because a part is missing.", ...event } }),
});

test("exact DM ownership gives roots and replies one shared-app destination, preserving signed bytes", async () => {
  for (const event of [{}, { thread_ts: "10.000001" }, { type: "app_mention" }]) {
    const input = request(event), bytes = await input.clone().text();
    assert.equal(await ignoreSlackChannelEvent(input, "process", undefined, recipients), true);
    assert.equal((await inspectWorkflowSlackRequest(input, true, recipients)).kind, "message");
    assert.equal(await input.text(), bytes);
  }
  for (const input of [request({ user: "U10003" }), request({}, "T20001"), request({ channel: "C10001" })]) {
    assert.equal(await ignoreSlackChannelEvent(input, "process", undefined, recipients), false);
  }
  for (const input of [request({ user: "U10003" }), request({}, "T20001"), request({ bot_id: "B10001" }), request({ subtype: "message_changed" })]) {
    assert.equal((await inspectWorkflowSlackRequest(input, true, recipients)).kind, "ignored");
  }
  assert.equal((await inspectWorkflowSlackRequest(request(), true, [])).kind, "ignored");
  assert.equal((await inspectWorkflowSlackRequest(request(), false, recipients)).kind, "ignored");
  assert.equal(await ignoreSlackChannelEvent(request(), "process", undefined, []), false);
});

test("DM route declarations reject ambiguous, wildcard, foreign-surface or duplicate identities", () => {
  assert.deepEqual(workflowDmRecipients("T10001:U10002, T20001:W10002"), ["T10001:U10002", "T20001:W10002"]);
  for (const value of ["", "*", "U10002", "T10001:*", "T10001:D10001", "T10001:U10002,", "T10001:U10002,T10001:U10002",
    Array.from({ length: 101 }, (_, i) => `T10001:U100${i}`).join(",")]) {
    assert.throws(() => workflowDmRecipients(value), /SLACK_WORKFLOW_DM_RECIPIENTS/);
  }
});

test("a workflow-only DM is qualified against its verified principal before publication", async () => {
  const h = engineFixture(), artifact = structuredClone(h.artifact);
  artifact.bindings = artifact.bindings.map((b) => b.capability === "communication.message.publish"
    ? { ...b, connector: "oregano/slack-communication", connectorVersion: "0.1.0" } : b);
  artifact.connectors = [{ id: "slack", connector: "oregano/slack-communication", connectorVersion: "0.1.0", configuration: { destinations: [
    { id: "direct-jonas-owner", account_id: "T10001", kind: "direct-message", user_id: "U10002" },
  ] } }];
  let routes: string[] = [], checked = 0;
  const transport = new WorkflowSlackTransport({ call: async (method, args) => {
    if (method === "auth.test") return { ok: true, team_id: "T10001" };
    assert.equal(method, "users.info");
    return { ok: true, user: { id: args.user, team_id: "T10001", deleted: false, is_bot: false } };
  }, qualifyReplies: async (kind, principal) => {
    checked++; assert.equal(principal, "slack:T10001:U10002");
    requireWorkflowReplyRoute(kind, principal, true, routes);
  } });
  await assert.rejects(transport.qualify(artifact, "direct-jonas-owner", h.roster), /exclusive account:user route/);
  routes = recipients;
  await transport.qualify(artifact, "direct-jonas-owner", h.roster);
  assert.equal(checked, 2);
  assert.throws(() => requireWorkflowReplyRoute("direct-message", "slack:T20001:U10002", true, routes));
  assert.doesNotThrow(() => requireWorkflowReplyRoute("private-channel", "slack:T10001:U10002", true, []));
  assert.doesNotThrow(() => requireWorkflowReplyRoute("direct-message", "slack:T10001:U10002", false, []));
});

test("operator DM root recovery accepts a locator only, never supplied text or a decision", () => {
  const input = { action: "recover-reply", threadId: "slack:D10001:20.000001", messageId: "20.000001", authorId: "U10002" };
  assert.deepEqual(parseWorkflowOperatorRequest(input), input);
  for (const patch of [{ text: "yes" }, { decision: "approved" }, { threadId: "slack:D10001:10.000001" }]) {
    assert.throws(() => parseWorkflowOperatorRequest({ ...input, ...patch }));
  }
});

test("human replies shared to the conversation retain their original thread identity and text", async () => {
  const h = engineFixture();
  for (const channelId of ["D10001", "C10001", "G10001"]) {
    for (const representation of [undefined, "conversation"] as const) {
      let subtype: string | undefined;
      const raw = () => ({ type: "message", ts: "20.000001", thread_ts: "10.000001", user: "U10002",
        text: "1. Done.\n2. Not started; sick.", ...(subtype ? { subtype } : {}) });
      const transport = new WorkflowSlackTransport({
        call: async (method) => {
          if (method === "auth.test") return { ok: true, team_id: "T10001" };
          if (method === "users.info") return { ok: true, user: { id: "U10002", team_id: "T10001", deleted: false, is_bot: false } };
          assert.equal(method, "conversations.replies");
          return { ok: true, messages: [raw()] };
        },
        conversationReply: async () => ({ raw: raw(), text: raw().text }),
      });
      const args = { conversation: { surface: "slack", accountId: "T10001", channelId, threadId: "10.000001", subjectPrincipal: "slack:T10001:U10002" },
        messageId: "20.000001", roster: h.roster, representation };
      const original = await transport.reply(args);
      subtype = "thread_broadcast";
      assert.deepEqual(await transport.reply(args), original, "sharing a reply must not change its event identity or content");
    }
  }
});

test("broadcast replies still reject bots, edits, wrong audience and root masquerading", async () => {
  const h = engineFixture();
  const original = { type: "message", ts: "20.000001", thread_ts: "10.000001", user: "U10002", text: "My answer", subtype: "thread_broadcast" };
  let message: Record<string, unknown> = original;
  const transport = new WorkflowSlackTransport({ call: async (method, args) => {
    if (method === "auth.test") return { ok: true, team_id: "T10001" };
    if (method === "users.info") return { ok: true, user: { id: args.user, team_id: "T10001", deleted: false, is_bot: false } };
    return { ok: true, messages: [message] };
  } });
  const args = { conversation: { surface: "slack", accountId: "T10001", channelId: "D10001", threadId: "10.000001", subjectPrincipal: "slack:T10001:U10002" },
    messageId: "20.000001", roster: h.roster };
  for (const patch of [{ bot_id: "B10001" }, { app_id: "A10001" }, { edited: { ts: "21.000001" } }, { subtype: "message_changed" },
    { subtype: "message_deleted" }, { subtype: "channel_join" }, { subtype: "file_share" }, { thread_ts: "9.000001" },
    { user: "U10001" }, { text: undefined }]) {
    message = { ...original, ...patch };
    await assert.rejects(transport.reply(args));
  }
  message = { ...original, thread_ts: original.ts };
  await assert.rejects(transport.reply({ ...args, channelReply: true }), /original attributable/);
});
