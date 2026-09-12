import assert from "node:assert/strict";
import { test } from "node:test";
import { collectionFixture } from "../workflow-collection-fixture.ts";
import { engineFixture, ENGINE_OPERATOR, ENGINE_OWNER } from "../workflow-engine-fixture.ts";
import { sha256 } from "../../runtime/canonical.ts";
import { workflowDecisionId } from "../../runtime/workflow-engine/decision-notice.ts";
import { WorkflowConversationHost } from "../../runner-vercel/src/lib/workflow-conversations.ts";
import { WorkflowSlackTransport } from "../../connectors/slack/workflow-transport.ts";
import { recordWorkflowButtonResponse } from "../../runner-vercel/src/lib/workflow-button-response.ts";

for (const choice of ["approve", "reject"] as const) test(`threaded ${choice} binds parent and notice, preserves collection, and resumes exactly once`, async () => {
  const artifact = structuredClone(collectionFixture().artifact);
  const workflow = artifact.workflows!.find((w) => w.id === "monday-handoff")!;
  const decision = structuredClone(artifact.workflows!.find((w) => w.id === "weekday-digest")!.steps.find((s) => s.decision)!);
  decision.id = "review"; decision.next = ["finish", "end"];
  decision.decision = { ...decision.decision!, recipient: "jonas-owner", thread: "$steps.ask.thread_reference", continueIn: "$steps.ask.thread_reference", binds: "$steps.facts", via: "sprint-direct",
    presentation: { version: 1, labels: { approve: "Save", reject: "Keep" } }, targets: { approve: "finish", reject: "end", timeout: "end" }, calendarPath: workflow.schedules[0]!.path };
  workflow.steps[1]!.next = ["review"];
  const finish = structuredClone(workflow.steps[0]!); finish.id = "finish"; finish.next = ["end"]; finish.message!.thread = "$steps.ask.thread_reference";
  workflow.steps.push(decision, finish);
  const { manifestHash, ...manifest } = workflow; workflow.manifestHash = sha256(manifest);
  const { artifactHash, ...content } = artifact; artifact.artifactHash = sha256({ ...content, provenance: { ...content.provenance, builtAt: undefined } });
  let count = 0;
  const notices: any[] = [];
  const h = engineFixture({ artifact, publicationConnector: { id: "synthetic", version: "1", capabilities: ["communication.message.publish"], async invoke(_capability, input: any) {
    notices.push(input);
    const message_id = `${++count}.000001`;
    return { output: { message_id, destination_binding: input.destination_binding, thread_reference: input.thread_reference ?? `slack:D10001:${message_id}`, published_at: "2030-01-07T12:00:00.000Z" }, evidence: { synthetic: true } };
  } }, conversationForReceipt: async ({ output }: any) => ({ surface: "slack", accountId: "T10001", channelId: "D10001", threadId: output.thread_reference.split(":")[2], subjectPrincipal: ENGINE_OWNER }) });
  const engine = h.engine();
  let run = await engine.openOperator({ workflowId: workflow.id, requestId: choice, principal: ENGINE_OPERATOR, fields: { sprint_id: "p1", period_start: "2030-01-07", period_end: "2030-01-11" } });
  run = (await engine.advance(run.runId))!;
  const conversation = { surface: "slack", accountId: "T10001", channelId: "D10001", threadId: "1.000001", subjectPrincipal: ENGINE_OWNER };
  await engine.collect({ principal: ENGINE_OWNER, conversation, eventId: "facts", output: { summary: "Reviewed facts" } });
  run = (await engine.advance(run.runId))!;
  assert.equal(run.state.blocked, undefined, JSON.stringify(run.state));
  assert.equal(notices[1].decision.conversation_reference, "slack:D10001:1.000001");
  const recorded = run.state.decisions.review!;
  assert.equal((recorded.deliveries["jonas-owner"] as any).thread_reference, "slack:D10001:1.000001");
  assert.equal((await h.store.deliveredAssignment({ instanceId: run.instanceId, conversation }))!.stepId, "ask");
  const host = new WorkflowConversationHost({ artifact, engine, store: h.store, control: h.control, roster: async () => h.roster, connectors: async () => [], enabledWorkflowIds: [workflow.id], clock: () => h.now,
    slack: async (op) => op(new WorkflowSlackTransport({ call: async (method, args) => method === "auth.test" ? { ok: true, team_id: "T10001" } : { ok: true, user: { id: args.user, team_id: "T10001", deleted: false, is_bot: false } } })) });
  const value = workflowDecisionId(run.runId, "review", recorded.boundDigest), actionId = `companyos.workflow.${choice}`;
  const input = { actionId, value, threadId: "slack:D10001:1.000001", messageId: "2.000001", userId: "U10002", raw: { type: "block_actions", team: { id: "T10001" }, user: { id: "U10002" }, channel: { id: "D10001" }, message: { ts: "2.000001", thread_ts: "1.000001" }, actions: [{ action_id: actionId, value, action_ts: "1894220000.000001" }] } };
  await assert.rejects(host.receiveAction({ ...input, threadId: "slack:D10001:9.000001", raw: { ...input.raw, message: { ...input.raw.message, thread_ts: "9.000001" } } }));
  await assert.rejects(host.receiveAction({ ...input, messageId: "3.000001", raw: { ...input.raw, message: { ...input.raw.message, ts: "3.000001" } } }));
  await assert.rejects(host.receiveAction({ ...input, userId: "U10001", raw: { ...input.raw, user: { id: "U10001" } } }));
  const act = () => recordWorkflowButtonResponse({ decide: (validated) => host.receiveAction(input, validated), replace: async () => undefined, continueRun: (id) => engine.advance(id, 32) });
  await act(); await act();
  assert.equal((await h.store.read(run.instanceId, run.runId))!.state.status, "done");
  assert.equal(count, choice === "approve" ? 3 : 2);
});
