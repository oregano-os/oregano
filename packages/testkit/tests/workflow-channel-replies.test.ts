import assert from "node:assert/strict";
import { test } from "node:test";
import { collectionFixture } from "../workflow-collection-fixture.ts";
import { ENGINE_OPERATOR, ENGINE_OWNER } from "../workflow-engine-fixture.ts";
import { WorkflowConversationHost } from "../../runner-vercel/src/lib/workflow-conversations.ts";
import { WorkflowSlackTransport } from "../../connectors/slack/workflow-transport.ts";

async function setup(count = 1) {
  const h = collectionFixture({ conversationForReceipt: async ({ output }) => ({ surface: "slack", accountId: "T10001", channelId: "C10001",
    threadId: `${(output as any).message_id.replace("message-", "")}.000001`, subjectPrincipal: ENGINE_OWNER }) });
  const runs = [];
  for (let i = 0; i < count; i++) {
    const opened = await h.engine().openOperator({ workflowId: "monday-handoff", requestId: `collection-${i}`, principal: ENGINE_OPERATOR,
      fields: { sprint_id: `period-${i}`, period_start: "2030-01-07", period_end: "2030-01-11" } });
    runs.push((await h.engine().advance(opened.runId))!);
  }
  let message: Record<string, unknown> = { type: "message", ts: "999.000001", user: "U10002", text: "The agreed intended outcome" };
  const calls: string[] = [];
  const host = new WorkflowConversationHost({ artifact: h.artifact, engine: h.engine(), store: h.store, control: h.control, roster: async () => h.roster,
    connectors: async () => [], enabledWorkflowIds: ["monday-handoff"], clock: () => h.now, slack: async (operation) => operation(new WorkflowSlackTransport({ call: async (method, args) => {
      calls.push(method);
      if (method === "auth.test") return { ok: true, team_id: "T10001" };
      if (method === "users.info") return { ok: true, user: { id: args.user, team_id: "T10001", deleted: false, is_bot: false } };
      assert.equal(method, "conversations.history");
      assert.equal(args.oldest, message.ts); assert.equal(args.latest, message.ts);
      return { ok: true, has_more: false, messages: [message] };
    } })) });
  const input = { threadId: "slack:C10001:999.000001", messageId: "999.000001", authorId: "U10002" };
  return { h, host, runs, input, calls, setMessage: (patch: Record<string, unknown>) => { message = { ...message, ...patch }; } };
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
