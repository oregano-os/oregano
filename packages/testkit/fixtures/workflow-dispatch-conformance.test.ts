import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { engineFixture, ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";
import { CompanyOSRuntime, type ExecuteToolRequest } from "../../runtime/companyos-runtime.ts";
import { WorkflowRunContextReader } from "../../runtime/workflow-engine/readers.ts";
import { workflowEffectKey, workflowToolInput } from "../../runtime/workflow-engine/guard.ts";
import type { Connector } from "../../capabilities/contracts.ts";

/** Prepare a real engine step, then acquire the same persisted dispatch claim a
 * worker would use. No caller-supplied WorkflowInvocationContext is fabricated.
 */
async function prepared() {
  const h = engineFixture();
  let run = await h.engine().openOperator({ workflowId: "monday-handoff", requestId: randomUUID(), principal: ENGINE_OPERATOR,
    fields: { period_start: "2030-01-07", period_end: "2030-01-11" } });
  for (let pass = 0; pass < 30 && !(run.state.cursor === "post-handoff" && run.state.steps["post-handoff"]?.inputDigest); pass++) {
    run = (await h.engine().step(run.runId))!;
  }
  assert.equal(run.state.cursor, "post-handoff");
  assert.ok(run.state.steps["post-handoff"]?.inputDigest);
  assert.equal(h.calls.some((call) => call.capability === "communication.message.publish"), false);
  const token = randomUUID();
  const claim = await h.store.claim({ instanceId: run.instanceId, runId: run.runId, owner: "conformance-worker", token,
    now: h.now, expiresAt: "2030-01-04T14:35:00.000Z" });
  assert.ok(claim);
  const reader = new WorkflowRunContextReader({ store: h.store, instanceId: run.instanceId, runId: run.runId,
    leaseToken: token, roster: async () => h.roster, clock: () => h.now });
  const context = await reader.read(), workflow = h.artifact.workflows!.find((entry) => entry.id === run.workflowId)!;
  const step = workflow.steps.find((entry) => entry.id === run.state.cursor)!;
  const request: ExecuteToolRequest = { runId: run.runId, stepId: step.id, agentId: workflow.agentId, grantId: step.tool!.grantId,
    subjectPrincipal: run.subjectPrincipal, input: workflowToolInput(h.artifact, workflow, step, context) };
  const calls: Array<{ capability: string; input: unknown }> = [];
  const connector: Connector = { id: "test/engine", version: "1.0.0", capabilities: ["communication.message.publish"], async invoke(capability, input) {
    calls.push({ capability, input: structuredClone(input) });
    return { output: { destination_binding: (input as any).destination_binding, message_id: "received-message", thread_reference: "received-thread", published_at: h.now },
      evidence: { synthetic: true, receipt: "received-message" } };
  } };
  const runtime = (connectors: Connector[] = [connector]) => new CompanyOSRuntime({ artifact: h.artifact, state: h.control, connectors, workflowContext: reader });
  const release = () => h.store.release({ instanceId: run.instanceId, runId: run.runId, leaseToken: token });
  return { h, run, reader, request, calls, runtime, release, effectKey: workflowEffectKey(h.artifact, context) };
}

test("an actual persisted workflow claim rejects caller changes to run, step, human, Tool, destination and content before dispatch", async () => {
  const { h, run, request, calls, runtime, release, effectKey } = await prepared();
  const changes: Partial<ExecuteToolRequest>[] = [
    { runId: "another-run" }, { stepId: "report" }, { agentId: "another-agent" }, { subjectPrincipal: "slack:T10001:U10002" },
    { grantId: "oregano:work-items/batch-update", input: { resource_binding: "unreviewed-board", updates: [] } },
    { input: { ...(request.input as object), destination_binding: "unreviewed-channel" } },
    { input: { ...(request.input as object), content: "Unreviewed message body" } },
  ];
  for (const change of changes) await assert.rejects(runtime().execute({ ...request, ...change }));
  assert.deepEqual(calls, []);
  assert.equal(await h.control.getEffect(effectKey), undefined);
  assert.equal((await h.store.read(run.instanceId, run.runId))!.state.steps["post-handoff"]!.status, "running");
  const accepted = await runtime().execute(request) as any;
  assert.equal(accepted.output.message_id, "received-message");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { capability: "communication.message.publish", input: request.input });
  assert.equal(await release(), true);
  const completed = (await h.engine().advance(run.runId))!;
  assert.equal(completed.state.status, "done");
  assert.equal((completed.state.steps["post-handoff"]!.output as any).message_id, "received-message");
  assert.equal((completed.state.steps["post-handoff"]!.output as any).destination_binding, "studio-sprints");
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 0, "restart recovers the existing successful effect");
  assert.equal(calls.length, 1);
  assert.equal((await h.control.listEvents(run.runId)).filter((event) => event.event === "tool.effect-succeeded").length, 1);
});

test("a replaced worker lease cannot dispatch from its formerly valid trusted reader", async () => {
  const { h, run, request, calls, runtime, release, effectKey } = await prepared();
  assert.equal(await release(), true);
  const replacement = await h.store.claim({ instanceId: run.instanceId, runId: run.runId, owner: "replacement-worker", token: "replacement-token",
    now: h.now, expiresAt: "2030-01-04T14:35:00.000Z" });
  assert.ok(replacement);
  await assert.rejects(runtime().execute(request), /no longer owns/);
  assert.deepEqual(calls, []);
  assert.equal(await h.control.getEffect(effectKey), undefined);
  assert.equal(await h.store.release({ instanceId: run.instanceId, runId: run.runId, leaseToken: "replacement-token" }), true);
  const completed = (await h.engine().advance(run.runId))!;
  assert.equal(completed.state.status, "done");
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 1);
});

test("an unavailable exact Connector retains failure evidence and cannot fall back or retry blindly after configuration recovery", async () => {
  const { h, run, request, calls, runtime, release, effectKey } = await prepared();
  await assert.rejects(runtime([]).execute(request), /connector|binding|capability/i);
  assert.deepEqual(calls, []);
  assert.equal((await h.control.listEvents(run.runId)).filter((event) => event.event === "tool.effect-succeeded").length, 0);
  assert.equal((await h.store.read(run.instanceId, run.runId))!.state.steps["post-handoff"]!.output, undefined);
  assert.equal((await h.control.getEffect(effectKey))?.status, "failed");
  assert.equal(await release(), true);
  const blocked = (await h.engine().advance(run.runId))!;
  assert.equal(blocked.state.status, "waiting");
  assert.equal(blocked.state.blocked?.stepId, "post-handoff");
  await assert.rejects(h.engine().resume(run.runId, ENGINE_OPERATOR), /requires reconciliation/);
  assert.equal(h.calls.filter((call) => call.context.stepId === "post-handoff").length, 0);
  assert.equal((await h.control.getEffect(effectKey))?.status, "failed");
});

test("changed Artifact bytes cannot replace the immutable Artifact of an ordinary persisted run", async () => {
  const { h, run, release } = await prepared();
  const original = await h.store.getArtifact(run.artifactHash), changed = structuredClone(h.artifact);
  changed.workflows!.find((workflow) => workflow.id === run.workflowId)!.steps.find((step) => step.id === "post-handoff")!.maxRisk = "R4";
  await assert.rejects(h.store.putArtifact(changed), /pinned hash/);
  assert.throws(() => new CompanyOSRuntime({ artifact: changed, state: h.control, connectors: [] }), /pinned hash/);
  assert.deepEqual(await h.store.getArtifact(run.artifactHash), original);
  assert.equal(await release(), true);
  const completed = (await h.engine().advance(run.runId))!;
  assert.equal(completed.state.status, "done");
  assert.equal(completed.artifactHash, run.artifactHash);
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 1);
});
