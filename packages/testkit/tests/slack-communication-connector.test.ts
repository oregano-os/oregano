import assert from "node:assert/strict";
import { test } from "node:test";
import { SlackCommunicationConnector } from "../../connectors/slack/communication.ts";

const context = {
  instanceId: "fixture-instance",
  runId: "run-1",
  stepId: "publish",
  agentId: "sprint",
  toolId: "oregano:communications/publish",
  idempotencyKey: "effect-1",
};

test("Slack communication publishes only through an exact destination binding and returns a provider receipt", async () => {
  const calls: unknown[] = [];
  const connector = new SlackCommunicationConnector({
    bindings: [
      { id: "sprint-test-channel", accountId: "T12345", kind: "channel", channelId: "C12345" },
      { id: "steward-test-dm", accountId: "T12345", kind: "direct-message", userId: "U12345" },
    ],
    async beforeDirectPublish({ binding, threadReference, context }) {
      calls.push({ kind: "before-direct-message", binding: binding.id, threadReference, agentId: context.agentId });
    },
    publisher: {
      async publishChannel(channelId, content, threadReference) {
        calls.push({ kind: "channel", channelId, content, threadReference });
        return { messageId: "m-channel", threadReference: "t-channel", publishedAt: "2030-01-01T10:00:00.000Z" };
      },
      async openDirect(userId) {
        calls.push({ kind: "direct-message-open", userId });
        return {
          threadReference: "slack:D12345",
          async publish(content: string) {
            calls.push({ kind: "direct-message", userId, content });
            return { messageId: "m-direct", threadReference: "slack:D12345", publishedAt: "2030-01-01T10:00:01.000Z" };
          },
        };
      },
    },
  });

  const channel = await connector.invoke("communication.message.publish", {
    destination_binding: "sprint-test-channel",
    content: "Stage-0 test",
  }, context);
  const direct = await connector.invoke("communication.message.publish", {
    destination_binding: "steward-test-dm",
    content: "Stage-0 DM test",
  }, { ...context, idempotencyKey: "effect-2" });

  assert.deepEqual(calls, [
    { kind: "channel", channelId: "C12345", content: "Stage-0 test", threadReference: undefined },
    { kind: "direct-message-open", userId: "U12345" },
    { kind: "before-direct-message", binding: "steward-test-dm", threadReference: "slack:D12345", agentId: "sprint" },
    { kind: "direct-message", userId: "U12345", content: "Stage-0 DM test" },
  ]);
  assert.equal((channel.output as any).message_id, "m-channel");
  assert.equal((direct.output as any).message_id, "m-direct");
  await assert.rejects(() => connector.invoke("communication.message.publish", {
    destination_binding: "production-channel",
    content: "must not publish",
  }, { ...context, idempotencyKey: "effect-3" }), /not available/);
});

test("Slack communication refuses missing effect claims and malformed destination bindings", async () => {
  const publisher = {
    async publishChannel() { throw new Error("must not run"); },
    async openDirect() { throw new Error("must not run"); },
  };
  assert.throws(() => new SlackCommunicationConnector({
    bindings: [{ id: "invalid", accountId: "T12345", kind: "channel", channelId: "C12345", userId: "U12345" }],
    publisher,
  }), /requires only channelId/);
  const connector = new SlackCommunicationConnector({
    bindings: [{ id: "channel", accountId: "T12345", kind: "channel", channelId: "C12345" }],
    publisher,
  });
  await assert.rejects(() => connector.invoke("communication.message.publish", {
    destination_binding: "channel",
    content: "must not publish",
  }, { ...context, idempotencyKey: undefined }), /idempotency key/);
});
