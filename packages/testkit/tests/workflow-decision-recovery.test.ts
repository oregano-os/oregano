import assert from "node:assert/strict";
import { test } from "node:test";
import { collectionFixture } from "../workflow-collection-fixture.ts";
import { engineFixture, ENGINE_OPERATOR, ENGINE_OWNER } from "../workflow-engine-fixture.ts";
import { sha256 } from "../../runtime/canonical.ts";
import { InMemoryStateStore } from "../../runtime/memory-state.ts";
import { parseWorkflowOperatorRequest } from "../../runner-vercel/src/lib/workflow-http.ts";
import { validateWorkflowState } from "../../runtime/workflow-engine/state-validation.ts";

async function blockedFixture(proven = true) {
  const artifact = structuredClone(collectionFixture().artifact);
  const workflow = artifact.workflows!.find((w) => w.id === "monday-handoff")!;
  const decision = structuredClone(artifact.workflows!.find((w) => w.id === "weekday-digest")!.steps.find((s) => s.decision)!);
  decision.id = "review"; decision.next = ["finish", "end"];
  decision.decision = { ...decision.decision!, recipient: "jonas-owner", thread: "$steps.ask.thread_reference", binds: "$steps.facts", via: "sprint-direct",
    presentation: { version: 1, labels: { approve: "Save", reject: "Keep" } }, targets: { approve: "finish", reject: "end", timeout: "end" }, calendarPath: workflow.schedules[0]!.path };
  workflow.steps[1]!.next = ["review"];
  const finish = structuredClone(workflow.steps[0]!); finish.id = "finish"; finish.next = ["end"]; finish.message!.thread = "$steps.ask.thread_reference";
  workflow.steps.push(decision, finish);
  const { manifestHash, ...manifest } = workflow; workflow.manifestHash = sha256(manifest);
  const { artifactHash, ...content } = artifact; artifact.artifactHash = sha256({ ...content, provenance: { ...content.provenance, builtAt: undefined } });
  let notices = 0, stopped = true;
  const h = engineFixture({ artifact,
    verifyPublicationNotSent: async () => proven ? { provider: "synthetic", reason: "rejected-before-send" } : undefined,
    publicationConnector: { id: "synthetic", version: "1", capabilities: ["communication.message.publish"], async invoke(_capability, raw: any) {
      if (raw.decision && stopped) throw new Error("Synthetic rejection before send");
      const message_id = `${++notices}.000001`;
      return { output: { message_id, destination_binding: raw.destination_binding, thread_reference: raw.thread_reference ?? `slack:D10001:${message_id}`, published_at: "2030-01-07T12:00:00.000Z" }, evidence: { synthetic: true } };
    } }, conversationForReceipt: async ({ output }: any) => ({ surface: "slack", accountId: "T10001", channelId: "D10001", threadId: output.thread_reference.split(":")[2], subjectPrincipal: ENGINE_OWNER }) });
  const control = h.control as InMemoryStateStore;
  const engine = h.engine();
  let run = await engine.openOperator({ workflowId: workflow.id, requestId: "recovery", principal: ENGINE_OPERATOR, fields: { sprint_id: "p1", period_start: "2030-01-07", period_end: "2030-01-11" } });
  await engine.advance(run.runId);
  await engine.collect({ principal: ENGINE_OWNER, conversation: { surface: "slack", accountId: "T10001", channelId: "D10001", threadId: "1.000001", subjectPrincipal: ENGINE_OWNER }, eventId: "facts", output: { summary: "Reviewed facts" } });
  run = (await engine.advance(run.runId))!;
  assert.equal(run.state.blocked?.stepId, "review");
  const failed = [...control.effects.entries()].find(([, effect]) => effect.status === "failed")!;
  assert.ok(failed);
  return { h, engine, run, control, failed, allow: () => { stopped = false; }, count: () => notices };
}

test("verified decision recovery preserves the failed ledger, exact proposal, original thread, and human gate", async () => {
  const { h, engine, run, control, failed, allow, count } = await blockedFixture();
  const old = structuredClone(failed[1]), decision = structuredClone(run.state.decisions.review!);
  await assert.rejects(engine.resume(run.runId, ENGINE_OPERATOR), /reconciliation/);
  allow();
  const attempts = await Promise.allSettled([engine.recoverUnpublishedDecision(run.runId, ENGINE_OPERATOR), engine.recoverUnpublishedDecision(run.runId, ENGINE_OPERATOR)]);
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(count(), 1, "authorizing recovery does not publish");
  const recovered = (await h.store.read(run.instanceId, run.runId))!;
  assert.deepEqual(recovered.state.decisions.review, decision);
  for (const mutate of [(s: any) => { delete s.steps.review.publicationRecoveries; }, (s: any) => { s.steps.review.publicationRecoveries['jonas-owner'].inputDigest = 'a'.repeat(64); }]) {
    const changed = structuredClone(recovered.state); mutate(changed);
    assert.throws(() => validateWorkflowState(changed, run.workflowId, h.artifact, recovered.state), /immutable/);
  }
  const restarted = h.engine();
  const waiting = (await restarted.advance(run.runId))!;
  assert.equal(waiting.state.blocked, undefined);
  assert.equal(waiting.state.wait?.kind, "decision");
  assert.equal(waiting.state.decisions.review!.status, "pending");
  assert.equal(waiting.state.decisions.review!.boundDigest, decision.boundDigest);
  assert.equal((waiting.state.decisions.review!.deliveries['jonas-owner'] as any).thread_reference, "slack:D10001:1.000001");
  await restarted.advance(run.runId);
  await assert.rejects(restarted.recoverUnpublishedDecision(run.runId, ENGINE_OPERATOR));
  assert.equal(count(), 2, "one root and one review; no completion or duplicate send");
  assert.deepEqual(control.effects.get(failed[0]), old);
  assert.equal([...control.effects.values()].filter((e) => e.status === "succeeded").length, 2);
  assert.equal(control.events.filter((e) => e.event === "workflow.decision-publication-recovery-authorized").length, 1);
});

for (const scenario of ["unknown", "dispatched", "claimed", "succeeded", "changed-input", "wrong-run", "wrong-step", "no-proof", "expired", "unauthorized"] as const) test(`decision recovery rejects ${scenario} without sends or ledger changes`, async () => {
  const { h, engine, run, failed, count, control } = await blockedFixture(scenario !== "no-proof");
  if (["unknown", "dispatched", "claimed", "succeeded"].includes(scenario)) failed[1].status = scenario;
  if (scenario === "changed-input") failed[1].inputHash = "a".repeat(64);
  if (scenario === "wrong-run") failed[1].runId = "another-run";
  if (scenario === "wrong-step") failed[1].stepId = "another-step";
  if (scenario === "expired") h.now = run.state.decisions.review!.expiresAt;
  const before = structuredClone(failed[1]);
  await assert.rejects(engine.recoverUnpublishedDecision(run.runId, scenario === "unauthorized" ? ENGINE_OWNER : ENGINE_OPERATOR));
  assert.equal(count(), 1);
  assert.deepEqual(control.effects.get(failed[0]), before);
  assert.equal((await h.store.read(run.instanceId, run.runId))!.state.steps.review!.publicationRecoveries, undefined);
});

test("recovery operator request accepts no supplied proof, principal, destination, content, or approval", () => {
  const input = { action: "recover-unpublished-decision", runId: `workflow:${'1'.repeat(64)}` };
  assert.deepEqual(parseWorkflowOperatorRequest(input), input);
  for (const key of ["proof", "principal", "content", "decision", "destination", "force"]) assert.throws(() => parseWorkflowOperatorRequest({ ...input, [key]: true }));
});
