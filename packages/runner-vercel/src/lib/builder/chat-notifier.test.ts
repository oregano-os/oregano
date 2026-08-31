import assert from "node:assert/strict";
import test from "node:test";
import type { Chat, Thread } from "chat";
import type { BuilderJob } from "../../../../state-store/builder-jobs.ts";
import { createBuilderChatNotifier } from "./chat-notifier.ts";

function failedJob(sourceMessageId?: string): BuilderJob {
  return {
    schemaVersion: 1,
    jobId: "builder-123",
    requestId: "request-123",
    instanceId: "fixture",
    requesterPrincipal: "slack:T1:U1",
    agentId: "builder",
    sourceConversationKey: "slack:C1:thread",
    ...(sourceMessageId ? { sourceMessageId } : {}),
    objective: "Update company.md with the required Change Plan.",
    repositoryId: "fixture/workspace",
    baseCommit: "a".repeat(40),
    sourceBindingId: "source",
    proposalPublisherBindingId: "publisher",
    execution: { adapterId: "test", profile: "isolated-v1", timeoutMs: 60_000 },
    codingAgent: {
      protocol: "acp-v1",
      profileId: "codex",
      implementation: "@agentclientprotocol/codex-acp",
      version: "1.6.2",
    },
    fingerprint: "b".repeat(64),
    state: "failed",
    attempts: 2,
    createdAt: "2026-08-27T10:00:00.000Z",
    updatedAt: "2026-08-27T10:02:00.000Z",
    terminalReason: "checked fixture failure",
  };
}

function fakeChat(calls: string[]): Pick<Chat, "thread"> {
  const thread = {
    id: "slack:C1:thread",
    adapter: {
      async editMessage(threadId: string, messageId: string) {
        calls.push(`edit:${threadId}:${messageId}`);
        return {};
      },
    },
    async post() {
      calls.push("post");
      return {};
    },
  } as unknown as Thread;
  return { thread: () => thread } as unknown as Pick<Chat, "thread">;
}

test("terminal notifier replaces the stored action card for new jobs", async () => {
  const calls: string[] = [];
  await createBuilderChatNotifier(fakeChat(calls)).deliver(failedJob("message-123"));
  assert.deepEqual(calls, ["edit:slack:C1:thread:message-123"]);
});

test("terminal notifier posts a fallback for legacy jobs without a message identity", async () => {
  const calls: string[] = [];
  await createBuilderChatNotifier(fakeChat(calls)).deliver(failedJob());
  assert.deepEqual(calls, ["post"]);
});
