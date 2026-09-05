import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryWorkflowExecutionStore } from "../../runtime/workflow-engine/memory-store.ts";
import { workflowAssignmentKey, workflowOriginDigest } from "../../runtime/workflow-engine/state-validation.ts";
import { workflowStateFixture, WORKFLOW_STATE_NOW as now } from "../workflow-state-fixture.ts";

const fixture = async () => {
  const args = workflowStateFixture(), store = new InMemoryWorkflowExecutionStore();
  await store.putArtifact(args.artifact); const run = await store.create(args);
  return { store, args, run };
};
const lease = (run: { instanceId: string; runId: string }, token = "worker-a") => ({ instanceId: run.instanceId, runId: run.runId, owner: token, token, now, expiresAt: "2030-01-04T12:05:00.000Z" });

test("workflow origin redelivery reuses pinned state and rejects changed fields", async () => {
  const { store, args, run } = await fixture();
  assert.deepEqual(await store.create(args), run);
  args.identity.fields.sprint_id = "changed"; args.identity.originDigest = workflowOriginDigest(args.identity);
  await assert.rejects(store.create(args), /conflicts/);
  const read = (await store.read(run.instanceId, run.runId))!; read.fields.sprint_id = "caller-change";
  assert.equal((await store.read(run.instanceId, run.runId))!.fields.sprint_id, "period-1");
  const artifact = (await store.getArtifact(run.artifactHash))!; artifact.provenance.coreCommit = "forged";
  assert.equal((await store.getArtifact(run.artifactHash))!.provenance.coreCommit, "1".repeat(40));
  assert.equal(store.control.events.filter((event) => event.event === "workflow.opened").length, 1);
});

test("competing workflow workers share one lease; expired owners cannot commit", async () => {
  const { store, run } = await fixture();
  const claims = await Promise.all([store.claim(lease(run)), store.claim(lease(run, "worker-b"))]);
  assert.equal(claims.filter(Boolean).length, 1);
  const resumed = await store.claim({ ...lease(run, "worker-c"), now: "2030-01-04T12:06:00.000Z", expiresAt: "2030-01-04T12:10:00.000Z" });
  assert.ok(resumed);
  assert.equal(await store.commit({ instanceId: run.instanceId, runId: run.runId, expectedRevision: 0, leaseToken: "worker-a", now: "2030-01-04T12:06:00.000Z", state: run.state, event: { name: "workflow.test", stepId: run.state.cursor! } }), undefined);
});

test("completed outputs and decisions are retained across commits; cancellation fences claimed effects", async () => {
  const { store, run } = await fixture(); await store.claim(lease(run));
  const state = structuredClone(run.state);
  state.steps[state.cursor!] = { status: "succeeded", startedAt: now, completedAt: now, output: { rows: [] } };
  const saved = (await store.commit({ instanceId: run.instanceId, runId: run.runId, expectedRevision: 0, leaseToken: "worker-a", now, state, event: { name: "workflow.step-succeeded", stepId: state.cursor! } }))!;
  assert.equal(saved.revision, 1);
  await store.claim(lease(run, "worker-b"));
  const changed = structuredClone(state); changed.steps[state.cursor!]!.output = { rows: ["forged"] };
  await assert.rejects(store.commit({ instanceId: run.instanceId, runId: run.runId, expectedRevision: 1, leaseToken: "worker-b", now, state: changed, event: { name: "workflow.test", stepId: state.cursor! } }), /immutable/);
  const effect = { runId: run.runId, stepId: state.cursor!, idempotencyKey: `${run.runId}:effect`, inputHash: "input" };
  await store.control.claimEffect(effect);
  assert.equal(await store.cancel({ instanceId: run.instanceId, runId: run.runId, principal: "slack:T10001:U10001", now }), true);
  assert.equal(await store.control.markEffectDispatched(effect.idempotencyKey, { instanceId: run.instanceId, runId: run.runId, stepId: state.cursor!, leaseToken: "worker-b", now }), false);
  assert.equal(store.control.runs.get(run.runId)!.status, "cancelled");
  assert.deepEqual((await store.read(run.instanceId, run.runId))!.state.steps, state.steps);
});

test("assignments are exact, private where declared and inactive after cancellation", async () => {
  const { store, run } = await fixture(); await store.claim(lease(run));
  const conversation = { surface: "slack", accountId: "T10001", channelId: "C10001", threadId: "10000.000001", subjectPrincipal: "slack:T10001:U10002" };
  const assignment = { ...conversation, instanceId: run.instanceId, assignmentKey: workflowAssignmentKey(run.instanceId, conversation), runId: run.runId, stepId: run.state.cursor!, artifactHash: run.artifactHash, expiresAt: "2030-01-05T12:00:00.000Z" };
  await store.commit({ instanceId: run.instanceId, runId: run.runId, expectedRevision: 0, leaseToken: "worker-a", now, state: run.state, event: { name: "workflow.bound", stepId: run.state.cursor! }, assignments: [assignment] });
  assert.deepEqual(await store.assignment({ instanceId: run.instanceId, conversation, now }), assignment);
  assert.equal(await store.assignment({ instanceId: run.instanceId, conversation: { ...conversation, subjectPrincipal: "slack:T10001:U10003" }, now }), undefined);
  assert.equal(await store.assignment({ instanceId: run.instanceId, conversation: { ...conversation, accountId: "T20001" }, now }), undefined);
  await store.cancel({ instanceId: run.instanceId, runId: run.runId, principal: conversation.subjectPrincipal, now });
  assert.equal(await store.assignment({ instanceId: run.instanceId, conversation, now }), undefined);
});
