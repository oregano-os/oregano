import { ConversationChoiceService } from "../../runtime/conversation-choice.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { collectionFixture } from "../workflow-collection-fixture.ts";
import { engineFixture, ENGINE_OPERATOR, ENGINE_OWNER } from "../workflow-engine-fixture.ts";
import { sha256 } from "../../runtime/canonical.ts";
import { WorkflowConversationHost, workflowReplyThreadId, workflowInboundThreadId } from "../../runner-vercel/src/lib/workflow-conversations.ts";
import { WorkflowSlackTransport } from "../../connectors/slack/workflow-transport.ts";
import { recoverWorkflowReply } from "../../runner-vercel/src/lib/workflow-reply-recovery.ts";
import { createSlackAdapter } from "../../runner-vercel/node_modules/@chat-adapter/slack/dist/index.js";

async function setup(count = 1, channelId = "C10001", reportOnly = false, followup = false) {
  const artifact = collectionFixture().artifact;
  if (reportOnly) {
    const workflow = artifact.workflows!.find((w) => w.id === "monday-handoff")!;
    workflow.steps = [workflow.steps[0]!]; workflow.steps[0]!.next = ["end"];
    workflow.steps[0]!.message!.thread = "slack:C10001:50.000001";
    const { manifestHash, ...manifest } = workflow; workflow.manifestHash = sha256(manifest);
    const { artifactHash, ...content } = artifact; artifact.artifactHash = sha256({ ...content, provenance: { ...content.provenance, builtAt: undefined } });
  }
  if (followup) {
    const workflow = artifact.workflows!.find(w => w.id === "monday-handoff")!;
    const ask = structuredClone(workflow.steps[0]!);
    ask.id = "followup"; ask.next = ["more-facts"];
    const collect = structuredClone(workflow.steps[1]!);
    collect.id = "more-facts"; collect.collect!.from = "$steps.followup.thread_reference";
    workflow.steps[1]!.next = ["followup"];
    workflow.steps.push(ask, collect);
    const { manifestHash, ...manifest } = workflow; workflow.manifestHash = sha256(manifest);
    const { artifactHash, ...content } = artifact; artifact.artifactHash = sha256({ ...content, provenance: { ...content.provenance, builtAt: undefined } });
  }
  const h = engineFixture({ artifact, conversationForReceipt: async ({ output }) => ({ surface: "slack", accountId: "T10001", channelId,
    threadId: reportOnly ? "50.000001" : `${(output as any).message_id.replace("message-", "")}.000001`, subjectPrincipal: ENGINE_OWNER }) });
  const runs = [];
  for (let i = 0; i < count; i++) {
    const opened = await h.engine().openOperator({ workflowId: "monday-handoff", requestId: `collection-${i}`, principal: ENGINE_OPERATOR,
      fields: { sprint_id: `period-${i}`, period_start: "2030-01-07", period_end: "2030-01-11" } });
    runs.push((await h.engine().advance(opened.runId))!);
  }
  let message: Record<string, unknown> = { type: "message", ts: "999.000001", user: "U10002", text: "The agreed intended outcome" };
  const calls: string[] = [];
  const sourceMessages = new Map<string, Record<string, unknown>>([[String(message.ts), message]]);
  const adapter = createSlackAdapter({ botToken: "xoxb-synthetic", signingSecret: "synthetic", botUserId: "U10000" });
  const choiceValues = new Map<string, unknown>();
  const choices = new ConversationChoiceService<any>({ async get<T>(key: string) { return (choiceValues.get(key) ?? null) as T | null; }, async setIfNotExists(key, value) { if (choiceValues.has(key)) return false; choiceValues.set(key, structuredClone(value)); return true; } }, () => h.now);
  const host = new WorkflowConversationHost({ choices, artifact: h.artifact, engine: h.engine(), store: h.store, control: h.control, roster: async () => h.roster,
    connectors: async () => [], enabledWorkflowIds: ["monday-handoff"], clock: () => h.now, slack: async (operation) => operation(new WorkflowSlackTransport({
      conversationReply: async ({ messageId, threadId, channelId: sourceChannel }) => {
        calls.push("conversationReply");
        assert.equal(sourceChannel, channelId);
        const raw = sourceMessages.get(messageId); if (!raw) return undefined;
        assert.equal(threadId, raw.thread_ts ?? messageId);
        return { raw, text: adapter.parseMessage({ ...raw, type: String(raw.type) }).text };
      },
      call: async (method, args) => {
      calls.push(method);
      if (method === "auth.test") return { ok: true, team_id: "T10001" };
      if (method === "users.info") return { ok: true, user: { id: args.user, team_id: "T10001", deleted: false, is_bot: false } };
      assert.ok(["conversations.history", "conversations.replies"].includes(method));
      const found = sourceMessages.get(args.oldest!);
      assert.ok(found, `Missing synthetic message ${args.oldest}`); assert.equal(args.latest, found.ts);
      return { ok: true, has_more: false, messages: [found] };
    } })) });
  const input = { threadId: `slack:${channelId}:999.000001`, messageId: "999.000001", authorId: "U10002" };
  return { h, host, runs, input, calls, setMessage: (patch: Record<string, unknown>) => { message = { ...message, ...patch }; sourceMessages.set(String(message.ts), message); } };
}

test("a channel answer reaches only its exact active collection, with original event evidence and no inferred approval", async () => {
  const { h, host, runs, input, calls } = await setup();
  const result = await host.receiveChannel(input);
  assert.equal(result.kind, "conversation"); if (result.kind !== "conversation") return;
  assert.equal(result.session.runId, runs[0]!.runId); assert.equal(result.session.text, "The agreed intended outcome");
  assert.notEqual(result.session.conversation.threadId, input.messageId);
  await result.session.collection!.submit({ summary: "The agreed intended outcome" });
  const run = (await h.store.read(h.artifact.instance.id, runs[0]!.runId))!;
  assert.equal(run.state.status, "done"); assert.deepEqual(run.state.decisions, {});
  assert.ok(calls.includes("conversations.history"));
  await assert.rejects(result.session.collection!.submit({ summary: "Replacement" }));
});

test("a report published inside an existing thread needs no root execution assignment for follow-up", async () => {
  const { h, host, input, setMessage, runs } = await setup(1, "C10001", true);
  assert.equal(runs[0]!.state.status, "done");
  const conversation = { surface: "slack", accountId: "T10001", channelId: "C10001", threadId: "50.000001", subjectPrincipal: ENGINE_OWNER };
  assert.equal(await h.store.deliveredAssignment({ instanceId: h.artifact.instance.id, conversation }), undefined);
  setMessage({ thread_ts: conversation.threadId, text: "Please explain this report" });
  const received = await host.receive({ ...input, threadId: "slack:C10001:50.000001" });
  assert.equal(received.kind, "conversation"); if (received.kind !== "conversation") return;
  assert.deepEqual(received.session.allowedTools, []); assert.equal(received.session.runtime, undefined);
  assert.equal(received.session.publishedContext!.messages[0]!.content, "Please explain the intended outcome.");
});

test("multiple open questions ask for clarification; cancelled or expired runs do not capture a channel answer", async () => {
  const { h, host, input, runs, calls } = await setup(2);
  const ambiguous = await host.receiveChannel(input);
  assert.equal(ambiguous.kind, "ambiguous"); assert.equal(calls.includes("conversations.history"), false);
  await h.store.cancel({ instanceId: h.artifact.instance.id, runId: runs[0]!.runId, principal: ENGINE_OPERATOR, now: h.now });
  assert.equal((await host.receiveChannel(input)).kind, "conversation");
  h.now = "2030-01-09T14:30:00.000Z";
  assert.equal((await host.receiveChannel(input)).kind, "unassigned");
});

test("foreign users, channels and unrelated threads never reach collection; edited or forged author evidence fails closed", async () => {
  const { host, input, calls, setMessage } = await setup();
  for (const change of [{ authorId: "U10001" }, { authorId: undefined }, { threadId: "slack:C20001:999.000001" }, { threadId: "slack:C10001:900.000001" }]) {
    assert.equal((await host.receiveChannel({ ...input, ...change })).kind, "unassigned");
  }
  assert.equal(calls.includes("conversations.history"), false);
  for (const patch of [{ edited: { ts: "999.000002" } }, { edited: undefined, user: "U10001" }, { user: "U10002", thread_ts: "4.000001" }]) {
    setMessage(patch); await assert.rejects(host.receiveChannel(input));
  }
});

test("channel yes or an approval command remains conversation text and does not record any decision", async () => {
  const { host, input, setMessage, h, runs } = await setup();
  for (const text of ["yes", `APPROVE ${"a".repeat(64)}`]) {
    setMessage({ text });
    const result = await host.receiveChannel(input); assert.equal(result.kind, "conversation");
    assert.deepEqual((await h.store.read(h.artifact.instance.id, runs[0]!.runId))!.state.decisions, {});
  }
});

test("a channel answer continues on its delivered question so the next thread reply keeps its assignment", async () => {
  const { host, input, setMessage, runs } = await setup();
  const result = await host.receiveChannel(input);
  assert.equal(result.kind, "conversation"); if (result.kind !== "conversation") return;
  const replyThreadId = workflowReplyThreadId(result.session);
  assert.notEqual(replyThreadId, input.threadId);
  setMessage({ ts: "999.000002", thread_ts: result.session.conversation.threadId, text: "Here is the missing detail" });
  const followup = await host.receive({ threadId: replyThreadId, messageId: "999.000002", authorId: input.authorId });
  assert.equal(followup.kind, "conversation"); if (followup.kind !== "conversation") return;
  assert.equal(followup.session.runId, runs[0]!.runId);
  assert.equal(followup.session.text, "Here is the missing detail");
});

for (const channelId of ["C10001", "D10001"]) test(`a completed question remains explainable with no workflow Tools (${channelId})`, async () => {
  const { h, host, input, setMessage, runs } = await setup(1, channelId);
  const collecting = await host.receiveChannel(input);
  assert.equal(collecting.kind, "conversation"); if (collecting.kind !== "conversation") return;
  await collecting.session.collection!.submit({ summary: "The agreed outcome" });
  const before = await h.store.read(h.artifact.instance.id, runs[0]!.runId);
  setMessage({ ts: "999.000003", thread_ts: collecting.session.conversation.threadId, text: "Why did you ask this?" });
  const discussed = await host.receive({ threadId: workflowReplyThreadId(collecting.session), messageId: "999.000003", authorId: input.authorId });
  assert.equal(discussed.kind, "conversation"); if (discussed.kind !== "conversation") return;
  assert.deepEqual(discussed.session.allowedTools, []);
  assert.equal(discussed.session.collection, undefined); assert.equal(discussed.session.runtime, undefined);
  assert.equal(discussed.session.publishedContext!.messages[0]!.content, "Please explain the intended outcome.");
  assert.deepEqual(await h.store.read(h.artifact.instance.id, runs[0]!.runId), before);
  setMessage({ user: "U10001" });
  await assert.rejects(host.receive({ threadId: workflowReplyThreadId(collecting.session), messageId: "999.000003", authorId: input.authorId }));
});

test("cancellation permits explanation but an approval command still cannot execute", async () => {
  const { h, host, input, setMessage, runs } = await setup();
  const collecting = await host.receiveChannel(input);
  assert.equal(collecting.kind, "conversation"); if (collecting.kind !== "conversation") return;
  await h.store.cancel({ instanceId: h.artifact.instance.id, runId: runs[0]!.runId, principal: ENGINE_OPERATOR, now: h.now });
  const before = await h.store.read(h.artifact.instance.id, runs[0]!.runId);
  const ref = { threadId: workflowReplyThreadId(collecting.session), messageId: "999.000004", authorId: input.authorId };
  setMessage({ ts: ref.messageId, thread_ts: collecting.session.conversation.threadId, text: "Explain the question" });
  const discussed = await host.receive(ref);
  assert.equal(discussed.kind, "conversation");
  if (discussed.kind === "conversation") assert.deepEqual(discussed.session.allowedTools, []);
  setMessage({ text: `APPROVE ${"a".repeat(64)}` });
  await assert.rejects(host.receive(ref));
  assert.deepEqual(await h.store.read(h.artifact.instance.id, runs[0]!.runId), before);
});

test("operator recovery of a channel root rereads its actual author and never chooses between multiple questions", async () => {
  const { host, input, calls, setMessage, h, runs } = await setup();
  const dispatched: string[] = [];
  const recovery = { receive: (ref: { threadId: string; messageId: string; authorId?: string }) => host.receiveChannel(ref), dispatch: async (message: { text: string }) => { dispatched.push(message.text); } };
  assert.equal((await recoverWorkflowReply(input, recovery)).dispatchCompleted, true);
  assert.deepEqual(dispatched, ["The agreed intended outcome"]);
  assert.ok(calls.includes("conversations.history"));
  assert.deepEqual((await h.store.read(h.artifact.instance.id, runs[0]!.runId))!.state.decisions, {});
  for (const patch of [{ user: "U10001" }, { user: "U10002", edited: { ts: "999.000002" } }]) {
    setMessage(patch); await assert.rejects(recoverWorkflowReply(input, recovery));
  }
  assert.equal(dispatched.length, 1);
  const multiple = await setup(2);
  const ambiguous = await recoverWorkflowReply(multiple.input, { receive: (ref) => multiple.host.receiveChannel(ref), dispatch: async () => { assert.fail("Ambiguous root was dispatched"); } });
  assert.equal(ambiguous.kind, "ambiguous"); assert.equal(ambiguous.dispatchCompleted, false);
});

for (const count of [1, 2]) test(`a root direct answer requires exactly one active question (${count} open)`, async () => {
  const { host, input, calls, runs } = await setup(count, "D10001");
  const sdkReference = workflowInboundThreadId("slack:D10001:", input.messageId);
  assert.equal(sdkReference, input.threadId);
  const result = await host.receiveChannel({ ...input, threadId: sdkReference });
  assert.equal(result.kind, count === 1 ? "conversation" : "ambiguous");
  if (result.kind === "conversation") {
    assert.equal(result.session.runId, runs[0]!.runId);
    assert.equal(result.session.text, "The agreed intended outcome");
    assert.equal(workflowReplyThreadId(result.session), `slack:D10001:${result.session.conversation.threadId}`);
    assert.ok(calls.includes("conversations.history"));
  }
});

test("direct root recovery preserves actual identity and cannot decide or switch recipients", async () => {
  const { host, input, h, runs, setMessage } = await setup(1, "D10001");
  const received: string[] = [];
  const dependencies = { receive: (ref: { threadId: string; messageId: string; authorId?: string }) => host.receiveChannel(ref), dispatch: async (message: { text: string }) => { received.push(message.text); } };
  setMessage({ text: "yes" });
  assert.equal((await recoverWorkflowReply(input, dependencies)).dispatchCompleted, true);
  assert.deepEqual(received, ["yes"]);
  assert.deepEqual((await h.store.read(h.artifact.instance.id, runs[0]!.runId))!.state.decisions, {});
  assert.equal((await host.receiveChannel({ ...input, authorId: "U10001" })).kind, "unassigned");
  assert.equal((await host.receiveChannel({ ...input, threadId: "slack:D20001:999.000001" })).kind, "unassigned");
  setMessage({ user: "U10001" });
  await assert.rejects(recoverWorkflowReply(input, dependencies));
  assert.equal(received.length, 1);
});

for (const channelId of ["C10001", "D10001"]) test(`numbered selection routes the original answer, not the selector, in ${channelId}`, async () => {
  const { h, host, input, setMessage, runs } = await setup(2, channelId);
  const ambiguous = await host.receiveChannel(input); assert.equal(ambiguous.kind, "ambiguous"); if (ambiguous.kind !== "ambiguous") return;
  const choice = await host.prepareChoice(input, ambiguous.conversations); await choice.presented("999.000002");
  const target = choice.conversations[1]!;
  setMessage({ ts: "999.000003", thread_ts: input.messageId, text: "<@U90001> it belongs to question 2" });
  const selectionInput = { ...input, messageId: "999.000003" };
  const selected = await host.receive(selectionInput); assert.equal(selected.kind, "conversation"); if (selected.kind !== "conversation") return;
  assert.equal(selected.session.runId, target.runId);
  assert.equal(selected.session.text, "The agreed intended outcome");
  assert.equal(workflowReplyThreadId(selected.session), `slack:${channelId}:${target.threadId}`);
  setMessage({ ts: "999.000004", text: "question 1" });
  const duplicate = await host.receive({ ...input, messageId: "999.000004" }); assert.equal(duplicate.kind, "routing");
  await selected.session.collection!.submit({ summary: "The agreed intended outcome" });
  assert.equal((await h.store.read(h.artifact.instance.id, target.runId))!.state.status, "done");
  const retriedRoot = await host.receiveChannel(input);
  assert.equal(retriedRoot.kind, "ambiguous");
  if (retriedRoot.kind === "ambiguous") assert.deepEqual(retriedRoot.conversations, choice.conversations);
  const other = runs.find((run) => run.runId !== target.runId)!;
  assert.equal((await h.store.read(h.artifact.instance.id, other.runId))!.state.status, "waiting");
  assert.deepEqual((await h.store.read(h.artifact.instance.id, target.runId))!.state.decisions, {});
});

test("numbered selection rejects edited originals, expired targets and foreign authors", async () => {
  const { h, host, input, setMessage, runs } = await setup(2);
  const ambiguous = await host.receiveChannel(input); if (ambiguous.kind !== "ambiguous") assert.fail();
  const choice = await host.prepareChoice(input, ambiguous.conversations); await choice.presented("999.000002");
  setMessage({ ts: "999.000003", thread_ts: input.messageId, text: "Question 2" });
  assert.equal((await host.receive({ ...input, authorId: "U10001", messageId: "999.000003" })).kind, "unassigned");
  await h.store.cancel({ instanceId: h.artifact.instance.id, runId: choice.conversations[1]!.runId, principal: ENGINE_OPERATOR, now: h.now });
  assert.equal((await host.receive({ ...input, messageId: "999.000003" })).kind, "routing");
  setMessage({ ts: input.messageId, thread_ts: undefined, text: "Edited answer", edited: { ts: "999.000009" } });
  setMessage({ ts: "999.000004", thread_ts: input.messageId, text: "Question 1", edited: undefined });
  await assert.rejects(host.receive({ ...input, messageId: "999.000004" }));
  for (const run of runs) assert.deepEqual((await h.store.read(h.artifact.instance.id, run.runId))!.state.decisions, {});
});

test("unresolved legacy choices migrate with verified original text and original candidate order", async () => {
  const { host, input, setMessage } = await setup(2, "D10001");
  const result = await host.receiveChannel(input); if (result.kind !== "ambiguous") assert.fail();
  const choice = await host.prepareChoice(input, result.conversations); await choice.presented("999.000002");
  const migrated = await host.pendingChoiceForCoordinator({ threadId: input.threadId, authorId: "U10002" });
  assert.equal(migrated?.source.text, "The agreed intended outcome");
  assert.equal(migrated?.source.messageId, input.messageId);
  assert.deepEqual(migrated?.candidates, choice.conversations.map(c => `workflow:${c.assignmentKey}`));
  assert.equal(await host.pendingChoiceForCoordinator({ threadId: input.threadId, authorId: "U10001" }), undefined);
  setMessage({ text: "Modified original", edited: { ts: "999.000004" } });
  await assert.rejects(host.pendingChoiceForCoordinator({ threadId: input.threadId, authorId: "U10002" }));
});

test("coordinated selection verifies the actual source thread and resumes only the selected workflow", async () => {
  const { h, host, runs, input, setMessage } = await setup(2, "D10001");
  const candidates = await h.store.channelAssignments({ instanceId: h.artifact.instance.id, surface: "slack", accountId: "T10001", channelId: "D10001", subjectPrincipal: ENGINE_OWNER, now: h.now });
  const target = candidates.find(a => a.runId === runs[1]!.runId)!;
  setMessage({ thread_ts: "950.000001" });
  const result = await host.receiveSelected({ source: { ...input, authorId: "U10002", threadId: "slack:D10001:950.000001" }, target, text: "The agreed intended outcome", version: String(runs[1]!.revision) });
  assert.equal(result.kind, "conversation"); if (result.kind !== "conversation") return;
  assert.equal(result.session.runId, runs[1]!.runId); assert.equal(result.session.text, "The agreed intended outcome");
  await result.session.collection!.submit({ summary: "The agreed intended outcome" });
  assert.equal((await h.store.read(h.artifact.instance.id, runs[0]!.runId))?.state.status, "waiting");
  assert.equal((await h.store.read(h.artifact.instance.id, runs[1]!.runId))?.state.status, "done");
});

test("coordinated workflow dispatch rejects invented excerpts, foreign recipients, and stale revisions", async () => {
  const { h, host, runs, input } = await setup(1, "D10001");
  const [target] = await h.store.channelAssignments({ instanceId: h.artifact.instance.id, surface: "slack", accountId: "T10001", channelId: "D10001", subjectPrincipal: ENGINE_OWNER, now: h.now });
  const args = { source: { ...input, authorId: "U10002" }, target: target!, text: "The agreed intended outcome", version: String(runs[0]!.revision) };
  await assert.rejects(host.receiveSelected({ ...args, text: "APPROVE invented" }), /excerpt/);
  await assert.rejects(host.receiveSelected({ ...args, target: { ...target!, subjectPrincipal: "slack:T10001:U99999" } }), /another recipient/);
  await assert.rejects(host.receiveSelected({ ...args, version: "-1" }), /changed before dispatch/);
  assert.equal((await h.store.read(h.artifact.instance.id, runs[0]!.runId))?.state.status, "waiting");
});

for (const threaded of [false, true]) test(`whole-message routing preserves provider text and identity checks (threaded=${threaded})`, async () => {
  const { h, host, runs, input, setMessage, calls } = await setup(1, "D10001");
  const [target] = await h.store.channelAssignments({ instanceId: h.artifact.instance.id, surface: "slack", accountId: "T10001", channelId: "D10001", subjectPrincipal: ENGINE_OWNER, now: h.now });
  const text = "• *Objective:* Improve café service 🟢\n• *Outcome:* See <https://example.com/plan|the plan>\n• *Impact:* Save time.";
  setMessage({ text, ...(threaded ? { thread_ts: target!.threadId } : {}) });
  const args = { source: { ...input, ...(threaded ? { threadId: `slack:D10001:${target!.threadId}` } : {}) }, target: target!, version: String(runs[0]!.revision) };
  const result = await host.receiveSelected(args);
  assert.equal(result.kind, "conversation"); if (result.kind !== "conversation") return;
  assert.equal(result.session.text, text);
  assert.equal(calls.includes("conversationReply"), false);
  assert.deepEqual((await h.store.read(h.artifact.instance.id, runs[0]!.runId))!.state.decisions, {});
  await assert.rejects(host.receiveSelected({ ...args, version: "-1" }), /changed before dispatch/);
  await assert.rejects(host.receiveSelected({ ...args, source: { ...args.source, threadId: "slack:D20001:999.000001" } }), /audience/);
  await assert.rejects(host.receiveSelected({ ...args, target: { ...target!, subjectPrincipal: "slack:T10001:U99999" } }), /recipient/);
  setMessage({ edited: { ts: "999.000002" } }); await assert.rejects(host.receiveSelected(args), /original attributable/);
  setMessage({ edited: undefined, user: "U10001" }); await assert.rejects(host.receiveSelected(args));
});

test("split excerpts use the ingress representation while preserving provider identity and approval boundaries", async () => {
  const { h, host, runs, input, setMessage } = await setup(1, "D10001");
  const [target] = await h.store.channelAssignments({ instanceId: h.artifact.instance.id, surface: "slack", accountId: "T10001", channelId: "D10001", subjectPrincipal: ENGINE_OWNER, now: h.now });
  setMessage({ text: "• *Objective:* Improve service.\n• *Other:* Start a different project." });
  const args = { source: input, target: target!, text: "Objective: Improve service.", version: String(runs[0]!.revision) };
  const result = await host.receiveSelected(args);
  assert.equal(result.kind, "conversation"); if (result.kind !== "conversation") return;
  assert.equal(result.session.text, args.text);
  assert.deepEqual((await h.store.read(h.artifact.instance.id, runs[0]!.runId))!.state.decisions, {});
  await assert.rejects(host.receiveSelected({ ...args, text: "APPROVE invented" }), /excerpt/);
  setMessage({ edited: { ts: "999.000002" } }); await assert.rejects(host.receiveSelected(args), /original attributable/);
  setMessage({ edited: undefined, user: "U10001" }); await assert.rejects(host.receiveSelected(args));
});

for (const channelId of ["C10001", "D10001"]) test(`a selected reply to an earlier collection continues only the same run's current delivered question (${channelId})`, async () => {
  const { h, host, input, setMessage, runs } = await setup(1, channelId, false, true);
  const initial = await host.receiveChannel(input);
  assert.equal(initial.kind, "conversation"); if (initial.kind !== "conversation") return;
  const oldConversation = { ...initial.session.conversation, subjectPrincipal: ENGINE_OWNER };
  const original = (await h.store.deliveredAssignment({ instanceId: h.artifact.instance.id, conversation: oldConversation }))!;
  await initial.session.collection!.submit({ summary: "Partial account retained by the workflow" });
  const run = (await h.store.read(h.artifact.instance.id, runs[0]!.runId))!;
  assert.equal(run.state.cursor, "more-facts");
  setMessage({ ts: "999.000004", thread_ts: oldConversation.threadId, text: "Here is the requested result" });
  const source = { threadId: workflowReplyThreadId(initial.session), messageId: "999.000004", authorId: "U10002" };
  const result = await host.receiveSelected({ source, target: original, version: String(run.revision) });
  assert.equal(result.kind, "conversation"); if (result.kind !== "conversation") return;
  assert.equal(result.session.runId, run.runId);
  assert.equal(result.session.stepId, "more-facts");
  assert.equal(result.session.text, "Here is the requested result");
  assert.notEqual(result.session.conversation.threadId, oldConversation.threadId);
  assert.ok(result.session.collection);
  assert.deepEqual((await h.store.read(h.artifact.instance.id, run.runId))!.state.decisions, {});
  await assert.rejects(host.receiveSelected({ source, target: original, version: String(run.revision - 1) }), /changed before dispatch/);
  await assert.rejects(host.receiveSelected({ source, target: { ...original, subjectPrincipal: "slack:T10001:U10001" }, version: String(run.revision) }), /another recipient/);
  await result.session.collection!.submit({ summary: "Completed account" });
  const done = (await h.store.read(h.artifact.instance.id, run.runId))!;
  const discussed = await host.receiveSelected({ source, target: original, version: String(done.revision) });
  assert.equal(discussed.kind, "conversation"); if (discussed.kind !== "conversation") return;
  assert.equal(discussed.session.collection, undefined);
});
