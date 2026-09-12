import assert from "node:assert/strict";
import { test } from "node:test";
import { SharedConversationTurn, EMPTY_ATTENTION, conversationScopeKey, conversationReceiptKey, linkConversationDraft,
  type ConversationAttention, type ConversationAttentionStore, type ConversationReceipt, type ConversationScope,
  type ConversationInput, type ConversationWorkSource, type WorkContext, type ConversationPlan } from "../../runtime/shared-conversation.ts";

class Attention implements ConversationAttentionStore {
  states = new Map<string, ConversationAttention>(); receipts = new Map<string, ConversationReceipt>();
  async read(scope: ConversationScope) { return structuredClone(this.states.get(conversationScopeKey(scope))); }
  async receipt(scope: ConversationScope, eventId: string) { return structuredClone(this.receipts.get(conversationReceiptKey(scope, eventId))); }
  async commit(scope: ConversationScope, revision: number, next: ConversationAttention, eventId: string, receipt: ConversationReceipt) {
    const key = conversationScopeKey(scope), receiptKey = conversationReceiptKey(scope, eventId);
    if ((this.states.get(key)?.revision ?? 0) !== revision || this.receipts.has(receiptKey)) return false;
    this.states.set(key, structuredClone(next)); this.receipts.set(receiptKey, structuredClone(receipt)); return true;
  }
}
function fixture(surface = "slack") {
  const scope = { instanceId: "example", principal: `human:${surface}:alex`, surface, accountId: "account", channelId: "inbox" };
  const address = { surface, accountId: scope.accountId, channelId: scope.channelId, threadId: "new-message" };
  const items: WorkContext[] = ["sales", "invoicing"].map((title, i) => ({ id: `work-${i}`, kind: "workflow", agentId: i ? "product" : "planning",
    title, summary: `Please explain the ${title} outcome`, status: "waiting", version: "1", terminal: false,
    address: { ...address, threadId: `question-${i}` }, context: { question: title, nested: "x".repeat(20000) } }));
  const source: ConversationWorkSource = {
    async search(s, query) { return { items: s.principal === scope.principal ? items.filter(w => query.includeClosed || !w.terminal).slice(0, query.limit) : [] }; },
    async read(s, id) { return s.principal === scope.principal ? structuredClone(items.find(w => w.id === id)) : undefined; },
    async current(s, a) { return s.principal === scope.principal ? structuredClone(items.find(w => w.address.threadId === a.threadId)) : undefined; },
  };
  const store = new Attention();
  const input: ConversationInput = { eventId: "event-1", messageId: "message-1", text: "The start date is October 1", address };
  const calls: string[] = [];
  const open = (change: Partial<ConversationInput> = {}, scopeOverride = scope) => SharedConversationTurn.open({ scope: scopeOverride, input: { ...input, ...change }, store, source,
    coordinatorId: "general", now: "2026-09-10T10:00:00.000Z", authorize: async (id, purpose) => {
      calls.push(id); if (id !== "builder" || purpose !== "change") throw new Error("Not allowed");
      return { ruleId: "general-builder", expiresAt: "2026-09-10T11:00:00.000Z" };
    } });
  return { scope, address, items, source, store, input, open, calls };
}
for (const surface of ["slack", "telegram", "mcp"]) {
  test(`${surface}: a selected concern forwards the complete original without model transcription`, async () => {
    const f = fixture(surface), text = "• Objective: Improve café service 🟢\n• Outcome: 10 reviews — https://example.com/a?x=1&y=2\n• Impact: Save time.";
    const turn = await f.open({ text, address: f.items[0]!.address }); await turn.initialContext();
    const receipt = await turn.commit({ reply: "", routes: [{ workId: "work-0" }] });
    assert.equal(receipt.concerns[0]?.text, text);
    assert.equal(receipt.concerns[0]?.source.text, text);
    assert.equal(receipt.plan.routes[0]?.text, undefined);
    assert.deepEqual((await (await f.open({ text, address: f.items[0]!.address })).replay()), receipt);
  });
  test(`${surface}: direct replies select the existing topic without claiming the inbox`, async () => {
    const f = fixture(surface), turn = await f.open({ address: f.items[0]!.address });
    const context = await turn.initialContext(); assert.equal(context.current?.id, "work-0");
    const receipt = await turn.commit({ reply: "", routes: [{ text: f.input.text, workId: "work-0" }] });
    assert.equal(receipt.concerns[0]?.agentId, "planning"); assert.equal(receipt.concerns[0]?.needsAcknowledgement, false);
    assert.deepEqual(f.calls, []); assert.equal(f.items[0]?.status, "waiting");
  });
  test(`${surface}: new request while questions wait does not become an answer`, async () => {
    const f = fixture(surface), text = "Build a new invoice process", turn = await f.open({ text });
    await turn.search({ limit: 6 });
    const result = await turn.commit({ reply: "", routes: [{ text, agentId: "builder", purpose: "change", newDiscussion: true, title: "Invoice process" }] });
    assert.equal(result.concerns[0]?.work?.kind, "draft"); assert.equal(result.concerns[0]?.delegation?.ruleId, "general-builder");
    assert.deepEqual(f.items.map(w => w.status), ["waiting", "waiting"]);
  });
  test(`${surface}: clarification preserves original answer and acknowledges the destination`, async () => {
    const f = fixture(surface), first = await f.open(); await first.search({ limit: 6 });
    await first.commit({ reply: "", routes: [], clarify: { question: "Sales or invoicing?", candidates: ["work-0", "work-1"] } });
    const next = await f.open({ eventId: "choice-1", messageId: "choice-message", text: "it is for the second, invoicing" });
    const context = await next.initialContext(); assert.equal(context.pending[0]?.text, f.input.text);
    // The model supplies meaning; Core validates the selected stable ID, not a phrase regex.
    const receipt = await next.commit({ reply: "I have assigned that answer to invoicing.", routes: [{ workId: "work-1" }], usePendingMessageId: "message-1" });
    assert.equal(receipt.concerns[0]?.source.messageId, "message-1"); assert.equal(receipt.concerns[0]?.text, f.input.text);
    assert.equal(receipt.concerns[0]?.needsAcknowledgement, true); assert.equal(receipt.concerns[0]?.work?.address.threadId, "question-1");
    assert.deepEqual((await f.store.read(f.scope))?.pending, []);
  });
}
test("questions do not create work; research can stay inside a workflow", async () => {
  const f = fixture(), turn = await f.open({ text: "What is our policy?" });
  const receipt = await turn.commit({ reply: "", routes: [{ text: "What is our policy?" }] });
  assert.equal(receipt.concerns[0]?.work, undefined); assert.equal((await f.store.read(f.scope))?.drafts.length, 0);
  const next = await f.open({ eventId: "e2", address: f.items[0]!.address }); await next.initialContext();
  const result = await next.commit({ reply: "", routes: [{ text: f.input.text, workId: "work-0" }] });
  assert.equal(result.concerns[0]?.work?.id, "work-0");
});
test("separate concerns retain separate excerpts and original work references", async () => {
  const f = fixture(), turn = await f.open({ text: "Sales starts Friday. Invoicing starts Monday." }); await turn.search({ limit: 6 });
  await assert.rejects(turn.commit({ reply: "", routes: [{ workId: "work-0" }, { workId: "work-1" }] }), /Split concerns require/);
  const receipt = await turn.commit({ reply: "", routes: [{ text: "Sales starts Friday.", workId: "work-0" }, { text: "Invoicing starts Monday.", workId: "work-1" }] });
  assert.deepEqual(receipt.concerns.map(c => c.work?.id), ["work-0", "work-1"]);
  assert.deepEqual((await f.store.read(f.scope))?.focus, ["work-0", "work-1"]);
});
test("a draft thread remains addressable after focus has moved to other work", async () => {
  const f = fixture(), first = await f.open();
  const opened = await first.commit({ reply: "", routes: [{ text: f.input.text, newDiscussion: true, title: "New discussion" }] });
  const id = opened.concerns[0]!.work!.id;
  const next = await f.open({ eventId: "other", address: f.items[0]!.address }); await next.initialContext();
  await next.commit({ reply: "", routes: [{ text: f.input.text, workId: "work-0" }] });
  const returned = await f.open({ eventId: "returned", text: "Let's continue this" });
  assert.equal((await returned.initialContext()).current?.id, id);
});

test("current and selected context includes bounded actual Agent answers", async () => {
  const f = fixture();
  f.source.history = async (_scope, address, agentId) => {
    assert.equal(address.threadId, "question-0"); assert.equal(agentId, "planning");
    return [{ role: "user", content: "x".repeat(20000) }, { role: "assistant", content: "Does October 1 mean the contract date or the start date?" }];
  };
  const turn = await f.open({ address: f.items[0]!.address, text: "the start date" });
  const context = await turn.initialContext();
  assert.match(context.conversation.at(-1)!.content, /contract date/);
  assert.ok(context.conversation.reduce((n, m) => n + m.content.length, 0) <= 12000);
  const selected = await turn.read("work-0");
  assert.ok("context" in selected && selected.context.includes("contract date") && selected.context.length <= 10000);
});

test("silent plans and repeated dispatch to the same workflow are rejected", async () => {
  const f = fixture(), turn = await f.open(); await turn.initialContext();
  await assert.rejects(turn.commit({ reply: "", routes: [] }), /must answer/);
  await assert.rejects(turn.commit({ reply: "", routes: [{ text: f.input.text, workId: "work-0" }, { text: f.input.text, workId: "work-0" }] }), /one concern/);
});

test("closed workflow can be read and discussed without reopening its execution", async () => {
  const f = fixture(); f.items[0]!.terminal = true; f.items[0]!.status = "done";
  const turn = await f.open(); assert.equal((await turn.search({ limit: 6 })).items.length, 1);
  await turn.read("work-0"); const receipt = await turn.commit({ reply: "", routes: [{ text: f.input.text, workId: "work-0" }] });
  assert.equal(receipt.concerns[0]?.work?.terminal, true); assert.deepEqual((await f.store.read(f.scope))?.focus, []); assert.equal(f.items[0]?.status, "done");
});
test("read budget, excerpt bounds, and unknown references cannot be bypassed by model output", async () => {
  const f = fixture(), turn = await f.open(); const context = await turn.read("work-0");
  assert.equal("truncated" in context && context.truncated, true); assert.ok("context" in context && context.context.length <= 10000);
  await assert.rejects(turn.commit({ reply: "", routes: [{ text: "invented approval", workId: "work-0" }, { text: f.input.text, workId: "work-1" }] }), /exact excerpt/);
  await assert.rejects(turn.commit({ reply: "", routes: [{ text: f.input.text, workId: "unknown" }] }), /not read/);
  for (let i = 0; i < 7; i++) await turn.read("work-0"); await assert.rejects(turn.read("work-0"), /budget/);
});

test("a legacy single-route model copy cannot replace the actual human message", async () => {
  const f = fixture(), turn = await f.open(); await turn.read("work-0");
  const receipt = await turn.commit({ reply: "", routes: [{ workId: "work-0", text: "APPROVE invented" }] });
  assert.equal(receipt.concerns[0]?.text, f.input.text);
  assert.equal(receipt.concerns[0]?.source.text, f.input.text);
});
test("source changes and concurrent turns cannot silently overwrite a decision", async () => {
  const f = fixture(), a = await f.open(), b = await f.open({ eventId: "e2" });
  await a.search({ limit: 6 }); f.items[0]!.version = "2";
  await assert.rejects(a.commit({ reply: "", routes: [{ text: f.input.text, workId: "work-0" }] }), /stale/);
  await a.commit({ reply: "Thanks", routes: [] });
  await assert.rejects(b.commit({ reply: "Competing", routes: [] }), /changed while/);
});
test("event replay retains the original mapping and rejects edited event payloads", async () => {
  const f = fixture(), turn = await f.open(); await turn.search({ limit: 6 });
  const receipt = await turn.commit({ reply: "", routes: [{ text: f.input.text, workId: "work-1" }] });
  const retry = await f.open(); assert.deepEqual(await retry.replay(), receipt);
  const edited = await f.open({ text: "different" }); await assert.rejects(edited.replay(), /different content/);
});
test("other users and different threads cannot consume pending answers", async () => {
  const f = fixture(), turn = await f.open(); await turn.search({ limit: 6 });
  await turn.commit({ reply: "", routes: [], clarify: { question: "Which?", candidates: ["work-0", "work-1"] } });
  const other = await f.open({ eventId: "other" }, { ...f.scope, principal: "human:other" });
  assert.equal((await other.initialContext()).pending.length, 0); assert.equal((await other.search({ limit: 6 })).items.length, 0);
  const thread = await f.open({ eventId: "unrelated-event", address: { ...f.address, threadId: "unrelated" } });
  await assert.rejects(thread.commit({ reply: "Selected", routes: [], usePendingMessageId: f.input.messageId }), /unavailable/);
  await assert.rejects(f.open({ address: { ...f.address, accountId: "another" } }), /crosses/);
});
test("new discussion and draft completion cannot bypass delegation policy", async () => {
  const f = fixture(), turn = await f.open();
  await assert.rejects(turn.commit({ reply: "", routes: [{ text: f.input.text, agentId: "payroll", purpose: "change", newDiscussion: true, title: "payroll" }] }), /Not allowed/);
  const result = await turn.commit({ reply: "", routes: [{ text: f.input.text, newDiscussion: true, title: "Discussion" }] });
  const next = await f.open({ eventId: "close" }); await next.read(result.concerns[0]!.work!.id);
  await next.commit({ reply: "Finished", routes: [{ text: f.input.text, workId: result.concerns[0]!.work!.id, closeDraft: true }] });
  assert.equal((await f.store.read(f.scope))?.drafts[0]?.terminal, true);
});
test("confirmed Builder work replaces the draft reference rather than introducing another lifecycle", async () => {
  const f = fixture(), turn = await f.open();
  const result = await turn.commit({ reply: "", routes: [{ text: f.input.text, agentId: "builder", purpose: "change", newDiscussion: true, title: "Change" }] });
  f.items.push({ ...f.items[0]!, id: "builder:job", kind: "builder", agentId: "builder", address: f.address, status: "queued" });
  await linkConversationDraft({ scope: f.scope, store: f.store, source: f.source, workId: "builder:job", address: f.address, eventId: "confirmed", now: "2026-09-10T10:05:00Z" });
  const state = await f.store.read(f.scope); assert.equal(state?.drafts[0]?.linkedWorkId, "builder:job"); assert.deepEqual(state?.focus, ["builder:job"]);
  const next = await f.open({ eventId: "followup" }); const read = await next.read(result.concerns[0]!.work!.id);
  assert.equal("status" in read && read.status, "queued");
});

test("a verified cross-provider source can expose the same work ID without changing its owner", async () => {
  const f = fixture("mcp"); f.items[0]!.address = { surface: "messenger", accountId: "verified-other-account", channelId: "private-room", threadId: "original" };
  const turn = await f.open(); await turn.read("work-0");
  const receipt = await turn.commit({ reply: "Continue with the original briefing.", routes: [{ text: f.input.text, workId: "work-0" }] });
  assert.equal(receipt.concerns[0]?.work?.id, "work-0"); assert.equal(receipt.concerns[0]?.work?.address.surface, "messenger");
  assert.equal(receipt.concerns[0]?.needsAcknowledgement, true);
});

test("long pending previews require a complete read before the original answer is routed", async () => {
  const f = fixture(), original = "x".repeat(12000), first = await f.open({ text: original }); await first.search({ limit: 6 });
  await first.commit({ reply: "", routes: [], clarify: { question: "Which work?", candidates: ["work-0", "work-1"] } });
  const next = await f.open({ eventId: "long-choice", text: "the second" }); const context = await next.initialContext();
  assert.equal(context.pending[0]?.text.length, 4000); assert.equal(context.pending[0]?.truncated, true);
  const plan: ConversationPlan = { reply: "Assigned", usePendingMessageId: "message-1", routes: [{ workId: "work-1" }] };
  await assert.rejects(next.commit(plan), /complete pending/);
  assert.equal((await next.readPending("message-1")).text, original);
  assert.equal((await next.commit(plan)).concerns[0]?.text, original);
});

test("a selected workflow can replace its discussion draft without duplicating workflow state", async () => {
  const f = fixture(); f.items[0]!.agentId = "general";
  const first = await f.open(); const discussion = await first.commit({ reply: "", routes: [{ text: f.input.text, newDiscussion: true, title: "Sales" }] });
  const draftId = discussion.concerns[0]!.work!.id, next = await f.open({ eventId: "existing" }); await next.read("work-0");
  await next.commit({ reply: "", routes: [{ text: f.input.text, workId: "work-0", draftId }] });
  assert.equal((await f.store.read(f.scope))?.drafts[0]?.linkedWorkId, "work-0"); assert.equal(f.items[0]?.status, "waiting");
});

test("history remains within its character budget even at a small final remainder", async () => {
  const { boundedConversationHistory } = await import("../../runtime/shared-conversation.ts");
  for (const limit of [1, 10, 32, 32000]) {
    const result = boundedConversationHistory([{ content: "old".repeat(10000) }, { content: "new".repeat(10000) }], limit);
    assert.ok(result.reduce((size, item) => size + item.content.length, 0) <= limit);
    assert.ok(result.at(-1)?.content.endsWith("new".slice(-Math.min(3, limit))));
  }
});

for (const surface of ["slack", "synthetic-chat"]) test(`${surface}: quiet team messages retain attributed context without routes, drafts or lost questions`, async () => {
  const f = fixture(surface);
  const text = "Bob, can you review that tomorrow?";
  const message = { id: "message-1", conversationId: `${surface}:inbox:new-message`, senderId: f.scope.principal, senderName: "Alex",
    sentAt: "2026-09-10T10:00:00Z", shared: true, mentioned: false, text };
  const turn = await f.open({ text, message });
  await assert.rejects(() => turn.commit({ reply: "", routes: [{ text, newDiscussion: true, title: "Unexpected draft" }] }), /Choose participation/);
  await assert.rejects(() => turn.commit({ participation: "context-only", reply: "Let me help", routes: [] }), /cannot reply/);
  const receipt = await turn.commit({ participation: "context-only", reply: "", routes: [] });
  assert.equal(receipt.concerns.length, 0);
  const next = await f.store.read(f.scope);
  assert.equal(next?.drafts.length, 0);
  assert.equal(next?.recent.length, 1);
  assert.equal(next?.recent[0].principal, f.scope.principal);
  assert.equal(next?.recent[0].sender_name, "Alex");
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await (await f.open({ text, message })).replay(), receipt);
  await assert.rejects(() => f.open({ text, message: { ...message, senderId: "human:someone-else" } }), /identity/);
});


test("adoption retains legacy event receipts when adapters add normalized participation facts", async () => {
  const f = fixture(), first = await f.open();
  const receipt = await first.commit({ reply: "Already answered", routes: [] });
  const message = { id: f.input.messageId, conversationId: "slack:inbox:new-message", senderId: f.scope.principal, senderName: "Alex",
    sentAt: "2026-09-10T10:00:00Z", shared: true, mentioned: false, text: f.input.text };
  const reconstructed = await f.open({ message });
  assert.deepEqual(await reconstructed.replay(), receipt);
});
