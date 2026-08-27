import assert from "node:assert/strict";
import test from "node:test";
import type { ActionEvent, Adapter } from "chat";
import {
  builderCancelledActionCard,
  builderQueuedActionCard,
  resolveBuilderActionCard,
  type BuilderActionCard,
} from "./action-cards.ts";

const job = {
  jobId: "builder-123",
  objective: "Update one bounded guide.",
  repositoryId: "acme/company-workspace",
  baseCommit: "a".repeat(40),
  targetBranchName: "reviewed/company-workspace",
};

function actionIds(card: BuilderActionCard): string[] {
  return card.children.flatMap((child) =>
    child.type === "actions"
      ? child.children.map((action) => action.id).filter((id): id is string => id !== undefined)
      : []
  );
}

test("queued Builder card resolves confirmation actions and retains cancellation", () => {
  const card = builderQueuedActionCard(job);

  assert.equal(card.title, "CompanyOS Builder proposal queued");
  assert.deepEqual(actionIds(card), ["companyos.builder.stop"]);
  assert.doesNotMatch(JSON.stringify(card), /companyos\.builder\.(confirm|cancel)/);
  assert.match(JSON.stringify(card), /reviewed\/company-workspace/);
});

test("cancelled Builder card is terminal and contains no actions", () => {
  const { jobId: _jobId, ...confirmation } = job;
  const card = builderCancelledActionCard(confirmation);

  assert.equal(card.title, "CompanyOS Builder proposal cancelled");
  assert.deepEqual(actionIds(card), []);
  assert.match(JSON.stringify(card), /No coding agent was started/);
});

test("confirmation is consumed only after the original action message is replaced", async () => {
  const calls: string[] = [];
  const card = builderQueuedActionCard(job);
  const adapter = {
    editMessage: async (threadId: string, messageId: string, replacement: BuilderActionCard) => {
      calls.push(`edit:${threadId}:${messageId}:${replacement.title}`);
      return {};
    },
  } as unknown as Adapter;
  const event = {
    adapter,
    messageId: "message-123",
    threadId: "slack:channel:thread",
  } satisfies Pick<ActionEvent, "adapter" | "messageId" | "threadId">;

  await resolveBuilderActionCard(event, card, async () => {
    calls.push("consume");
  });

  assert.deepEqual(calls, [
    "edit:slack:channel:thread:message-123:CompanyOS Builder proposal queued",
    "consume",
  ]);
});

test("failed action-message replacement leaves the confirmation retryable", async () => {
  let consumed = false;
  const adapter = {
    editMessage: async () => {
      throw new Error("temporary chat provider failure");
    },
  } as unknown as Adapter;
  const event = {
    adapter,
    messageId: "message-123",
    threadId: "slack:channel:thread",
  } satisfies Pick<ActionEvent, "adapter" | "messageId" | "threadId">;

  await assert.rejects(
    resolveBuilderActionCard(event, builderQueuedActionCard(job), async () => {
      consumed = true;
    }),
    /temporary chat provider failure/,
  );
  assert.equal(consumed, false);
});
