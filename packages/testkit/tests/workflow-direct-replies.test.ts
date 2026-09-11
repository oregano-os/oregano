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
