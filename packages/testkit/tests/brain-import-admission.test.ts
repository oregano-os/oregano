import { validateWorkflowState } from "../../runtime/workflow-engine/state-validation.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { sha256 } from "../../runtime/canonical.ts";
import { freezeTranscriptCohort, type TranscriptSelectionPolicy } from "../../brain/import-policy.ts";
import { parseTranscriptImportBindings, type TranscriptImportBinding } from "../../brain/import-admission.ts";
import { engineArtifact, engineFixture, ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";
import { decodeWorkflowHostingConfiguration, WORKFLOW_CONFIGURATION_ENV } from "../../runner-vercel/src/lib/workflow-configuration.ts";

const policy: TranscriptSelectionPolicy = { mode: "bounded", max_transcripts: 2, meeting_date: { start_at: null, end_at: null } };
function candidate(policyValue = policy, original = engineArtifact()) {
  const artifact = structuredClone(original), workflow = artifact.workflows!.find(w => w.id === "weekday-digest")!;
  const route = structuredClone(artifact.workflows!.flatMap(w => w.steps).find(step => step.route)!);
  Object.assign(route, { id: "finish", owner: workflow.agentId, route: { on: "complete", targets: { complete: "end" } }, next: ["end"] });
  workflow.trigger = { kind: "operator" }; workflow.instance = { key: ["source", "version"], fields: ["trigger_id", "run_date", "source", "version"] };
  workflow.config = { path: "workflows/synthetic/config.yaml", digest: sha256(policyValue), value: { selection: JSON.parse(JSON.stringify(policyValue)) } };
  workflow.entry = "finish"; workflow.steps = [route]; workflow.reservedEffects = [];
  artifact.instance.environment = "preview";
  for (const w of artifact.workflows!) { const { manifestHash, ...body } = w; w.manifestHash = sha256(body); }
  const { artifactHash, ...body } = artifact; artifact.artifactHash = sha256({ ...body, provenance: { ...body.provenance, builtAt: undefined } });
  return artifact;
}
async function fixture() {
  const artifact = candidate(), h = engineFixture({ artifact });
  const setup = { store: h.control, instanceId: artifact.instance.id, importId: "synthetic-import", runId: "initial-cohort", policy,
    now: h.now, reserved: [], inventoryComplete: true, availableFrom: null,
    candidates: ["a", "b", "c"].map(identity => ({ identity, source_version: "metadata-version", meeting_start_at: "2030-01-03T12:00:00Z", origin: "provider" as const, finished: true })) };
  const cohort = await freezeTranscriptCohort(setup);
  const binding: TranscriptImportBinding = { workflowId: "weekday-digest", importId: setup.importId, cohortId: cohort.id, policyField: "selection", sourceIdentityField: "source", sourceVersionField: "version" };
  const bound = engineFixture({ artifact, store: h.store, control: h.control, timerStore: h.timerStore, transcriptImports: [binding] });
  const open = (requestId: string, source = "a", version = "content-version", active = bound) => active.engine().openOperator({ workflowId: binding.workflowId, requestId, principal: ENGINE_OPERATOR, fields: { source, version } });
  return { h: bound, setup, binding, open };
}

test("Workflow admission checks the frozen cohort before opening and survives repeated request identities", async () => {
  const f = await fixture();
  await assert.rejects(f.open("outside", "c"), /outside.*cohort/);
  assert.equal((await f.h.store.list({ instanceId: f.h.artifact.instance.id, limit: 10 })).length, 0);
  const first = await f.open("first-request");
  assert.equal(first.state.sourceAdmission?.cohortId, f.binding.cohortId);
  assert.equal(first.state.sourceAdmission?.sourceVersion, "content-version");
  const done = await f.h.engine().advance(first.runId); assert.equal(done?.state.status, "done");
  f.h.now = "2030-01-06T12:00:00.000Z";
  const retried = await f.open("different-request"); assert.deepEqual(retried, done);
  assert.equal(f.h.calls.length, 0);
  const changed = structuredClone(retried.state); changed.sourceAdmission!.cohortId = "f".repeat(64);
  assert.throws(() => validateWorkflowState(changed, retried.workflowId, f.h.artifact, retried.state), /admission is immutable/);
  assert.notEqual((await f.open("correction", "a", "content-version-2")).runId, first.runId);
  assert.equal((await f.h.store.list({ instanceId: f.h.artifact.instance.id, limit: 10 })).length, 2);
});

test("a Workspace extension preserves old version runs and cannot admit newly selected identities through the old cohort", async () => {
  const f = await fixture(), old = await f.open("initial");
  const extendedPolicy = { ...policy, max_transcripts: 3 };
  const cohort = await freezeTranscriptCohort({ ...f.setup, policy: extendedPolicy, runId: "extension" });
  const next = engineFixture({ artifact: candidate(extendedPolicy, f.h.artifact), store: f.h.store, control: f.h.control,
    timerStore: f.h.timerStore, transcriptImports: [{ ...f.binding, cohortId: cohort.id }] });
  const replay = await f.open("new-deployment", "a", "content-version", next);
  assert.equal(replay.runId, old.runId);
  assert.deepEqual(replay.state.sourceAdmission, old.state.sourceAdmission, "Extension cannot rewrite the original opening proof");
  await assert.rejects(f.open("old-cohort-refill", "c"), /outside.*cohort/);
  assert.ok(await f.open("newly-admitted", "c", "content-version", next));
  const mismatched = engineFixture({ artifact: next.artifact, store: f.h.store, control: f.h.control, timerStore: f.h.timerStore, transcriptImports: [f.binding] });
  await assert.rejects(f.open("unactivated-config", "c", "content-version", mismatched), /matching frozen cohort/);
});

test("missing or foreign registries and ambiguous bindings fail closed", async () => {
  const f = await fixture();
  for (const change of [{ importId: "other-import" }, { cohortId: "f".repeat(64) }]) {
    const h = engineFixture({ artifact: f.h.artifact, store: f.h.store, control: f.h.control, timerStore: f.h.timerStore, transcriptImports: [{ ...f.binding, ...change }] });
    await assert.rejects(f.open("missing-binding-state", "a", "v1", h), /frozen|absent/);
  }
  for (const raw of [[f.binding, f.binding], [{ ...f.binding, sourceVersionField: "source" }], [{ ...f.binding, policyField: "missing" }], [{ ...f.binding, workflowId: "unknown" }], [{ ...f.binding, sourceIdentityField: "run_date" }]])
    assert.throws(() => parseTranscriptImportBindings(raw, f.h.artifact, [f.binding.workflowId]));
});

test("the maintained hosted configuration retains the reviewed admission binding", async () => {
  const f = await fixture();
  const config = { version: 1, instanceId: f.h.artifact.instance.id, artifactHash: f.h.artifact.artifactHash, environment: "preview",
    enabledWorkflowIds: [f.binding.workflowId], autoOpenWorkflowIds: [], schedulePrincipal: ENGINE_OPERATOR, activatedAt: f.h.now,
    maxLatenessMinutes: 10, operators: [{ principal: ENGINE_OPERATOR, secretRef: "env:TEST_OPERATOR_SECRET" }], transcriptImports: [f.binding] };
  const env = { VERCEL_ENV: "preview", TEST_OPERATOR_SECRET: "a".repeat(48), CRON_SECRET: "b".repeat(48), [WORKFLOW_CONFIGURATION_ENV]: gzipSync(JSON.stringify(config)).toString("base64") };
  assert.deepEqual(decodeWorkflowHostingConfiguration(f.h.artifact, env).transcriptImports, [f.binding]);
});
