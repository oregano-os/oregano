import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import { engineArtifact, engineFixture, ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";
import { authenticateWorkflowOperator, authenticateWorkflowScheduler, type WorkflowHostingConfiguration } from "../../runner-vercel/src/lib/workflow-configuration.ts";
import { parseWorkflowOperatorRequest } from "../../runner-vercel/src/lib/workflow-http.ts";
import { sha256 } from "../../runtime/canonical.ts";

function workspace(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "workflow-boundaries-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(resolve(import.meta.dirname, "lindenhof-studio"), root, { recursive: true });
  return root;
}
const opening = () => ({ workflowId: "monday-handoff", requestId: randomUUID(), principal: ENGINE_OPERATOR,
  fields: { period_start: "2030-01-07", period_end: "2030-01-11" } });
const close = () => ({ workflowId: "friday-close", requestId: randomUUID(), principal: ENGINE_OPERATOR,
  fields: { sprint_id: "test-period", next_sprint_id: "following-period" } });

test("missing credentials and undeclared clock overrides cannot admit an ordinary workflow", async () => {
  const h = engineFixture();
  const config: WorkflowHostingConfiguration = { version: 1, instanceId: h.artifact.instance.id,
    artifactHash: h.artifact.artifactHash, environment: "development", enabledWorkflowIds: ["monday-handoff"],
    autoOpenWorkflowIds: [], schedulePrincipal: ENGINE_OPERATOR, activatedAt: h.now, maxLatenessMinutes: 60,
    operators: [{ principal: ENGINE_OPERATOR, secretRef: "env:TEST_OPERATOR_SECRET" }] };
  const environment = { TEST_OPERATOR_SECRET: "a".repeat(48), CRON_SECRET: "b".repeat(48) };
  const anonymous = new Request("https://example.test/api/workflows/operator");
  assert.equal(authenticateWorkflowOperator(anonymous, config, environment), undefined);
  assert.equal(authenticateWorkflowScheduler(anonymous, environment), false);
  const authenticated = new Request(anonymous, { headers: { authorization: `Bearer ${environment.TEST_OPERATOR_SECRET}` } });
  assert.equal(authenticateWorkflowOperator(authenticated, config, {}), undefined);
  for (const instant of ["2029-01-01T00:00:00.000Z", "2031-01-01T00:00:00.000Z"]) {
    assert.throws(() => parseWorkflowOperatorRequest({ action: "open", workflowId: "monday-handoff", requestId: "clock-override", fields: {}, instant }), /Unsupported.*field/);
  }
  await assert.rejects(h.engine().openOperator({ ...opening(), principal: "" }), /authenticated active authorized human/);
  assert.deepEqual(await h.store.list({ instanceId: h.artifact.instance.id, limit: 200 }), []);
  assert.equal(h.calls.length, 0);
  const principal = authenticateWorkflowOperator(authenticated, config, environment)!;
  const run = (await h.engine().advance((await h.engine().openOperator({ ...opening(), principal })).runId))!;
  assert.equal(run.subjectPrincipal, ENGINE_OPERATOR);
  assert.equal(run.trigger.instant, h.now);
  assert.equal(run.state.status, "done");
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 1);
});

test("persisted waits reject changed claims and retain foreign timers while one valid wake advances the exact run", async () => {
  const h = engineFixture();
  const waiting = (await h.engine().advance((await h.engine().openOperator(close())).runId))!;
  const [timer] = await h.timers.list("workflow");
  assert.ok(timer);
  const { state: _state, attempts: _attempts, ...identity } = timer!;
  await assert.rejects(h.timers.schedule({ ...identity, timerKind: "unrelated" }), /conflicts/);
  await assert.rejects(h.timers.schedule({ ...identity, payload: { ...identity.payload as any, artifact_hash: "f".repeat(64) } }), /conflicts/);
  await h.timerStore.schedule({ ...identity, instanceId: "foreign-instance" });
  await h.timers.schedule({ ...identity, timerId: "foreign-kind", timerKind: "unrelated", idempotencyKey: "foreign-kind" });
  const foreign = await h.timerStore.list({ instanceId: "foreign-instance" });
  const unrelated = await h.timers.list("unrelated");
  h.now = "2030-01-04T15:20:00.000Z";
  const claimed = await h.timers.claimDue({ timerKind: "workflow", now: h.now, owner: "test-worker", leaseToken: randomUUID(), leaseExpiresAt: "2030-01-04T15:25:00.000Z" });
  assert.equal(claimed.length, 1);
  for (const patch of [{ artifact_hash: "f".repeat(64) }, { workflow_id: "monday-handoff" }, { step_id: "await-report" }, { kind: "decision" }]) {
    assert.equal(await h.engine().wake({ ...claimed[0]!, payload: { ...claimed[0]!.payload as any, ...patch } }), false);
  }
  assert.deepEqual(await h.store.read(waiting.instanceId, waiting.runId), waiting);
  assert.equal(await h.engine().wake(claimed[0]!), true);
  const advanced = (await h.engine().advance(waiting.runId))!;
  assert.equal(advanced.state.cursor, "await-report");
  assert.equal((advanced.state.steps["await-chase"]!.output as any).instant, "2030-01-04T15:20:00.000Z");
  assert.equal(await h.engine().wake(claimed[0]!), false);
  assert.deepEqual(await h.timerStore.list({ instanceId: "foreign-instance" }), foreign);
  assert.deepEqual(await h.timers.list("unrelated"), unrelated);
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 2);
});

test("a persisted timer with another Artifact cannot advance its waiting workflow or fabricate completion", async () => {
  const h = engineFixture();
  const waiting = (await h.engine().advance((await h.engine().openOperator(close())).runId))!;
  const [timer] = await h.timers.list("workflow");
  assert.ok(timer);
  // Model corrupt historical storage, separately from a caller modifying its claim.
  const stored = (h.timerStore as import("../../runtime/memory-durable-timers.ts").InMemoryDurableTimerStore).rows.get(`${waiting.instanceId}\0${timer!.timerId}`)!;
  stored.payload = { ...stored.payload as any, artifact_hash: "f".repeat(64) };
  h.now = "2030-01-04T15:20:00.000Z";
  await assert.rejects(h.engine().timers(), /conflicts with its existing identity/);
  assert.deepEqual(await h.store.read(waiting.instanceId, waiting.runId), waiting);
  const retained = (await h.timers.list("workflow"))[0]!;
  assert.equal(retained.state, "scheduled");
  assert.equal(retained.completedAt, undefined);
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 1);
});

test("unresolved message variables and missing configuration fail compilation while the retained workflow still executes", async (t) => {
  const root = workspace(t), h = engineFixture({ artifact: engineArtifact(undefined, root) });
  const opened = await h.engine().openOperator(opening());
  const template = join(root, "agents/sprint/skills/sprint-sop/assets/monday-handoff-template.md");
  const text = readFileSync(template, "utf8");
  writeFileSync(template, `${text}\n{{not_declared}}\n`);
  assert.throws(() => engineArtifact(undefined, root), /template variable 'not_declared' is not supplied/);
  writeFileSync(template, text);
  const configPath = join(root, "workflows/sprint/config.yaml"), config = YAML.parse(readFileSync(configPath, "utf8"));
  delete config.delivery.channel_binding;
  writeFileSync(configPath, YAML.stringify(config));
  assert.throws(() => engineArtifact(undefined, root), /channel_binding|unresolved|config/i);
  assert.equal(h.calls.length, 0);
  const completed = (await h.engine().advance(opened.runId))!;
  assert.equal(completed.state.status, "done");
  assert.equal(completed.artifactHash, h.artifact.artifactHash);
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 1);
  assert.equal(h.calls.find((call) => call.capability === "communication.message.publish")!.input.destination_binding, "studio-sprints");
});

test("an ordinary run retains exact Agent instructions and Skill material after a new Workspace build", async (t) => {
  const root = workspace(t), h = engineFixture({ artifact: engineArtifact(undefined, root) });
  const opened = await h.engine().openOperator(opening());
  const agent = h.artifact.agents.find((entry) => entry.id === "sprint")!;
  const path = join(root, "agents/sprint/instructions.md");
  writeFileSync(path, `${readFileSync(path, "utf8")}\nReviewed fictional instruction revision.\n`);
  const skill = join(root, "agents/sprint/skills/sprint-sop/SKILL.md");
  writeFileSync(skill, `${readFileSync(skill, "utf8")}\nReviewed fictional procedure revision.\n`);
  const next = engineArtifact(h.artifact.instance.id, root);
  assert.notEqual(next.artifactHash, h.artifact.artifactHash);
  const completed = (await h.engine(next).advance(opened.runId))!;
  assert.equal(completed.state.status, "done");
  const retained = (await h.store.getArtifact(completed.artifactHash))!.agents.find((entry) => entry.id === "sprint")!;
  assert.deepEqual(retained.instructions, agent.instructions);
  assert.deepEqual(retained.materials, agent.materials);
  assert.notDeepEqual(next.agents.find((entry) => entry.id === "sprint")!.instructions, retained.instructions);
  assert.notDeepEqual(next.agents.find((entry) => entry.id === "sprint")!.materials, retained.materials);
  const metadata = await h.control.getRun(opened.runId);
  assert.equal(metadata!.agentDefinitionHash, sha256({ instructions: agent.instructions, materials: agent.materials }));
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 1);
});
