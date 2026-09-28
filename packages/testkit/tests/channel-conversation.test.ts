import assert from "node:assert/strict";
import { test } from "node:test";
import { allowsChannelConversation, validateAgentRouting, type CompiledAgentRouting } from "../../runtime/agent-resolver.ts";
import { allowsConversationAtThread } from "../../runner-vercel/src/lib/channel-conversation.ts";

const routing: CompiledAgentRouting = {
  defaultAgentId: "assistant",
  bindings: [
    { id: "reports", agentId: "assistant", surface: "slack", accountId: "T1", channelId: "C1", conversationMode: "workflow-posts-only" },
    { id: "test", agentId: "assistant", surface: "slack", accountId: "T1", channelId: "C2", conversationMode: "conversation" },
  ],
};

test("workflow-only channel blocks roots, subscribed threads and recovery addresses independently of default Agent", () => {
  for (const thread of ["slack:C1:", "slack:C1:123.456", "slack:C1:789.123"]) {
    assert.equal(allowsConversationAtThread(routing, thread, "slack:T1:U1"), false);
  }
});

test("conversation test channel, DMs and legacy bindings remain conversational", () => {
  for (const thread of ["slack:C2:", "slack:C2:123.456", "slack:D1:", "slack:D1:123.456"]) {
    assert.equal(allowsConversationAtThread(routing, thread, "slack:T1:U1"), true);
  }
  const legacy = { bindings: routing.bindings.map(({ conversationMode, ...binding }) => binding) };
  assert.equal(allowsConversationAtThread(legacy, "slack:C1:123", "slack:T1:U1"), true);
});

test("policy is exact-account and surface scoped, and malformed identities fail closed", () => {
  assert.equal(allowsChannelConversation(routing, { surface: "slack", accountId: "T2", channelId: "C1" }), true);
  assert.equal(allowsChannelConversation(routing, { surface: "other", accountId: "T1", channelId: "C1" }), true);
  for (const principal of [undefined, "slack:T1", "other:T1:U1"]) {
    assert.equal(allowsConversationAtThread(routing, "slack:C1:", principal), false);
  }
});

test("invalid and ambiguous Artifact policies cannot enable conversation", () => {
  const invalid = { bindings: [{ ...routing.bindings[0]!, conversationMode: "typo" as "conversation" }] };
  assert.throws(() => validateAgentRouting(invalid, ["assistant"]), /Invalid conversation mode/);
  assert.equal(allowsConversationAtThread(invalid, "slack:C1:", "slack:T1:U1"), false);
  assert.equal(allowsConversationAtThread({ bindings: [routing.bindings[0]!, { ...routing.bindings[0]!, id: "duplicate", conversationMode: "conversation" }] }, "slack:C1:", "slack:T1:U1"), false);
});
