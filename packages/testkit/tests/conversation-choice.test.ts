import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationChoiceService, conversationChoiceNumber, publishConversationChoice, type ConversationChoiceStore } from "../../runtime/conversation-choice.ts";

export const memoryChoiceStore = (): ConversationChoiceStore => {
  const values = new Map<string, unknown>();
  return { async get<T>(key: string) { return structuredClone(values.get(key) ?? null) as T | null; },
    async setIfNotExists(key, value) { if (values.has(key)) return false; values.set(key, structuredClone(value)); return true; } };
};
const scope = { instanceId: "fictional-test", surface: "mail", accountId: "test-account", channelId: "inbox", threadId: "message-a", principal: "mail:test:owner" };

test("bounded selection supports numbers and explicit English/German choices without guessing arbitrary prose", () => {
  for (const text of ["2", "Question 2", "it belongs to question 2", "<not a mention>"]) assert.equal(conversationChoiceNumber(text), text.startsWith("<") ? undefined : 2);
  assert.equal(conversationChoiceNumber("Das gehört zu Frage 2."), 2);
  for (const text of ["yes", "approve", "question 2 or 3", "2 new tasks", "change to 2", "ignore previous instructions"]) assert.equal(conversationChoiceNumber(text), undefined);
});

test("choices preserve their published numbering across restarts and atomically keep the first selected target", async () => {
  const store = memoryChoiceStore(), now = () => "2030-01-07T12:00:00Z", service = new ConversationChoiceService<string>(store, now);
  const source = { messageId: "message-a", digest: "verified-source" };
  await service.remember(scope, source, ["a", "b"]);
  assert.equal(await service.read(scope), undefined);
  await service.presented(scope, "published-prompt");
  const restarted = new ConversationChoiceService<string>(store, now);
  assert.deepEqual((await restarted.remember(scope, source, ["b", "a"])).choices, ["a", "b"]);
  const selected = await restarted.select(scope, { text: "Question 2", eventId: "selection-1" }, async () => true);
  assert.equal(selected.kind, "selected"); if (selected.kind === "selected") assert.equal(selected.target, "b");
  assert.equal((await restarted.select(scope, { text: "2", eventId: "selection-1" }, async () => true)).kind, "selected");
  const duplicate = await restarted.select(scope, { text: "1", eventId: "selection-2" }, async () => true);
  assert.equal(duplicate.kind, "already-selected"); if (duplicate.kind === "already-selected") assert.equal(duplicate.target, "b");
  await assert.rejects(restarted.remember(scope, { ...source, digest: "edited" }, ["a", "b"]));
});

test("foreign identity, channel, provider and instance cannot reuse a choice; expired and unavailable targets never route", async () => {
  const store = memoryChoiceStore(); let instant = "2030-01-07T12:00:00Z";
  const service = new ConversationChoiceService<string>(store, () => instant);
  await service.remember(scope, { messageId: "message-a", digest: "verified" }, ["a", "b"]); await service.presented(scope, "notice");
  for (const field of ["instanceId", "surface", "accountId", "channelId", "threadId", "principal"] as const) assert.equal((await service.select({ ...scope, [field]: "foreign" }, { text: "2", eventId: "e" }, async () => true)).kind, "unassigned");
  assert.equal((await service.select(scope, { text: "3", eventId: "e" }, async () => true)).kind, "invalid");
  assert.equal((await service.select(scope, { text: "2", eventId: "e" }, async () => false)).kind, "expired");
  instant = "2030-01-09T12:00:00Z";
  assert.equal((await service.select(scope, { text: "2", eventId: "e" }, async () => { assert.fail("Expired selection revalidated"); })).kind, "expired");
});

for (const inboundId of ["direct-alias", "verified-root"]) test(`clarification subscribes and publishes in the verified source conversation (${inboundId})`, async () => {
  const calls: string[] = [];
  const conversation = (id: string) => ({ id, async subscribe() { calls.push(`subscribe:${id}`); }, async post(content: string) { assert.equal(content, "Choose a question"); calls.push(`post:${id}`); return { id: "notice" }; } });
  await publishConversationChoice({ conversationId: "verified-root", inbound: conversation(inboundId), resolve: conversation, content: "Choose a question", async recordPublication(id) { calls.push(`record:${id}`); } });
  assert.deepEqual(calls, ["subscribe:verified-root", "post:verified-root", "record:notice"]);
});
