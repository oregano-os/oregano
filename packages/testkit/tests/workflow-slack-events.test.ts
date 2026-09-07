import test from "node:test";
import assert from "node:assert/strict";
import { requireWorkflowSlackReplyEvents } from "../../runner-vercel/src/lib/workflow-slack-events.ts";
import { WorkflowSlackTransport } from "../../connectors/slack/workflow-transport.ts";
import { engineFixture } from "../workflow-engine-fixture.ts";

test("mentions and DM events do not qualify a private-channel conversation", () => {
  const metadata = { type: "slack", triggers: { enabled: true }, events: ["app_mention", "message.im"] };
  assert.throws(() => requireWorkflowSlackReplyEvents(metadata, "private-channel"), /enable message.groups/);
  assert.doesNotThrow(() => requireWorkflowSlackReplyEvents(metadata, "direct-message"));
  assert.throws(() => requireWorkflowSlackReplyEvents(metadata, "public-channel"), /enable message.channels/);
  assert.doesNotThrow(() => requireWorkflowSlackReplyEvents({ ...metadata, events: ["message.groups"] }, "private-channel"));
  for (const invalid of [null, {}, { ...metadata, triggers: { enabled: false } }, { ...metadata, events: "message.im" }]) {
    assert.throws(() => requireWorkflowSlackReplyEvents(invalid, "direct-message"));
  }
});

test("recipient publication qualification uses actual channel visibility and fails before sending", async () => {
  const h = engineFixture(), artifact = structuredClone(h.artifact);
  artifact.bindings = artifact.bindings.map((b) => b.capability === "communication.message.publish" ? { ...b, connector: "oregano/slack-communication", connectorVersion: "0.1.0" } : b);
  artifact.connectors = [{ id: "slack", connector: "oregano/slack-communication", connectorVersion: "0.1.0", configuration: { destinations: [
    { id: "direct-jonas-owner", account_id: "T10001", kind: "channel", channel_id: "C10001" },
  ] } }];
  let checked = 0, events = ["app_mention", "message.im"];
  const transport = new WorkflowSlackTransport({ call: async (method, args) => {
    if (method === "auth.test") return { ok: true, team_id: "T10001" };
    if (method === "users.info") return { ok: true, user: { id: args.user, team_id: "T10001", deleted: false, is_bot: false } };
    return { ok: true, channel: { id: args.channel, is_im: false, is_archived: false, is_private: true } };
  }, qualifyReplies: async (kind) => { checked++; assert.equal(kind, "private-channel"); requireWorkflowSlackReplyEvents({ type: "slack", triggers: { enabled: true }, events }, kind); } });
  await assert.rejects(transport.qualify(artifact, "direct-jonas-owner", h.roster), /message.groups/); assert.equal(checked, 1);
  events = ["message.groups"]; await transport.qualify(artifact, "direct-jonas-owner", h.roster); assert.equal(checked, 2);
});
