import assert from "node:assert/strict";
import { test } from "node:test";
import { slackRecentMessages, type SlackHistoryClient } from "../../runner-vercel/src/lib/slack-recent-messages.ts";
import { SharedConversationTurn, EMPTY_ATTENTION } from "../../runtime/shared-conversation.ts";
import { CONVERSATION_COORDINATOR_INSTRUCTIONS } from "../../runner-vercel/src/lib/conversation-coordinator.ts";

const roster = [{ name: "Alex Taylor", role: "owner", status: "active", mayApprove: [], principals: ["slack:T1:U1"] }] as any;
const ts = (n: number) => `1789303${String(n).padStart(3, "0")}.000100`;

function client(messages: Record<string, unknown>[], calls: unknown[] = []): SlackHistoryClient {
  return { conversations: {
    async history(args) { calls.push(["history", args]); return { ok: true, messages: [...messages].reverse() as any }; },
    async replies(args) { calls.push(["replies", args]); return { ok: true, messages: messages as any }; },
  } };
}

test("a main-channel or DM message receives the ten previous messages, including app posts, oldest first", async () => {
  const calls: unknown[] = [];
  const messages = [...Array.from({ length: 12 }, (_, i) => ({ ts: ts(i), user: "U1", text: "note " + i })),
    { ts: ts(12), bot_id: "B1", username: "oregano", text: "Let us prepare the brief for this planned card." }];
  const recent = await slackRecentMessages({ client: client(messages, calls), accountId: "T1", channelId: "D1", threadId: ts(20), messageId: ts(20), roster });
  assert.deepEqual(calls[0], ["history", { channel: "D1", latest: ts(20), inclusive: false, limit: 10 }]);
  assert.equal(recent.length, 10);
  assert.equal(recent.at(-1)!.kind, "app"); assert.equal(recent.at(-1)!.sender, "oregano");
  assert.match(recent.at(-1)!.text, /prepare the brief/);
  assert.equal(recent[0]!.sender, "Alex Taylor"); assert.equal(recent[0]!.kind, "human");
  assert.ok(recent.every((m, i) => i === 0 || Number(m.messageId) > Number(recent[i - 1]!.messageId)));
});

test("a thread reply receives the thread root and the ten previous replies, never later messages", async () => {
  const calls: unknown[] = [];
  const root = ts(0);
  const messages = [{ ts: root, bot_id: "B1", username: "oregano", text: "Card" },
    ...Array.from({ length: 14 }, (_, i) => ({ ts: ts(i + 1), thread_ts: root, user: i % 2 ? "U1" : "U9", text: "reply " + i })),
    { ts: ts(30), thread_ts: root, user: "U1", text: "later" }];
  const recent = await slackRecentMessages({ client: client(messages, calls), accountId: "T1", channelId: "D1", threadId: root, messageId: ts(15), roster });
  assert.equal((calls[0] as any)[0], "replies");
  assert.equal(recent[0]!.messageId, root);
  assert.equal(recent.length, 11);
  assert.ok(recent.every(m => Number(m.messageId) < Number(ts(15))));
  assert.equal(recent.find(m => m.text === "reply 4")!.kind, "other");
  await assert.rejects(slackRecentMessages({ client: client([]), accountId: "T1", channelId: "D1", threadId: "bad", messageId: ts(1), roster }), /exact Slack/);
});

async function turnWith(recentMessages: any) {
  const scope = { instanceId: "example", principal: "slack:T1:U1", surface: "slack", accountId: "T1", channelId: "D1" };
  const address = { surface: "slack", accountId: "T1", channelId: "D1", threadId: ts(50) };
  return SharedConversationTurn.open({ scope, input: { eventId: "e", messageId: ts(50), text: "Objective: …", address }, coordinatorId: "general", now: "2030-01-04T12:00:00Z",
    store: { async read() { return EMPTY_ATTENTION(); }, async receipt() { return undefined; }, async commit() { return true; } },
    source: { async current() { return undefined; }, async search() { return { items: [] }; }, async read() { return undefined; }, recentMessages },
    authorize: async () => { throw new Error("Unexpected handoff"); } });
}

test("paginated threads keep the root and the latest replies across pages", async () => {
  const calls: any[] = [], root = ts(0);
  const messages = [{ ts: root, text: "Root" }, ...Array.from({ length: 220 }, (_, i) => ({ ts: ts(i + 1), thread_ts: root, text: `reply ${i + 1}` }))];
  const provider = client([]);
  provider.conversations.replies = async args => {
    calls.push(args);
    return args.cursor === "next" ? { ok: true, messages: messages.slice(199) }
      : { ok: true, messages: messages.slice(0, 200), has_more: true, response_metadata: { next_cursor: "next" } };
  };
  const recent = await slackRecentMessages({ client: provider, accountId: "T1", channelId: "D1", threadId: root, messageId: ts(230), roster });
  assert.deepEqual(recent.map(m => m.messageId), [root, ...messages.slice(-10).map(m => m.ts)]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { channel: "D1", ts: root, latest: ts(230), inclusive: false, limit: 200, cursor: "next" });
});

test("incomplete or cyclic thread pagination cannot supply stale recent context", async () => {
  for (const mode of ["missing", "cycle", "limit", "error"] as const) {
    let calls = 0;
    const provider = client([]);
    provider.conversations.replies = async () => {
      calls++;
      if (mode === "error" && calls === 2) return { ok: false };
      return { ok: true, messages: [{ ts: ts(calls), thread_ts: ts(0), text: "Old reply" }], has_more: true,
        response_metadata: { next_cursor: mode === "missing" ? "" : mode === "cycle" ? "same" : String(calls) } };
    };
    await assert.rejects(slackRecentMessages({ client: provider, accountId: "T1", channelId: "D1", threadId: ts(0), messageId: ts(999), roster }), /incomplete|no readable/);
    assert.equal(calls, mode === "missing" ? 1 : mode === "limit" ? 10 : 2);
  }
});

test("the coordinator context carries bounded recent messages and survives a transport failure", async () => {
  const long = Array.from({ length: 10 }, (_, i) => ({ messageId: ts(i), sentAt: "2030-01-04T11:00:00Z", sender: "oregano", kind: "app", text: "x".repeat(3000) }));
  const context = await (await turnWith(async (_scope: unknown, address: any, messageId: string) => {
    assert.equal(address.channelId, "D1"); assert.equal(messageId, ts(50)); return long;
  })).initialContext();
  assert.ok(context.recent_messages.length >= 1 && context.recent_messages.length <= 10);
  assert.ok(context.recent_messages.every(m => m.text.length <= 1500));
  assert.ok(JSON.stringify(context.recent_messages).length <= 9000);
  assert.equal(context.recent_messages.at(-1)!.messageId, ts(9), "the newest messages are kept");
  const failed = await (await turnWith(async () => { throw new Error("missing im:history"); })).initialContext();
  assert.deepEqual(failed.recent_messages, []);
  assert.deepEqual((await (await turnWith(undefined)).initialContext()).recent_messages, []);
});

test("coordinator instructions use recent messages to attach answers and forbid invented closure", () => {
  assert.match(CONVERSATION_COORDINATOR_INSTRUCTIONS, /recent_messages/);
  assert.match(CONVERSATION_COORDINATOR_INSTRUCTIONS, /route it to that work instead of opening a new discussion/);
  assert.match(CONVERSATION_COORDINATOR_INSTRUCTIONS, /several works, ask with clarify/);
  assert.match(CONVERSATION_COORDINATOR_INSTRUCTIONS, /Never say that work is closed/);
  assert.doesNotMatch(CONVERSATION_COORDINATOR_INSTRUCTIONS, /An unrelated new request stays new even if only one question is waiting/);
});

test("every answering Agent receives the recent messages at the same place as untrusted context", async () => {
  const { conversationContext } = await import("../../runtime/conversation-participation.ts");
  const message = { id: ts(60), text: "Objective: shorter prep", senderId: "slack:T1:U1", senderName: "Alex Taylor", sentAt: "2030-01-04T12:00:00Z", conversationId: "slack:D1:" + ts(60), shared: false, mentioned: false } as any;
  const recent = [{ messageId: ts(59), sentAt: "2030-01-04T11:59:00Z", sender: "oregano", kind: "app" as const, text: "Let us prepare the brief for this planned card." + "y".repeat(2000) }];
  const context = JSON.parse(conversationContext(message, [], recent));
  assert.equal(context.recentMessagesAtThisPlace.length, 1);
  assert.match(context.recentMessagesAtThisPlace[0].text, /^Let us prepare the brief/);
  assert.ok(context.recentMessagesAtThisPlace[0].text.length <= 1500);
  assert.match(context.note, /recentMessagesAtThisPlace/);
  assert.equal(JSON.parse(conversationContext(message, [])).recentMessagesAtThisPlace, undefined, "no provider history keeps the historical context shape");
});
