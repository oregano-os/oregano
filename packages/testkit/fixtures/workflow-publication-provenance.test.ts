import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { engineArtifact, engineFixture, ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";

test("a pending handoff retains its compiled publication authority after a new Workspace revision", async () => {
  const h = engineFixture();
  const opened = await h.engine().openOperator({ workflowId: "monday-handoff", requestId: randomUUID(), principal: ENGINE_OPERATOR,
    fields: { period_start: "2030-01-07", period_end: "2030-01-11" } });
  let pending = opened;
  for (let index = 0; index < 20 && pending.state.cursor !== "post-handoff"; index++) pending = (await h.engine().step(pending.runId))!;
  assert.equal(pending.state.cursor, "post-handoff");
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 0);

  const root = mkdtempSync(resolve(tmpdir(), "workflow-publication-revision-"));
  try {
    cpSync(resolve(import.meta.dirname, "lindenhof-studio"), root, { recursive: true });
    const templatePath = resolve(root, "agents/sprint/skills/sprint-sop/assets/monday-handoff-template.md");
    writeFileSync(templatePath, readFileSync(templatePath, "utf8").replace("Monday Sprint overview", "Revised delivery overview"));
    const configPath = resolve(root, "workflows/sprint/config.yaml");
    writeFileSync(configPath, readFileSync(configPath, "utf8").replace("channel_binding: studio-sprints", "channel_binding: studio-next-channel"));
    const updated = engineArtifact(h.artifact.instance.id, root);
    assert.notEqual(updated.artifactHash, h.artifact.artifactHash);
    const originalWorkflow = h.artifact.workflows!.find((workflow) => workflow.id === "monday-handoff")!;
    const updatedWorkflow = updated.workflows!.find((workflow) => workflow.id === "monday-handoff")!;
    assert.notEqual(updatedWorkflow.manifestHash, originalWorkflow.manifestHash);
    assert.notEqual(updatedWorkflow.templates[0]!.digest, originalWorkflow.templates[0]!.digest);

    const completed = (await h.engine(updated).advance(pending.runId))!;
    assert.equal(completed.state.status, "done", JSON.stringify(completed.state));
    assert.equal(completed.artifactHash, h.artifact.artifactHash);
    assert.equal(completed.manifestHash, originalWorkflow.manifestHash);
    const messages = h.calls.filter((call) => call.capability === "communication.message.publish");
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.input.destination_binding, "studio-sprints");
    assert.match(messages[0]!.input.content, /^Monday Sprint overview/);
    assert.doesNotMatch(messages[0]!.input.content, /Revised delivery overview/);
    assert.equal(messages[0]!.context.agentId, "sprint");
    assert.equal(messages[0]!.context.toolId, originalWorkflow.steps.find((step) => step.id === "post-handoff")!.tool!.runtimeId);
    assert.equal(messages[0]!.context.runId, completed.runId);
    assert.equal(messages[0]!.context.stepId, "post-handoff");
    assert.equal(messages[0]!.context.instanceId, completed.instanceId);
    const events = await h.control.listEvents(completed.runId);
    const validated = events.find((event) => event.event === "workflow.tool-validated" && (event.step_id ?? event.stepId) === "post-handoff")!;
    assert.equal((validated.payload as any).artifact_hash, h.artifact.artifactHash);
    assert.equal((validated.payload as any).manifest_hash, originalWorkflow.manifestHash);
    assert.equal((validated.payload as any).workspace_commit, h.artifact.provenance.workspaceCommit);
    const frozen = (await h.store.getArtifact(completed.artifactHash))!.workflows!.find((workflow) => workflow.id === "monday-handoff")!;
    assert.deepEqual(frozen.templates, originalWorkflow.templates);
    assert.deepEqual(frozen.config, originalWorkflow.config);
    assert.deepEqual(frozen.schedules, originalWorkflow.schedules);
    assert.deepEqual(await h.engine(updated).advance(completed.runId), completed);
    assert.deepEqual(await h.control.listEvents(completed.runId), events);
    assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 1);

    const next = await h.engine(updated).openOperator({ workflowId: "monday-handoff", requestId: randomUUID(), principal: ENGINE_OPERATOR,
      fields: { period_start: "2030-01-14", period_end: "2030-01-18" } });
    assert.equal((await h.engine(updated).advance(next.runId))!.state.status, "done");
    const later = h.calls.filter((call) => call.capability === "communication.message.publish");
    assert.equal(later.length, 2);
    assert.equal(later[1]!.input.destination_binding, "studio-next-channel");
    assert.match(later[1]!.input.content, /^Revised delivery overview/);
    assert.notEqual(later[1]!.context.idempotencyKey, later[0]!.context.idempotencyKey);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ordinary close publications retain one Agent and run with distinct governed steps and the received root thread", async () => {
  const h = engineFixture();
  const opened = await h.engine().openOperator({ workflowId: "friday-close", requestId: randomUUID(), principal: ENGINE_OPERATOR,
    fields: { sprint_id: "current", next_sprint_id: "following" } });
  let run = (await h.engine().advance(opened.runId))!;
  h.now = "2030-01-04T15:20:00.000Z"; await h.engine().timers(); run = (await h.engine().advance(run.runId))!;
  h.now = "2030-01-04T16:00:00.000Z"; await h.engine().timers(); run = (await h.engine().advance(run.runId))!;
  assert.equal(run.state.cursor, "approve-rollover", JSON.stringify(run.state));
  const workflow = h.artifact.workflows!.find((workflow) => workflow.id === "friday-close")!;
  const messages = h.calls.filter((call) => call.capability === "communication.message.publish");
  assert.equal(messages.length, 5);
  assert.deepEqual(messages.slice(0, 4).map((call) => call.context.stepId), ["open-close-thread", "chase", "report", "retro"]);
  assert.equal(messages.every((call) => call.context.agentId === "sprint"), true);
  assert.equal(messages.every((call) => call.context.toolId === workflow.steps.find((step) => step.id === "open-close-thread")!.tool!.runtimeId), true);
  assert.equal(messages.every((call) => call.context.runId === opened.runId), true);
  assert.equal(messages.every((call) => call.context.instanceId === opened.instanceId), true);
  assert.equal(new Set(messages.map((call) => call.context.stepId)).size, 5);
  assert.equal(messages.every((call) => typeof call.context.idempotencyKey === "string" && call.context.idempotencyKey.length > 0), true);
  assert.equal(new Set(messages.map((call) => call.context.idempotencyKey)).size, 5);
  assert.equal(messages.slice(0, 4).every((call) => call.input.destination_binding === "studio-sprints"), true);
  assert.equal(Object.hasOwn(messages[0]!.input, "thread_reference"), false);
  const root = (run.state.steps["open-close-thread"]!.output as any).thread_reference;
  assert.equal(typeof root, "string");
  assert.deepEqual(messages.slice(1, 4).map((call) => call.input.thread_reference), [root, root, root]);
  const frozen = (await h.store.getArtifact(run.artifactHash))!.workflows!.find((candidate) => candidate.id === "friday-close")!;
  assert.deepEqual(frozen.templates, workflow.templates);
  const events = await h.control.listEvents(run.runId);
  const effects = events.filter((event) => event.event === "tool.effect-succeeded");
  assert.equal(effects.length, 5);
  assert.equal(effects.every((event) => (event.payload as any).manifest_hash === workflow.manifestHash), true);
  assert.equal(effects.every((event) => (event.payload as any).artifact_hash === h.artifact.artifactHash), true);
  assert.deepEqual(await h.engine().advance(run.runId), run);
  assert.deepEqual(await h.control.listEvents(run.runId), events);
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 5);
  assert.equal(h.calls.filter((call) => call.capability === "work-item.batch-update").length, 0);
});
