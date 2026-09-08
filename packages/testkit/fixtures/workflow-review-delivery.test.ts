import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { engineFixture, ENGINE_OPERATOR, ENGINE_OWNER } from "../workflow-engine-fixture.ts";
import { workflowDecisionId } from "../../runtime/workflow-engine/decision-notice.ts";
import { WorkflowWorkers } from "../../runtime/workflow-engine/workers.ts";
import { WorkflowReviewContextReader } from "../../runtime/workflow-engine/readers.ts";
import { guardWorkflowInvocation } from "../../runtime/workflow-engine/guard.ts";
import { workflowReviewStepId } from "../../runtime/workflow-engine/review-notice.ts";
import { validateWorkflowState } from "../../runtime/workflow-engine/state-validation.ts";
import { sha256 } from "../../runtime/canonical.ts";

const blocked = async (h: ReturnType<typeof engineFixture>) => {
  let run = await h.engine().openOperator({ workflowId: "friday-close", requestId: randomUUID(), principal: ENGINE_OPERATOR, fields: { sprint_id: "one", next_sprint_id: "two" } });
  await h.engine().advance(run.runId);
  for (const instant of ["2030-01-04T15:20:00.000Z", "2030-01-04T16:00:00.000Z"]) {
    h.now = instant; await h.engine().timers(); run = (await h.engine().advance(run.runId))!;
  }
  const decision = run.state.decisions["approve-rollover"]!;
  await h.engine().decide({ principal: ENGINE_OWNER, conversation: h.conversation("direct-jonas-owner", decision.deliveries["jonas-owner"]!), eventId: randomUUID(),
    requestId: workflowDecisionId(run.runId, decision.stepId, decision.boundDigest), decision: "approved" });
  h.unknownBatch = true;
  const result = (await h.engine().advance(run.runId))!;
  assert.ok(result.state.blocked);
  return result;
};
const reviewCalls = (h: ReturnType<typeof engineFixture>) => h.calls.filter((call) => call.capability === "communication.message.publish" && call.input.content.startsWith("Workflow stopped:"));
const workers = (h: ReturnType<typeof engineFixture>) => new WorkflowWorkers({ engine: h.engine(), artifact: h.artifact, store: h.store, timers: h.timers, clock: () => h.now,
  configuration: { enabledWorkflowIds: h.artifact.workflows!.map((w) => w.id), autoOpenWorkflowIds: [], schedulePrincipal: ENGINE_OPERATOR, activatedAt: h.now, maxLatenessMinutes: 5 } });

test("hosted workers automatically deliver every stopped batch item to the original human conversation", async () => {
  const h = engineFixture();
  for (let n = 2; n <= 44; n++) h.items.push({ record_id: `item-${n}`, values: { ...h.items[0]!.values, work_item_id: `item-${n}` } });
  const run = await blocked(h), cursor = run.state.cursor;
  assert.equal((await workers(h).run("steps")).ok, true);
  const delivered = (await h.store.read(run.instanceId, run.runId))!;
  assert.equal(delivered.state.cursor, cursor); assert.ok(delivered.state.blocked);
  assert.equal(delivered.state.reviewDelivery!.outputs.length, 2);
  const calls = reviewCalls(h); assert.equal(calls.length, 2);
  const original = run.state.decisions["approve-rollover"]!.deliveries["jonas-owner"] as Record<string, string>;
  for (const call of calls) {
    assert.equal(call.input.destination_binding, original.destination_binding);
    assert.equal(call.input.thread_reference, original.thread_reference);
    assert.equal(call.input.format, "plain-text");
  }
  const content = calls.map((call) => call.input.content).join("\n");
  for (let n = 1; n <= 44; n++) assert.equal(content.split(`"item-${n}": unknown`).length - 1, 1);
  assert.equal(content.includes("Synthetic partial batch outcome"), false);
  h.now = "2030-01-04T16:01:00.000Z";
  await workers(h).run("steps"); await h.engine().advance(run.runId);
  assert.equal(reviewCalls(h).length, 2);
  assert.equal(h.calls.filter((call) => call.capability === "work-item.batch-update").length, 1);
  await assert.rejects(h.engine().resume(run.runId, ENGINE_OPERATOR), /reconciliation/);
});

test("restart after review publication recovers its ordinary Runtime receipt without a second send", async () => {
  const h = engineFixture(), run = await blocked(h);
  await h.engine().step(run.runId);
  const commit = h.store.commit.bind(h.store); let crash = true;
  h.store.commit = async (args) => { if (crash && args.event.name === "workflow.review-delivered") { crash = false; throw new Error("Synthetic worker stopped after provider success"); } return commit(args); };
  await assert.rejects(h.engine().step(run.runId), /Synthetic worker stopped/);
  assert.equal(reviewCalls(h).length, 1);
  const recovered = (await h.engine().step(run.runId))!;
  assert.equal(recovered.state.reviewDelivery!.outputs.length, 1);
  assert.equal(reviewCalls(h).length, 1);
  assert.ok(recovered.state.blocked);
});

test("revoked recipient authority prevents delivery and cannot select a replacement human", async () => {
  const h = engineFixture(), run = await blocked(h);
  await h.engine().step(run.runId);
  const owner = h.roster.find((member) => member.principals?.includes(ENGINE_OWNER))!;
  owner.status = "inactive";
  await assert.rejects(h.engine().step(run.runId), /authorized role|authorized human/);
  assert.equal(reviewCalls(h).length, 0);
  owner.status = "active"; owner.role = "different-role";
  await assert.rejects(h.engine().step(run.runId), /authorized role|authorized human/);
  assert.equal(reviewCalls(h).length, 0);
});

test("unknown review publication is retained and neither notification nor business effect is replayed", async () => {
  const h = engineFixture(), run = await blocked(h);
  await h.engine().step(run.runId); h.unknownPublication = true;
  const failed = (await h.engine().step(run.runId))!;
  assert.ok(failed.state.reviewDelivery!.blocked); assert.equal(failed.state.reviewDelivery!.outputs.length, 0);
  assert.equal(reviewCalls(h).length, 1);
  h.unknownPublication = false;
  await h.engine().step(run.runId); await workers(h).run("steps");
  assert.equal(reviewCalls(h).length, 1);
  assert.equal(h.calls.filter((call) => call.capability === "work-item.batch-update").length, 1);
  assert.ok((await h.engine().review(run.runId, ENGINE_OPERATOR)).delivery?.blocked);
});

test("review dispatch fences cannot authorize the business claim and cancellation wins before send", async () => {
  const h = engineFixture(), run = await blocked(h);
  const prepared = (await h.engine().step(run.runId))!, delivery = prepared.state.reviewDelivery!;
  const lease = await h.store.claim({ instanceId: run.instanceId, runId: run.runId, owner: "test-review", token: randomUUID(), now: h.now, expiresAt: "2030-01-04T16:01:00.000Z" });
  const reader = new WorkflowReviewContextReader({ store: h.store, instanceId: run.instanceId, runId: run.runId, leaseToken: lease!.lease!.token, roster: async () => h.roster, clock: () => h.now });
  const context = await reader.read(), tool = h.artifact.agents.find((a) => a.id === "sprint")!.tools.find((tool) => tool.contract.runtimeId === "oregano:communications/publish")!;
  const request = { runId: run.runId, stepId: workflowReviewStepId(delivery.blockedStepId, 0), agentId: "sprint", grantId: tool.contract.grantId!, input: delivery.pages[0]!.input, subjectPrincipal: ENGINE_OWNER };
  await guardWorkflowInvocation({ artifact: h.artifact, reader, request, tool, risk: "R2" });
  for (const input of [{ ...request.input as object, content: "changed" }, { ...request.input as object, destination_binding: "other" }]) await assert.rejects(guardWorkflowInvocation({ artifact: h.artifact, reader, request: { ...request, input }, tool, risk: "R2" }), /frozen state/);
  await h.control.claimEffect({ idempotencyKey: "synthetic-business-claim", runId: run.runId, stepId: delivery.blockedStepId, inputHash: delivery.pages[0]!.inputDigest });
  assert.equal(await h.control.markEffectDispatched("synthetic-business-claim", context.dispatchFence), false);
  const changed = structuredClone(prepared.state); (changed.reviewDelivery!.pages[0]!.input as Record<string, string>).content = "changed";
  assert.throws(() => validateWorkflowState(changed, run.workflowId, h.artifact, prepared.state), /frozen effect review/);
  await h.engine().cancel(run.runId, ENGINE_OPERATOR);
  await assert.rejects(reader.read(), /lease/);
  assert.equal(await h.control.markEffectDispatched("synthetic-business-claim", context.dispatchFence), false);
  await h.engine().step(run.runId); assert.equal(reviewCalls(h).length, 0);
});

test("review notices obey delivery windows and can report an expired decision without renewing it", async () => {
  const h = engineFixture(), run = await blocked(h);
  await h.engine().step(run.runId); h.now = "2030-01-04T20:00:00.000Z";
  const waiting = (await h.engine().step(run.runId))!;
  assert.equal(waiting.state.cursor, run.state.cursor); assert.equal(reviewCalls(h).length, 0);
  h.now = "2030-01-09T09:00:00.000Z";
  assert.ok(run.state.decisions["approve-rollover"]!.expiresAt < h.now);
  const delivered = (await h.engine().step(run.runId))!; assert.equal(reviewCalls(h).length, 1);
  assert.deepEqual(delivered.state.decisions, run.state.decisions);
  await assert.rejects(h.engine().resume(run.runId, ENGINE_OPERATOR), /reconciliation/);
});

test("cancellation between notice claim and dispatch prevents the actual publication", async () => {
  const h = engineFixture(), run = await blocked(h);
  await h.engine().step(run.runId);
  const dispatch = h.control.markEffectDispatched.bind(h.control);
  h.control.markEffectDispatched = async (key, fence) => { if (fence?.review) await h.engine().cancel(run.runId, ENGINE_OPERATOR); return dispatch(key, fence); };
  assert.equal((await h.engine().step(run.runId))!.state.status, "cancelled");
  assert.equal((await h.store.read(run.instanceId, run.runId))!.state.status, "cancelled");
  assert.equal(reviewCalls(h).length, 0);
});

test("retained review delivery keeps the original Artifact and disabled hosted work cannot send", async () => {
  const h = engineFixture(), run = await blocked(h);
  await h.engine().step(run.runId);
  const disabled = new WorkflowWorkers({ engine: h.engine(), artifact: h.artifact, store: h.store, timers: h.timers, clock: () => h.now,
    configuration: { enabledWorkflowIds: [], autoOpenWorkflowIds: [], schedulePrincipal: ENGINE_OPERATOR, activatedAt: h.now, maxLatenessMinutes: 5 } });
  assert.equal((await disabled.run("steps")).ok, true);
  assert.equal(reviewCalls(h).length, 0);
  const updated = structuredClone(h.artifact);
  updated.workflowBindings!.directRecipients.find((entry) => entry.memberId === "jonas-owner")!.destinationBinding = "changed-deployment-destination";
  const { artifactHash: _, ...content } = updated;
  updated.artifactHash = sha256({ ...content, provenance: { ...content.provenance, builtAt: undefined } });
  const delivered = (await h.engine(updated).step(run.runId))!;
  assert.equal(delivered.artifactHash, run.artifactHash);
  assert.equal(reviewCalls(h).length, 1);
  assert.equal(reviewCalls(h)[0]!.input.destination_binding, "direct-jonas-owner");
});
