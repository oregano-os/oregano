import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { engineFixture, ENGINE_OPERATOR, ENGINE_OWNER } from "../workflow-engine-fixture.ts";
import { sha256 } from "../../runtime/canonical.ts";
import { validateWorkflowState } from "../../runtime/workflow-engine/state-validation.ts";
import { prepareWorkflowReadRepair } from "../../runtime/workflow-engine/read-repair.ts";
import { parseWorkflowOperatorRequest } from "../../runner-vercel/src/lib/workflow-http.ts";
import type { WorkflowRun } from "../../state-store/workflow-engine.ts";

const fields = { sprint_id: "period-1", next_sprint_id: "period-2", period_start: "2030-01-07", period_end: "2030-01-11" };
const open = (h: ReturnType<typeof engineFixture>) => h.engine().openOperator({ workflowId: "friday-close", requestId: randomUUID(), principal: ENGINE_OPERATOR, fields, params: { readiness: false } });
const repair = (h: ReturnType<typeof engineFixture>, run: WorkflowRun, fromStepId = "participant-roles") => h.engine().repairReadPhase(run.runId, ENGINE_OPERATOR, { fromStepId, expectedRevision: run.revision, reason: "Refresh the invalid read result" });

function invalidRoles() {
  let valid = false, reads = 0;
  const h = engineFixture({ recordsConnector: { id: "test/engine", version: "1.0.0", capabilities: ["records.query"], async invoke(_capability, raw) {
    reads++;
    const input = raw as Record<string, any>, now = "2030-01-04T14:30:00.000Z";
    const rows = ["jonas-owner", "lea-contributor", "tim-contributor"].map(id => ({ record_id: `role-${id}`, values: { person_ids: [id], lifecycle_state: "active", role: valid ? "delivery" : " " },
      instance_id: h.artifact.instance.id, projection_id: input.projection_id, record_type: "synthetic", source_version_id: sha256(id), projected_at: now }));
    return { output: { projection_id: input.projection_id, rows, observed_at: now, fresh_until: now, snapshot_id: sha256(rows),
      synced_through: input.require_synced_through ?? now, source_proofs: [{ source_id: "synthetic-test-source", source_digest: sha256(rows), run_id: "synthetic-sync", synced_through: now, watermark: "synthetic" }],
      access_decision: { allowed: true, projection_id: input.projection_id, principal_id: ENGINE_OPERATOR, policy_digest: "synthetic-test-policy", reason: "role-allowed", decided_at: now } }, evidence: { synthetic: true } };
  } } });
  return { h, accept() { valid = true; }, get reads() { return reads; } };
}

test("blocked read repair archives invalid successful results and refreshes only the selected suffix", async () => {
  const source = invalidRoles(), { h } = source;
  let run = (await h.engine().advance((await open(h)).runId))!;
  assert.equal(run.state.blocked?.stepId, "snapshot-participants");
  assert.equal(run.state.steps["participant-roles"]!.status, "succeeded");
  const before = structuredClone(run.state), directoryCalls = h.calls.filter(c => c.capability === "directory.members.query").length;
  await h.engine().resume(run.runId, ENGINE_OPERATOR);
  run = (await h.engine().advance(run.runId))!;
  assert.equal(source.reads, 1, "ordinary resume retains the original result");
  source.accept();
  run = await repair(h, run);
  assert.equal(run.state.readRepairs?.length, 1);
  assert.deepEqual(run.state.readRepairs![0]!.steps["participant-roles"], before.steps["participant-roles"]);
  assert.deepEqual(run.state.steps["snapshot-directory"], before.steps["snapshot-directory"]);
  assert.equal(run.state.steps["participant-roles"], undefined);
  run = (await h.engine().advance(run.runId))!;
  assert.equal(run.state.blocked, undefined);
  assert.equal(run.state.cursor, "await-chase");
  assert.equal(source.reads, 2);
  assert.equal(h.calls.filter(c => c.capability === "directory.members.query").length, directoryCalls);
  assert.ok((await h.control.listEvents(run.runId)).some(e => e.event === "workflow.read-repair-authorized"));
});

test("read repair requires operator authority and exact revision and stops after three repairs", async () => {
  const { h } = invalidRoles(); let run = (await h.engine().advance((await open(h)).runId))!;
  const request = { fromStepId: "participant-roles", expectedRevision: run.revision, reason: "Invalid result" };
  await assert.rejects(h.engine().repairReadPhase(run.runId, ENGINE_OWNER, request), /authorized human/);
  await assert.rejects(h.engine().repairReadPhase(run.runId, ENGINE_OPERATOR, { ...request, expectedRevision: run.revision + 1 }), /stale/);
  await assert.rejects(repair(h, run, "work-items-at-report"), /linear|previously attempted/);
  for (let count = 1; count <= 3; count++) {
    run = await repair(h, run); run = (await h.engine().advance(run.runId))!;
    assert.equal(run.state.blocked?.stepId, "snapshot-participants");
    assert.equal(run.state.readRepairs!.length, count);
  }
  await assert.rejects(repair(h, run), /limit/);
  assert.equal((await h.store.read(run.instanceId, run.runId))!.lease, undefined);
});

test("read repair never crosses a publication or wait and never repeats an earlier successful message", async () => {
  const h = engineFixture(); h.missingThread = true;
  let run = (await h.engine().advance((await open(h)).runId))!;
  assert.equal(run.state.blocked?.stepId, "open-close-thread");
  await assert.rejects(repair(h, run, "snapshot-directory"), /without effects/);
  assert.equal(h.calls.filter(c => c.capability === "communication.message.publish").length, 1);
  const second = engineFixture();
  run = (await second.engine().advance((await open(second)).runId))!;
  await assert.rejects(repair(second, run, "snapshot-directory"), /blocked/);
  second.failQuery = true; second.now = "2030-01-04T15:20:00.000Z";
  await second.engine().timers(); run = (await second.engine().advance(run.runId))!;
  assert.equal(run.state.blocked?.stepId, "work-items-at-chase");
  await assert.rejects(repair(second, run, "snapshot-directory"), /without effects/);
  const messages = second.calls.filter(c => c.capability === "communication.message.publish").length;
  const receipt = structuredClone(run.state.steps["open-close-thread"]);
  second.failQuery = false; run = await repair(second, run, "work-items-at-chase");
  assert.deepEqual(run.state.steps["open-close-thread"], receipt);
  assert.equal(second.calls.filter(c => c.capability === "communication.message.publish").length, messages);
});

test("durable validation rejects erased history, tampered archived outputs and unrelated state changes", async () => {
  const { h } = invalidRoles(), run = (await h.engine().advance((await open(h)).runId))!;
  const workflow = h.artifact.workflows!.find(w => w.id === run.workflowId)!;
  const state = prepareWorkflowReadRepair({ artifact: h.artifact, workflow, state: run.state, fromStepId: "participant-roles", principal: ENGINE_OPERATOR, now: h.now, reason: "Invalid result" });
  validateWorkflowState(state, run.workflowId, h.artifact, run.state);
  for (const mutate of [
    (s: typeof state) => { delete s.readRepairs; },
    (s: typeof state) => { s.readRepairs![0]!.steps["participant-roles"]!.output = { invented: true }; },
    (s: typeof state) => { s.steps["snapshot-directory"]!.output = { replaced: true }; },
    (s: typeof state) => { s.logicalInstant = "2030-01-05T00:00:00.000Z"; },
    (s: typeof state) => { s.steps["participant-roles"] = run.state.steps["participant-roles"]!; },
  ]) { const bad = structuredClone(state); mutate(bad); assert.throws(() => validateWorkflowState(bad, run.workflowId, h.artifact, run.state)); }
  const changed = structuredClone(state); changed.readRepairs![0]!.reasonDigest = "a".repeat(64);
  assert.throws(() => validateWorkflowState(changed, run.workflowId, h.artifact, state), /immutable/);
});

test("hosted repair input is exact and cannot carry replacement data or another Artifact", () => {
  const input = { action: "repair-read-phase", runId: `workflow:${"a".repeat(64)}`, fromStepId: "read-source", expectedRevision: 4, reason: "Refresh stale read" };
  assert.deepEqual(parseWorkflowOperatorRequest(input), input);
  for (const patch of [{ expectedRevision: 0 }, { expectedRevision: 1.5 }, { reason: "" }, { fromStepId: "../write" }, { output: {} }, { artifactHash: "a".repeat(64) }]) assert.throws(() => parseWorkflowOperatorRequest({ ...input, ...patch }));
});
