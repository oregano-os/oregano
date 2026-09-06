import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import { engineArtifact, engineFixture, ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";
import { validateJsonSchemaValue } from "../../capabilities/validation.ts";
import type { JsonSchema } from "../../capabilities/contracts.ts";

const { validateWorkspace } = await import(new URL("../../cli/src/workspace-validator.mjs", import.meta.url).href);

function workspace(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "workflow-declarations-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(resolve(import.meta.dirname, "lindenhof-studio"), root, { recursive: true });
  return root;
}
const configurationPath = "workflows/sprint/config.yaml";
const calendarPath = "schedules/sprint-rhythm.yaml";
const read = (root: string, path: string) => YAML.parse(readFileSync(join(root, path), "utf8"));
const write = (root: string, path: string, value: unknown) => writeFileSync(join(root, path), YAML.stringify(value));
const opening = () => ({ workflowId: "monday-handoff", requestId: randomUUID(), principal: ENGINE_OPERATOR,
  fields: { period_start: "2030-01-07", period_end: "2030-01-11" } });

test("validated Record declarations and literal company parameters compile into ordinary executable workflows", async (t) => {
  const root = workspace(t), config = read(root, configurationPath);
  config.delivery.channel_binding = "fictional-reviewed-destination";
  config.review_policy = { thresholds: [0, 2, 5], enabled: true, optional: null, label: "Reviewed company parameter" };
  write(root, configurationPath, config);
  const validation = validateWorkspace(root);
  assert.deepEqual(validation.diagnostics.filter((entry: any) => entry.severity === "error"), []);
  assert.equal(validation.summary.record_sources, 3);
  assert.equal(validation.summary.record_projections, 3);
  const h = engineFixture({ artifact: engineArtifact(undefined, root) });
  const run = (await h.engine().advance((await h.engine().openOperator(opening())).runId))!;
  assert.equal(run.state.status, "done");
  assert.deepEqual(h.artifact.workflows!.map((workflow) => workflow.id).sort(), ["board-hygiene", "friday-close", "monday-handoff", "weekday-digest"]);
  const compiled = h.artifact.workflows!.find((workflow) => workflow.id === "monday-handoff")!;
  assert.ok(compiled.config);
  assert.equal((compiled.config.value as any).schema_version, 2);
  assert.deepEqual((compiled.config.value as any).review_policy, config.review_policy);
  assert.equal(h.calls.find((call) => call.capability === "communication.message.publish")!.input.destination_binding, "fictional-reviewed-destination");
  assert.equal(h.calls.some((call) => call.capability === "work-item.batch-update"), false);
});

test("unsafe Record materialization and unresolved workflow projections fail before another run can execute", async (t) => {
  const root = workspace(t), h = engineFixture({ artifact: engineArtifact(undefined, root) });
  const run = (await h.engine().advance((await h.engine().openOperator(opening())).runId))!;
  assert.equal(run.state.status, "done");
  const projectionPath = "records/projections/sprint-work-items.yaml", projection = read(root, projectionPath);
  projection.materialization = { mode: "workspace-proposal", target: ".companyos/generated.md" };
  write(root, projectionPath, projection);
  const codes = new Set(validateWorkspace(root).diagnostics.filter((entry: any) => entry.severity === "error").map((entry: any) => entry.code));
  assert.ok(codes.has("WS047"));
  projection.materialization = { mode: "database-view" };
  write(root, projectionPath, projection);
  const config = read(root, configurationPath); config.work_items.projection = "missing-projection";
  write(root, configurationPath, config);
  assert.throws(() => engineArtifact(undefined, root), /missing-projection|unknown projection|Unknown projection/);
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 1);
});

test("the referenced generic calendar validates executable times and rejects undeclared credential fields", async (t) => {
  const root = workspace(t), calendar = read(root, calendarPath);
  const schema = JSON.parse(readFileSync(new URL("../../schema/schedule-v1.schema.json", import.meta.url), "utf8")) as JsonSchema;
  assert.deepEqual(validateJsonSchemaValue(schema, calendar), []);
  const h = engineFixture({ artifact: engineArtifact(undefined, root) });
  const run = (await h.engine().advance((await h.engine().openOperator(opening())).runId))!;
  assert.equal(run.state.status, "done");
  const errors = validateJsonSchemaValue(schema, { ...calendar, token: "synthetic-forbidden-field" });
  assert.ok(errors.some((error) => error.includes("token") && error.includes("not allowed")));
  write(root, calendarPath, { ...calendar, token: "synthetic-forbidden-field" });
  assert.throws(() => engineArtifact(undefined, root), /token.*not allowed|additional properties/);
  calendar.triggers[0].at = "25:90";
  write(root, calendarPath, calendar);
  assert.throws(() => engineArtifact(undefined, root), /pattern|time|calendar/i);
});

test("literal config rejects dynamic references and unsafe keys without rewriting the retained run", async (t) => {
  const root = workspace(t), h = engineFixture({ artifact: engineArtifact(undefined, root) });
  const run = (await h.engine().advance((await h.engine().openOperator(opening())).runId))!;
  assert.equal(run.state.status, "done");
  const config = read(root, configurationPath);
  config.delivery.channel_binding = "$trigger.params.destination";
  write(root, configurationPath, config);
  assert.throws(() => engineArtifact(undefined, root), /literal values are required/);
  config.delivery.channel_binding = "reviewed-destination";
  config.review_policy = { constructor: "forbidden" };
  write(root, configurationPath, config);
  assert.throws(() => engineArtifact(undefined, root), /Unsafe workflow config key/);
  assert.deepEqual(await h.engine().advance(run.runId), run);
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 1);
});
