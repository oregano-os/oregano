import assert from "node:assert/strict";
import { test } from "node:test";
import { engineArtifact, engineFixture, ENGINE_OPERATOR, ENGINE_OWNER } from "../workflow-engine-fixture.ts";
import { sha256 } from "../../runtime/canonical.ts";
import { workflowDecisionId } from "../../runtime/workflow-engine/decision-notice.ts";

/** One private card asks for help; the answer and all follow-up stay in that card's own thread. */
function cardFixture() {
  const artifact = structuredClone(engineArtifact());
  const workflow = artifact.workflows!.find((entry) => entry.id === "monday-handoff")!;
  const message = structuredClone(workflow.steps.find((entry) => entry.message)!);
  const calendarPath = workflow.schedules[0]!.path;
  const { message: _message, ...base } = message;
  const card = { ...base, id: "card", kind: "decision" as const, owner: "human:subject", next: ["ask", "end"], forEach: undefined, requiredOutputPaths: [["thread_reference"]],
    decision: { conversationRoot: true as const, recipient: "jonas-owner", role: "subject", binds: { assistance: "Prepare a private draft only" }, via: "sprint-direct",
      timeoutBusinessDays: 1, calendarPath, targets: { approve: "ask", reject: "end", timeout: "end" as const },
      presentation: { version: 1 as const, title: "Friday Sprint Update", reviewFormat: "message" as const, message: { template: "synthetic-card", vars: {} },
        labels: { approve: "Yes, help me prepare it", reject: "No, I will write it myself" } } } };
  const ask = { ...message, id: "ask", next: ["facts"], forEach: undefined, requiredOutputPaths: [],
    message: { template: "synthetic-question", vars: {}, destination: "sprint-direct", recipient: "jonas-owner", thread: "$steps.card.thread_reference" } };
  const { tool: _tool, message: _ask, ...collectBase } = message;
  const facts = { ...collectBase, id: "facts", kind: "collect" as const, allowedTools: [], maxRisk: "R0" as const, next: ["end"], forEach: undefined, requiredOutputPaths: [],
    collect: { from: "$steps.card.thread_reference", context: {}, fields: ["summary"], timeoutBusinessDays: 1, calendarPath } };
  workflow.steps = [card as any, ask, facts]; workflow.entry = "card";
  workflow.templates = [
    { path: "synthetic-card", content: "Your update is due by 17:00. Would you like help preparing it?", format: "provider-markdown", digest: sha256("card") },
    { path: "synthetic-question", content: "Let's prepare your update here.", format: "plain-text", digest: sha256("question") },
  ];
  const { manifestHash, ...manifest } = workflow; workflow.manifestHash = sha256(manifest);
  const { artifactHash, ...content } = artifact; artifact.artifactHash = sha256({ ...content, provenance: { ...content.provenance, builtAt: undefined } });
  return engineFixture({ artifact });
}

async function delivered() {
  const h = cardFixture();
  const opened = await h.engine().openOperator({ workflowId: "monday-handoff", requestId: "card", principal: ENGINE_OPERATOR,
    fields: { sprint_id: "p1", period_start: "2030-01-07", period_end: "2030-01-11" } });
  const waiting = (await h.engine().advance(opened.runId))!;
  assert.equal(waiting.state.blocked, undefined); assert.equal(waiting.state.cursor, "card"); assert.equal(waiting.state.status, "waiting");
  const decision = waiting.state.decisions.card!;
  const receipt = decision.deliveries["jonas-owner"] as Record<string, string>;
  const notice = h.calls.filter((call: any) => call.capability === "communication.message.publish").at(-1) as any;
  return { h, run: waiting, decision, receipt, notice };
}

test("a conversation-root decision card carries its title and asks the connector to open its own thread", async () => {
  const { notice, receipt } = await delivered();
  assert.equal(notice.input.thread_reference, undefined);
  assert.equal(notice.input.decision.title, "Friday Sprint Update");
  assert.equal(notice.input.decision.open_thread, true);
  assert.equal(notice.input.decision.conversation_reference, undefined);
  assert.equal(typeof receipt.thread_reference, "string");
});

test("approval continues in the card's own thread and collects the answer there", async () => {
  const { h, run, decision, receipt } = await delivered();
  const conversation = h.conversation(receipt.destination_binding!, receipt);
  const approved = await h.engine().decide({ principal: ENGINE_OWNER, conversation, eventId: "yes", requestId: workflowDecisionId(run.runId, "card", decision.boundDigest), decision: "approved" });
  assert.deepEqual(approved.state.steps.card!.output, { bound: decision.bound, decision: "approved",
    thread_reference: receipt.thread_reference, destination_binding: receipt.destination_binding, message_id: receipt.message_id });
  const asking = (await h.engine().advance(run.runId))!;
  assert.equal(asking.state.blocked, undefined); assert.equal(asking.state.cursor, "facts");
  assert.equal((asking.state.steps.ask!.output as Record<string, string>).thread_reference, receipt.thread_reference, "the first question is a reply under the card");
  const question = h.calls.filter((call: any) => call.capability === "communication.message.publish").at(-1) as any;
  assert.equal(question.input.thread_reference, receipt.thread_reference);
  await assert.rejects(h.engine().collect({ principal: ENGINE_OWNER, conversation: { ...conversation, threadId: "another-thread" }, eventId: "wrong", output: { summary: "x" } }), /assignment/);
  const done = await h.engine().collect({ principal: ENGINE_OWNER, conversation, eventId: "facts", output: { summary: "Agreed facts" } });
  assert.equal(done.state.status, "done"); assert.deepEqual(done.state.steps.facts!.output, { summary: "Agreed facts" });
});

test("an undelivered expired conversation-root decision ends without fabricating a thread", async () => {
  const h = cardFixture();
  const opened = await h.engine().openOperator({ workflowId: "monday-handoff", requestId: "expired", principal: ENGINE_OPERATOR,
    fields: { sprint_id: "p2", period_start: "2030-01-07", period_end: "2030-01-11" } });
  h.unknownPublication = true;
  await h.engine().advance(opened.runId).catch(() => undefined);
  h.unknownPublication = false;
  h.now = "2030-01-20T12:00:00.000Z";
  await h.engine().timers();
  const ended = (await h.store.read(opened.instanceId, opened.runId))!;
  assert.equal(ended.state.status, "done"); assert.equal(ended.state.cursor, null);
  assert.deepEqual(ended.state.steps.card!.output, { bound: ended.state.decisions.card!.bound, decision: "timed-out" });
  assert.equal(h.calls.some((call: any) => call.capability === "communication.message.publish" && call.input.thread_reference !== undefined), false);
});
