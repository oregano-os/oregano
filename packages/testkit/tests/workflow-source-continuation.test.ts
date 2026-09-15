import assert from "node:assert/strict";
import { test } from "node:test";
import { engineArtifact, engineFixture, ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";
import { sha256, jsonDigest } from "../../runtime/canonical.ts";
import { freezeTranscriptCohort } from "../../brain/import-policy.ts";
import { LanguageAttempt, readLanguageAttempts } from "../../language/attempts.ts";
import { assertUnwrittenSource } from "../../runtime/workflow-engine/source-continuation.ts";
import { parseWorkflowOperatorRequest } from "../../runner-vercel/src/lib/workflow-http.ts";
const policy = { mode: "bounded" as const, max_transcripts: 1, meeting_date: { start_at: null, end_at: null } };
function candidate(original = engineArtifact(), revision = 1) {
  const artifact = structuredClone(original), workflow = artifact.workflows!.find(w => w.id === "weekday-digest")!;
  const route = structuredClone(artifact.workflows!.flatMap(w => w.steps).find(step => step.route)!);
  Object.assign(route, { id: "finish", owner: workflow.agentId, route: { on: "complete", targets: { complete: "end" } }, next: ["end"] });
  workflow.trigger = { kind: "operator" }; workflow.instance = { key: ["source", "version"], fields: ["trigger_id", "run_date", "source", "version"] };
  workflow.config = { path: "workflows/synthetic/config.yaml", digest: sha256({ policy, revision }), value: { selection: policy,
    processing: { max_transcripts: 1, sources: [{ identity: "source-a", version: "v1" }] }, revision } };
  workflow.entry = "finish"; workflow.steps = [route]; workflow.reservedEffects = [];
  for (const w of artifact.workflows!) { const { manifestHash, ...body } = w; w.manifestHash = sha256(body); }
  const { artifactHash, ...body } = artifact; artifact.artifactHash = sha256({ ...body, provenance: { ...body.provenance, builtAt: undefined } });
  return artifact;
}
async function fixture() {
  const artifact = candidate(), h = engineFixture({ artifact });
  const cohort = await freezeTranscriptCohort({ store: h.control, instanceId: artifact.instance.id, importId: "source-trial", runId: "freeze",
    policy, now: h.now, reserved: [], inventoryComplete: true, availableFrom: null,
    candidates: [{ identity: "source-a", source_version: "meta", meeting_start_at: "2030-01-03T12:00:00Z", origin: "provider", finished: true }] });
  const binding = { workflowId: "weekday-digest", importId: "source-trial", cohortId: cohort.id, policyField: "selection", processingField: "processing", sourceIdentityField: "source", sourceVersionField: "version" };
  const old = engineFixture({ artifact, store: h.store, control: h.control, timerStore: h.timerStore, transcriptImports: [binding] });
  const args = { workflowId: binding.workflowId, requestId: "source", principal: ENGINE_OPERATOR, fields: { source: "source-a", version: "v1" } };
  const predecessor = await old.engine().openOperator(args);
  const next = engineFixture({ artifact: candidate(artifact, 2), store: h.store, control: h.control, timerStore: h.timerStore, transcriptImports: [binding] });
  next.now = "2030-01-04T14:31:00.000Z";
  return { old, next, predecessor, args };
}
test("explicit source continuation keeps both immutable definitions and attempts, deduplicating later openings", async () => {
  const f = await fixture(), attempt = new LanguageAttempt(f.old.control, { runId: f.predecessor.runId, stepId: "finish", inputHash: sha256("input"), evidence: { artifact_hash: f.old.artifact.artifactHash } });
  await attempt.prepare(); await attempt.finish("failed", { synthetic: true });
  const before = await readLanguageAttempts(f.old.control, [f.predecessor.runId]);
  const child = await f.next.engine().continueUnwrittenSource(f.predecessor.runId, ENGINE_OPERATOR, f.predecessor.revision, "Adopt reviewed incremental procedure");
  const parent = (await f.old.store.read(f.old.artifact.instance.id, f.predecessor.runId))!;
  assert.equal(parent.state.status, "cancelled"); assert.equal(parent.state.sourceRestart!.successorRunId, child.runId);
  assert.deepEqual(parent.state.steps, f.predecessor.state.steps); assert.equal(parent.artifactHash, f.old.artifact.artifactHash);
  assert.equal(child.artifactHash, f.next.artifact.artifactHash); assert.equal(child.state.sourcePredecessor!.runId, parent.runId);
  assert.deepEqual(child.state.sourceAdmission, parent.state.sourceAdmission);
  assert.deepEqual(await readLanguageAttempts(f.old.control, [parent.runId]), before);
  assert.equal((await f.next.engine().openOperator({ ...f.args, requestId: "retry" })).runId, child.runId);
  assert.equal((await f.next.engine().continueUnwrittenSource(parent.runId, ENGINE_OPERATOR, f.predecessor.revision, "Retry lost response")).runId, child.runId);
  assert.equal((await f.next.engine().advance(child.runId))!.state.status, "done");
  assert.equal((await f.next.engine().openOperator(f.args)).state.status, "done");
  assert.equal((await f.next.store.list({ instanceId: child.instanceId, limit: 10 })).length, 2);
});
test("a lost child creation recovers from the fenced predecessor without starting it again", async () => {
  const f = await fixture(), create = f.next.store.create.bind(f.next.store);
  let lose = true;
  f.next.store.create = async args => { if (args.state.sourcePredecessor && lose) { lose = false; throw new Error("Synthetic child creation interruption"); } return create(args); };
  await assert.rejects(f.next.engine().continueUnwrittenSource(f.predecessor.runId, ENGINE_OPERATOR, f.predecessor.revision, "Reviewed replacement"), /interruption/);
  const parent = (await f.next.store.read(f.predecessor.instanceId, f.predecessor.runId))!;
  assert.equal(parent.state.status, "cancelled");
  const child = await f.next.engine().openOperator(f.args);
  assert.equal(child.runId, parent.state.sourceRestart!.successorRunId);
  assert.deepEqual((await f.next.engine().advance(parent.runId))!.state, parent.state);
});
test("continuation rejects stale revisions, unapproved operators, repeated migration and incomplete paid outcomes", async () => {
  const f = await fixture();
  await assert.rejects(f.next.engine().continueUnwrittenSource(f.predecessor.runId, "slack:T10001:U99999", f.predecessor.revision, "Replacement"), /operator/);
  await assert.rejects(f.next.engine().continueUnwrittenSource(f.predecessor.runId, ENGINE_OPERATOR, f.predecessor.revision + 1, "Replacement"), /changed/);
  const attempt = new LanguageAttempt(f.old.control, { runId: f.predecessor.runId, stepId: "finish", inputHash: sha256("input"), evidence: {} });
  await attempt.prepare();
  await assert.rejects(f.next.engine().continueUnwrittenSource(f.predecessor.runId, ENGINE_OPERATOR, f.predecessor.revision, "Replacement"), /unfinished model/);
  await attempt.finish("failed", {});
  const child = await f.next.engine().continueUnwrittenSource(f.predecessor.runId, ENGINE_OPERATOR, f.predecessor.revision, "Replacement");
  await assert.rejects(f.next.engine().continueUnwrittenSource(child.runId, ENGINE_OPERATOR, child.revision, "Again"), /prior continuation/);
});
test("any attempted write, Agent task, human decision or nested Workflow prevents an unwritten-source migration", async () => {
  const f = await fixture();
  for (const kind of ["effect", "agent", "decision", "start", "message"] as const) {
    const artifact = structuredClone(f.old.artifact), workflow = artifact.workflows!.find(w => w.id === "weekday-digest")!;
    workflow.steps[0]!.kind = kind;
    const state = structuredClone(f.predecessor.state); state.steps.finish = { status: "running", startedAt: f.old.now };
    assert.throws(() => assertUnwrittenSource(state, workflow.id, artifact), /without possible writes/);
  }
  const artifact = structuredClone(f.old.artifact), workflow = artifact.workflows!.find(w => w.id === "weekday-digest")!;
  workflow.steps[0]!.maxRisk = "R1";
  const state = structuredClone(f.predecessor.state); state.steps.finish = { status: "running", startedAt: f.old.now };
  assert.throws(() => assertUnwrittenSource(state, workflow.id, artifact), /without possible writes/);
});
test("the authenticated operator request cannot select an Artifact, new source version or reset fields", () => {
  const request = { action: "continue-unwritten-source", runId: "workflow:" + "a".repeat(64), expectedRevision: 3, reason: "Reviewed replacement" };
  assert.deepEqual(parseWorkflowOperatorRequest(request), request);
  for (const change of [{ artifactHash: "b".repeat(64) }, { fields: {} }, { expectedRevision: -1 }, { reason: "" }]) assert.throws(() => parseWorkflowOperatorRequest({ ...request, ...change }));
});

test("a completed zero-item effect loop is unwritten, but every uncertain or attempted variant is rejected", async () => {
  const f = await fixture(), artifact = structuredClone(f.old.artifact);
  const workflow = artifact.workflows!.find(w => w.id === "weekday-digest")!, step = workflow.steps[0]!;
  step.kind = "effect"; step.maxRisk = "R1"; step.forEach = { over: [], key: "key", maxItems: 10000 };
  const empty = { status: "succeeded" as const, startedAt: f.old.now, completedAt: f.old.now,
    inputDigest: jsonDigest([]), items: {}, output: { items: [] } };
  const state = structuredClone(f.predecessor.state); state.steps.finish = empty;
  assert.doesNotThrow(() => assertUnwrittenSource(state, workflow.id, artifact));
  for (const change of [{ status: "running" }, { inputDigest: jsonDigest(["candidate"]) }, { completedAt: undefined },
    { items: { attempted: { key: "candidate" } } }, { items: undefined }, { output: { items: [{}] } },
    { publicationRecoveries: [] }, { evidence: { operation: "unknown" } }, { agent: { turns: [] } }]) {
    const unsafe = structuredClone(state); Object.assign(unsafe.steps.finish!, change);
    assert.throws(() => assertUnwrittenSource(unsafe, workflow.id, artifact), /without possible writes/);
  }
  const noLoop = structuredClone(artifact); delete noLoop.workflows!.find(w => w.id === workflow.id)!.steps[0]!.forEach;
  assert.throws(() => assertUnwrittenSource(state, workflow.id, noLoop), /without possible writes/);
  const archived = structuredClone(state);
  archived.readRepairs = [{ steps: { finish: { ...empty, inputDigest: jsonDigest(["candidate"]) } } }] as any;
  assert.throws(() => assertUnwrittenSource(archived, workflow.id, artifact), /without possible writes/);
});
