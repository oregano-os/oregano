import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { interpretConversation } from "./conversation-coordinator.ts";
import { SharedConversationTurn, EMPTY_ATTENTION, type ConversationReceipt } from "../../../runtime/shared-conversation.ts";

for (const reply of ["the second", "it is for question 2", "the invoicing process"]) {
  test(`model-selected clarification uses the retained source: ${reply}`, async () => {
    const scope = { instanceId: "example", principal: "human:alex", surface: "mcp", accountId: "company", channelId: "inbox" };
    const address = { surface: "mcp", accountId: "company", channelId: "inbox", threadId: "clarification" };
    const source = { eventId: "original", messageId: "original", text: "Start on Friday", address };
    const attention = { ...EMPTY_ATTENTION(), pending: [{ source, candidates: ["one", "two"], question: "Sales or invoicing?", expiresAt: "2030-01-05T00:00:00Z" }] };
    let saved: ConversationReceipt | undefined;
    const turn = await SharedConversationTurn.open({ scope, input: { eventId: "choice", messageId: "choice", text: reply, address }, now: "2030-01-04T12:00:00Z", coordinatorId: "general",
      store: { async read() { return attention; }, async receipt() { return saved; }, async commit(_scope, _revision, _next, _event, receipt) { saved = receipt; return true; } },
      source: { async current() { return undefined; }, async search() { return { items: [] }; }, async read(_scope, id) { return {
        id, kind: "workflow", agentId: "specialist", title: id === "two" ? "invoicing" : "sales", summary: "Waiting for a start date", status: "waiting", version: "1", terminal: false, address: { ...address, threadId: id },
      }; } }, authorize: async () => { throw new Error("Unexpected handoff"); },
    });
    const model = new MockLanguageModelV3({ doGenerate: async options => {
      const prompt = JSON.stringify(options.prompt);
      assert.ok(prompt.includes(reply)); assert.ok(prompt.includes("Start on Friday"));
      return { content: [{ type: "tool-call", toolCallId: "plan", toolName: "companyos_conversation_plan", input: JSON.stringify({ reply: "I assigned your answer to invoicing.", usePendingMessageId: "original", routes: [{ workId: "two", text: "Start on Friday" }] }) }],
        finishReason: { unified: "tool-calls", raw: undefined }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }, warnings: [] };
    } });
    const result = await interpretConversation({ turn, agent: { id: "general", instructions: "Coordinate concerns.", materials: {}, tools: [], toolSet: { agentId: "general", hash: "fixture", resolverVersion: "1", tools: [] } }, specialists: [], signal: new AbortController().signal, model });
    assert.equal(result.receipt.concerns[0]?.text, "Start on Friday"); assert.equal(result.receipt.concerns[0]?.work?.id, "two");
    assert.equal(result.receipt.concerns[0]?.needsAcknowledgement, true); assert.equal(model.doGenerateCalls.length, 1);
  });
}

test("the existing coordinator records silence without invoking a new Agent or dispatching a concern", async () => {
  const scope = { instanceId: "example", principal: "human:alex", surface: "synthetic-chat", accountId: "company", channelId: "inbox" };
  const address = { surface: scope.surface, accountId: scope.accountId, channelId: scope.channelId, threadId: "team" };
  const message = { id: "one", conversationId: "synthetic-chat:inbox:team", senderId: scope.principal, senderName: "Alex",
    sentAt: "2030-01-04T12:00:00Z", shared: true, mentioned: false, text: "Bob, let's review this tomorrow." };
  let saved: ConversationReceipt | undefined;
  const turn = await SharedConversationTurn.open({ scope, input: { eventId: "one", messageId: "one", text: message.text, address, message },
    coordinatorId: "general", now: message.sentAt,
    store: { async read() { return EMPTY_ATTENTION(); }, async receipt() { return saved; }, async commit(_scope, _revision, _next, _event, receipt) { saved = receipt; return true; } },
    source: { async current() { return undefined; }, async search() { return { items: [] }; }, async read() { return undefined; } },
    authorize: async () => { throw new Error("Silent discussion must not dispatch"); },
  });
  const model = new MockLanguageModelV3({ doGenerate: async options => {
    assert.match(JSON.stringify(options.prompt), /senderName/);
    return { content: [{ type: "tool-call", toolCallId: "plan", toolName: "companyos_conversation_plan", input: JSON.stringify({ participation: "context-only", reply: "", routes: [] }) }],
      finishReason: { unified: "tool-calls", raw: undefined }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }, warnings: [] };
  } });
  const result = await interpretConversation({ turn, agent: { id: "general", instructions: "Coordinate concerns.", materials: {}, tools: [], toolSet: { agentId: "general", hash: "fixture", resolverVersion: "1", tools: [] } }, specialists: [], signal: new AbortController().signal, model });
  assert.equal(result.receipt.plan.participation, "context-only");
  assert.equal(result.receipt.concerns.length, 0);
  assert.equal(model.doGenerateCalls.length, 1);
});
