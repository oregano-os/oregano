import assert from "node:assert/strict";
import { test } from "node:test";
import { completedVerificationFixture } from "./workflow-verification-fixture.ts";
import { ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";
import { InMemoryStateStore } from "../../runtime/memory-state.ts";
import { verifyCompletedWorkflow } from "../../runtime/workflow-engine/verification.ts";
import { parseWorkflowOperatorRequest } from "../../runner-vercel/src/lib/workflow-http.ts";

test("completed evidence verification is repeatable and read-only while identifying synthetic evidence", async () => {
  const { h, run } = await completedVerificationFixture();
  assert.equal(run.state.status, "done");
  const calls = h.calls.length, events = (await h.control.listEvents(run.runId)).length;
  const proof = await h.engine().verify(run.runId, ENGINE_OPERATOR);
  assert.equal(proof.ok, true, JSON.stringify(proof.checks.filter((entry) => !entry.passed)));
  assert.equal(proof.syntheticEvidence, true, "automated fixtures must not become live acceptance");
  assert.equal(proof.counts.waits, 2);
  assert.equal(proof.counts.decisions, 1);
  assert.equal(proof.counts.batches, 1);
  assert.ok(proof.counts.sourceProofs > 0);
  assert.deepEqual(await h.engine().verify(run.runId, ENGINE_OPERATOR), proof);
  assert.equal(h.calls.length, calls);
  assert.equal((await h.control.listEvents(run.runId)).length, events);
  assert.equal(JSON.stringify(proof).includes("Complete bound payload"), false);
});

test("missing, changed and unknown effects cannot pass retrospective verification", async () => {
  const { h, run } = await completedVerificationFixture(), control = h.control as InMemoryStateStore;
  const proof = await h.engine().verify(run.runId, ENGINE_OPERATOR);
  const key = proof.receipts.find((receipt) => receipt.approvalId)!.effectKey;
  const original = structuredClone(control.effects.get(key)!);
  for (const patch of [{ status: "unknown" }, { inputHash: "0".repeat(64) }, { stepId: "other" }, { evidence: null }]) {
    control.effects.set(key, { ...structuredClone(original), ...patch });
    assert.equal((await h.engine().verify(run.runId, ENGINE_OPERATOR)).ok, false);
  }
  control.effects.delete(key);
  assert.equal((await h.engine().verify(run.runId, ENGINE_OPERATOR)).ok, false);
});

test("the retained consumed approval must match the exact effect and actual human decision", async () => {
  const { h, run } = await completedVerificationFixture(), control = h.control as InMemoryStateStore;
  const proof = await h.engine().verify(run.runId, ENGINE_OPERATOR);
  const key = proof.receipts.find((receipt) => receipt.approvalId)!.effectKey;
  const receipt = (await control.getEffectApproval(key))!;
  assert.equal(receipt.consumed, true);
  const original = structuredClone(control.approvals.get(receipt.approvalId)!);
  for (const patch of [{ consumed: false }, { subjectPrincipal: "slack:T10001:U99999" }, { role: "unrelated" }]) {
    control.approvals.set(receipt.approvalId, { ...original, ...patch });
    const changed = await h.engine().verify(run.runId, ENGINE_OPERATOR);
    assert.equal(changed.checks.find((entry) => entry.code === "consumed-bound-approval")?.passed, false);
  }
});

test("an edited run or incomplete audit cannot replace the immutable state journal", async () => {
  const { h, run } = await completedVerificationFixture();
  const changed = structuredClone(run); changed.state.decisions["approve-rollover"]!.bound = [];
  const proof = await verifyCompletedWorkflow({ artifact: h.artifact, run: changed, control: h.control });
  assert.equal(proof.checks.find((entry) => entry.code === "complete-state-journal")?.passed, false);
  const control = h.control as InMemoryStateStore;
  const index = control.events.findIndex((entry) => entry.event === "workflow.timer-fired"); control.events.splice(index, 1);
  const missing = await h.engine().verify(run.runId, ENGINE_OPERATOR);
  assert.equal(missing.ok, false);
  assert.equal(missing.checks.find((entry) => entry.code === "complete-state-journal")?.passed, false);
});

test("freshness alone cannot stand in for complete source proof or publication delivery", async () => {
  const { h, run } = await completedVerificationFixture();
  const changed = structuredClone(run), output = changed.state.steps["read-submissions-at-report"]?.output as any;
  assert.ok(output, "fixture must name the actual report read");
  delete output.synced_through; output.source_proofs = []; output.fresh_until = "2099-01-01T00:00:00Z";
  const proof = await verifyCompletedWorkflow({ artifact: h.artifact, run: changed, control: h.control });
  assert.equal(proof.checks.some((entry) => entry.code === "record-source-completeness" && !entry.passed), true);
  const missing = structuredClone(run); missing.state.decisions["approve-rollover"]!.deliveries = {};
  assert.equal((await verifyCompletedWorkflow({ artifact: h.artifact, run: missing, control: h.control })).ok, false);
});

test("verification refuses an unauthorized principal, active run and unbounded audit", async () => {
  const { h, run } = await completedVerificationFixture();
  await assert.rejects(h.engine().verify(run.runId, "slack:T10001:U99999"), /authorized human operator/);
  const active = structuredClone(run); active.state.status = "waiting";
  assert.equal((await verifyCompletedWorkflow({ artifact: h.artifact, run: active, control: h.control })).ok, false);
  const read = h.control.listEvents.bind(h.control);
  h.control.listEvents = async (_id, limit) => { assert.equal(limit, 10001); return Array.from({ length: 10001 }, () => ({})); };
  assert.equal((await h.engine().verify(run.runId, ENGINE_OPERATOR)).checks.find((entry) => entry.code === "bounded-audit")?.passed, false);
  h.control.listEvents = read;
  await assert.rejects(h.control.listEvents(run.runId, 10002), /read limit/);
  assert.throws(() => parseWorkflowOperatorRequest({ action: "verify", runId: run.runId, principal: ENGINE_OPERATOR }), /Unsupported.*field/);
  assert.deepEqual(parseWorkflowOperatorRequest({ action: "verify", runId: run.runId }), { action: "verify", runId: run.runId });
});
