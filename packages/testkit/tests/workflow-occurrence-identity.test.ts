import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { sha256 } from "../../runtime/canonical.ts";
import { engineArtifact, engineFixture, ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";
import { WorkflowWorkers } from "../../runtime/workflow-engine/workers.ts";
import { decodeWorkflowHostingConfiguration, WORKFLOW_CONFIGURATION_ENV } from "../../runner-vercel/src/lib/workflow-configuration.ts";

function occurrenceFixture(optIn = true) {
  const artifact = structuredClone(engineArtifact());
  const workflow = artifact.workflows!.find(w => w.id === "weekday-digest")!;
  workflow.instance = optIn
    ? { key: ["trigger_id", "trigger_instant"], fields: ["trigger_id", "run_date", "trigger_instant"] }
    : { key: ["trigger_id", "run_date"], fields: ["trigger_id", "run_date"] };
  if (workflow.trigger.kind !== "schedule") throw new Error("Expected a scheduled fixture workflow");
  const triggerId = workflow.trigger.id;
  const calendar = workflow.schedules[0]!.declaration;
  calendar.activation = "active"; calendar.timezone = "UTC";
  calendar.triggers = ["09:00", "09:10"].map(at => ({ id: triggerId, weekdays: ["friday"], at, params: { readiness: false } }));
  artifact.instance.environment = "preview";
  for (const w of artifact.workflows!) { const { manifestHash, ...manifest } = w; w.manifestHash = sha256(manifest); }
  const { artifactHash, ...content } = artifact;
  artifact.artifactHash = sha256({ ...content, provenance: { ...content.provenance, builtAt: undefined } });
  const h = engineFixture({ artifact });
  h.now = "2030-01-04T09:00:00.000Z";
  return { h, workflow };
}

test("separate same-day scheduled occurrences retain distinct identity and exact retries", async () => {
  const { h, workflow } = occurrenceFixture();
  const open = (instant: string) => h.engine().openScheduled({ workflowId: workflow.id, principal: ENGINE_OPERATOR, fields: {}, instant });
  const first = await open(h.now);
  h.now = "2030-01-04T09:10:00.000Z";
  const second = await open(h.now);
  assert.notEqual(second.runId, first.runId);
  assert.equal(first.fields.trigger_instant, first.trigger.instant);
  assert.equal(second.fields.trigger_instant, second.trigger.instant);
  h.now = "2030-01-04T09:12:00.000Z";
  assert.deepEqual(await open(first.trigger.instant), first);
  assert.deepEqual(await open(second.trigger.instant), second);
  assert.equal((await h.store.list({ instanceId: h.artifact.instance.id, limit: 20 })).length, 2);
});

test("trusted occurrence fields cannot be forged by operator or scheduler business input", async () => {
  const { h, workflow } = occurrenceFixture();
  for (const name of ["trigger_id", "run_date", "trigger_instant"]) {
    const fields = { [name]: "forged" };
    await assert.rejects(h.engine().openScheduled({ workflowId: workflow.id, principal: ENGINE_OPERATOR, fields, instant: h.now }), /trusted trigger/);
    await assert.rejects(h.engine().openOperator({ workflowId: workflow.id, principal: ENGINE_OPERATOR, fields, requestId: name }), /trusted trigger/);
  }
  assert.equal((await h.store.list({ instanceId: h.artifact.instance.id, limit: 20 })).length, 0);
});

test("operator retry preserves the original derived occurrence field after a clock change", async () => {
  const { h, workflow } = occurrenceFixture();
  const args = { workflowId: workflow.id, principal: ENGINE_OPERATOR, fields: {}, requestId: "same-request" };
  const first = await h.engine().openOperator(args);
  h.now = "2030-01-05T09:00:00.000Z";
  assert.deepEqual(await h.engine().openOperator(args), first);
});

test("ordinary daily keys keep their historical identity and do not gain a new stored field", async () => {
  const { h, workflow } = occurrenceFixture(false);
  const args = { workflowId: workflow.id, principal: ENGINE_OPERATOR, fields: {}, instant: h.now };
  const first = await h.engine().openScheduled(args);
  assert.equal(Object.hasOwn(first.fields, "trigger_instant"), false);
  assert.deepEqual(await h.engine().openScheduled(args), first);
  await assert.rejects(h.engine().openScheduled({ ...args, instant: "2030-01-04T09:10:00.000Z" }), /conflicts/);
});

test("hosted timer scans open both occurrences and reject arbitrary business-key fields", async () => {
  const { h, workflow } = occurrenceFixture();
  const config = { version: 1, instanceId: h.artifact.instance.id, artifactHash: h.artifact.artifactHash, environment: "preview",
    enabledWorkflowIds: [workflow.id], autoOpenWorkflowIds: [workflow.id], schedulePrincipal: ENGINE_OPERATOR,
    activatedAt: "2030-01-04T08:59:00.000Z", maxLatenessMinutes: 60,
    operators: [{ principal: ENGINE_OPERATOR, secretRef: "env:TEST_OPERATOR_SECRET" }] };
  const env = { VERCEL_ENV: "preview", TEST_OPERATOR_SECRET: "a".repeat(48), CRON_SECRET: "b".repeat(48),
    [WORKFLOW_CONFIGURATION_ENV]: gzipSync(JSON.stringify(config)).toString("base64") };
  const decoded = decodeWorkflowHostingConfiguration(h.artifact, env);
  const worker = () => new WorkflowWorkers({ engine: h.engine(), artifact: h.artifact, store: h.store, timers: h.timers, configuration: decoded, clock: () => h.now });
  const first = await worker().run("timers"); assert.equal(first.ok, true, JSON.stringify(first));
  h.now = "2030-01-04T09:10:00.000Z";
  const second = await worker().run("timers"); assert.equal(second.ok, true, JSON.stringify(second));
  const runs = await h.store.list({ instanceId: h.artifact.instance.id, limit: 20 });
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map(r => r.fields.trigger_instant).sort(), ["2030-01-04T09:00:00.000Z", "2030-01-04T09:10:00.000Z"]);
  const invalid = structuredClone(h.artifact);
  invalid.workflows!.find(w => w.id === workflow.id)!.instance.key.push("business_period");
  invalid.workflows!.find(w => w.id === workflow.id)!.instance.fields.push("business_period");
  assert.throws(() => decodeWorkflowHostingConfiguration(invalid, env), /explicit business fields/);
});
