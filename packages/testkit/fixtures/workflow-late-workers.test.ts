import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { engineFixture, ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";
import { WorkflowWorkers } from "../../runtime/workflow-engine/workers.ts";
import { parseWorkflowOperatorRequest } from "../../runner-vercel/src/lib/workflow-http.ts";

test("late workers recover the declared close order and original cutoffs without duplicate publication", async () => {
  const h = engineFixture();
  const opened = await h.engine().openOperator({ workflowId: "friday-close", requestId: randomUUID(), principal: ENGINE_OPERATOR,
    fields: { sprint_id: "late-week", next_sprint_id: "following-week" } });
  h.now = "2030-01-04T16:03:00.000Z";
  let run = (await h.engine().advance(opened.runId))!;
  assert.equal(run.state.cursor, "await-chase");
  assert.equal(run.state.wait!.dueAt, "2030-01-04T15:20:00.000Z");
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 1);
  await h.engine().timers(); run = (await h.engine().advance(run.runId))!;
  assert.equal(run.state.cursor, "await-report");
  assert.equal(run.state.wait!.dueAt, "2030-01-04T16:00:00.000Z");
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 2);
  await h.engine().timers(); run = (await h.engine().advance(run.runId))!;
  assert.equal(run.state.cursor, "approve-rollover", JSON.stringify(run.state));
  assert.equal(run.state.blocked, undefined);
  assert.equal((run.state.steps["classify-at-chase"]!.output as any).cutoff, "2030-01-04T15:20:00.000Z");
  assert.equal((run.state.steps["close-view"]!.output as any).cutoff, "2030-01-04T16:00:00.000Z");
  const messages = h.calls.filter((call) => call.capability === "communication.message.publish");
  assert.equal(messages.length, 5);
  const root = (run.state.steps["open-close-thread"]!.output as any).thread_reference;
  assert.deepEqual(messages.slice(1, 4).map((call) => call.input.thread_reference), [root, root, root]);
  const events = await h.control.listEvents(run.runId);
  const completions = events.filter((event) => event.event === "workflow.step-completed").map((event) => event.step_id ?? event.stepId);
  assert.ok(completions.indexOf("open-close-thread") < completions.indexOf("chase"));
  assert.ok(completions.indexOf("chase") < completions.indexOf("report"));
  assert.ok(completions.indexOf("report") < completions.indexOf("retro"));
  const waits = await h.timerStore.list({ instanceId: run.instanceId, timerKind: "workflow" });
  assert.equal(waits.filter((timer) => timer.state === "failed").length, 0);
  assert.equal(waits.filter((timer) => timer.state === "completed").length, 2);
  await h.engine().timers(); assert.deepEqual(await h.engine().advance(run.runId), run);
  assert.deepEqual(await h.control.listEvents(run.runId), events);
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 5);
  assert.equal(h.calls.filter((call) => call.capability === "work-item.batch-update").length, 0);
});

test("idle hosted workers succeed before any workflow has opened without provider or run effects", async () => {
  const h = engineFixture();
  const configuration = { enabledWorkflowIds: ["friday-close"], autoOpenWorkflowIds: [], schedulePrincipal: ENGINE_OPERATOR,
    activatedAt: h.now, maxLatenessMinutes: 60 };
  const worker = () => new WorkflowWorkers({ engine: h.engine(), artifact: h.artifact, store: h.store, timers: h.timers, configuration, clock: () => h.now });
  const steps = await worker().run("steps"), timers = await worker().run("timers");
  assert.equal(steps.ok, true); assert.equal(timers.ok, true);
  assert.equal(steps.processed, 0); assert.equal(timers.processed, 0);
  assert.deepEqual(await h.store.list({ instanceId: h.artifact.instance.id, limit: 200 }), []);
  assert.deepEqual(h.calls, []);
});

test("the generic operator rejects retired simulator actions while an ordinary workflow executes", async () => {
  const h = engineFixture();
  for (const action of ["replay", "publish-replay", "simulate", "publish-simulation", "publish-friday-close-simulation"]) {
    assert.throws(() => parseWorkflowOperatorRequest({ action, definition_id: "weekly-delivery", scenario_id: "fixture-week" }));
  }
  assert.deepEqual(await h.store.list({ instanceId: h.artifact.instance.id, limit: 200 }), []);
  const request = parseWorkflowOperatorRequest({ action: "open", workflowId: "monday-handoff", requestId: randomUUID(),
    fields: { period_start: "2030-01-07", period_end: "2030-01-11" } });
  if (request.action !== "open") throw new Error("Expected an ordinary opening request");
  const opened = await h.engine().openOperator({ ...request, principal: ENGINE_OPERATOR });
  const completed = (await h.engine().advance(opened.runId))!;
  assert.equal(completed.state.status, "done");
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 1);
});

test("hosted step workers leave an existing non-enabled workflow untouched", async () => {
  const h = engineFixture();
  const opened = await h.engine().openOperator({ workflowId: "monday-handoff", requestId: randomUUID(), principal: ENGINE_OPERATOR,
    fields: { period_start: "2030-01-07", period_end: "2030-01-11" } });
  const events = await h.control.listEvents(opened.runId);
  const worker = new WorkflowWorkers({ engine: h.engine(), artifact: h.artifact, store: h.store, timers: h.timers,
    configuration: { enabledWorkflowIds: ["friday-close"], autoOpenWorkflowIds: [], schedulePrincipal: ENGINE_OPERATOR, activatedAt: h.now, maxLatenessMinutes: 60 }, clock: () => h.now });
  const result = await worker.run("steps");
  assert.equal(result.ok, true); assert.equal(result.processed, 0);
  assert.deepEqual(await h.store.read(opened.instanceId, opened.runId), opened);
  assert.deepEqual(await h.control.listEvents(opened.runId), events);
  assert.deepEqual(h.calls, []);
});
