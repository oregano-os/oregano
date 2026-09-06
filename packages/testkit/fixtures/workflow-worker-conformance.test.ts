import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { engineFixture, ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";

test("persisted workflow waits deduplicate scheduling and fence completion, reclaim and explicit retry", async () => {
  const h = engineFixture(), runs = [];
  for (let index = 0; index < 2; index++) {
    const opening = { workflowId: "friday-close", requestId: randomUUID(), principal: ENGINE_OPERATOR,
      fields: { sprint_id: "test-period", next_sprint_id: "following-period" } };
    const opened = await h.engine().openOperator(opening);
    const waiting = (await h.engine().advance(opened.runId))!;
    assert.equal(waiting.state.cursor, "await-chase");
    assert.deepEqual(await h.engine().openOperator(opening), waiting);
    runs.push(waiting);
  }
  const before = await h.timers.list("workflow");
  assert.equal(before.length, 2);
  for (const run of runs) await h.engine().advance(run.runId);
  assert.deepEqual(await h.timers.list("workflow"), before);
  h.now = "2030-01-04T15:20:00.000Z";
  const claimed = await h.timers.claimDue({ timerKind: "workflow", now: h.now, owner: "first-worker", leaseToken: randomUUID(), leaseExpiresAt: "2030-01-04T15:21:00.000Z" });
  assert.equal(claimed.length, 2);
  assert.deepEqual(claimed.map((timer) => timer.payload as Record<string, string>).sort((a, b) => a.run_id!.localeCompare(b.run_id!)), runs.map((run) => ({ run_id: run.runId, workflow_id: "friday-close", step_id: "await-chase", kind: "step", instant: h.now, artifact_hash: run.artifactHash })).sort((a, b) => a.run_id.localeCompare(b.run_id)));
  assert.equal(await h.engine().wake(claimed[0]!), true);
  assert.equal(await h.engine().wake(claimed[0]!), false);
  h.now = "2030-01-04T15:22:00.000Z";
  const reclaimed = await h.timers.claimDue({ timerKind: "workflow", now: h.now, owner: "replacement-worker", leaseToken: randomUUID(), leaseExpiresAt: "2030-01-04T15:23:00.000Z" });
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0]!.timerId, claimed[1]!.timerId);
  assert.equal(reclaimed[0]!.attempts, 2);
  assert.equal(await h.engine().wake(claimed[1]!), false);
  assert.equal(await h.timers.retry(reclaimed[0]!, "2030-01-04T15:24:00.000Z", { reason: "synthetic-worker-retry" }), true);
  assert.equal(await h.timers.retry(claimed[1]!, "2030-01-04T15:22:30.000Z", { reason: "stale-worker" }), false);
  const claimRetry = () => h.timers.claimDue({ timerKind: "workflow", now: h.now, owner: "retry-worker", leaseToken: randomUUID(), leaseExpiresAt: "2030-01-04T15:25:00.000Z" });
  h.now = "2030-01-04T15:23:00.000Z";
  assert.deepEqual(await claimRetry(), []);
  h.now = "2030-01-04T15:24:00.000Z";
  const retried = await claimRetry();
  assert.equal(retried.length, 1);
  assert.equal(retried[0]!.attempts, 3);
  assert.equal(await h.engine().wake(retried[0]!), true);
  for (const run of runs) assert.equal((await h.engine().advance(run.runId))!.state.cursor, "await-report");
  const after = await h.timers.list("workflow");
  assert.equal(after.filter((timer) => timer.state === "completed").length, 2);
  assert.equal(after.filter((timer) => timer.state === "scheduled").length, 2);
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 4);
});

test("competing ordinary workers preserve every completed input and publish the handoff once", async () => {
  const h = engineFixture();
  const opened = await h.engine().openOperator({ workflowId: "monday-handoff", requestId: randomUUID(), principal: ENGINE_OPERATOR,
    fields: { period_start: "2030-01-07", period_end: "2030-01-11" } });
  await Promise.all(Array.from({ length: 4 }, () => h.engine().advance(opened.runId)));
  const run = (await h.engine().advance(opened.runId))!;
  assert.equal(run.state.status, "done");
  assert.deepEqual(Object.entries(run.state.steps).map(([id, step]) => [id, step.status]), [
    ["directory", "succeeded"], ["participant-roles", "succeeded"], ["participants", "succeeded"],
    ["current-items", "succeeded"], ["handoff-view", "succeeded"], ["post-handoff", "succeeded"],
  ]);
  assert.equal((run.state.steps["handoff-view"]!.output as any).unique_work_item_count, 1);
  const events = await h.control.listEvents(run.runId);
  assert.deepEqual(events.filter((event) => event.event === "workflow.step-completed").map((event) => event.step_id ?? event.stepId), Object.keys(run.state.steps));
  assert.equal(events.filter((event) => event.event === "workflow.opened").length, 1);
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 1);
  await Promise.all([h.engine().advance(run.runId), h.engine().advance(run.runId)]);
  assert.deepEqual(await h.store.read(run.instanceId, run.runId), run);
  assert.deepEqual(await h.control.listEvents(run.runId), events);
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 1);
});

test("a report without its required receipt blocks retro and decision even after operator resume", async () => {
  const h = engineFixture();
  const opened = await h.engine().openOperator({ workflowId: "friday-close", requestId: randomUUID(), principal: ENGINE_OPERATOR,
    fields: { sprint_id: "test-period", next_sprint_id: "following-period" } });
  await h.engine().advance(opened.runId);
  h.now = "2030-01-04T15:20:00.000Z"; await h.engine().timers(); await h.engine().advance(opened.runId);
  h.missingThread = true;
  h.now = "2030-01-04T16:00:00.000Z"; await h.engine().timers();
  const blocked = (await h.engine().advance(opened.runId))!;
  assert.equal(blocked.state.cursor, "report");
  assert.ok(blocked.state.blocked);
  assert.equal(blocked.state.steps.retro, undefined);
  assert.deepEqual(blocked.state.decisions, {});
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 3);
  const events = await h.control.listEvents(opened.runId);
  assert.equal(events.some((event) => event.event === "workflow.step-completed" && (event.step_id ?? event.stepId) === "report"), false);
  h.missingThread = false;
  await h.engine().resume(opened.runId, ENGINE_OPERATOR);
  const resumed = (await h.engine().advance(opened.runId))!;
  assert.equal(resumed.state.cursor, "report");
  assert.ok(resumed.state.blocked);
  assert.equal(resumed.state.steps.retro, undefined);
  assert.deepEqual(resumed.state.decisions, {});
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 3);
  assert.equal(h.calls.filter((call) => call.capability === "work-item.batch-update").length, 0);
});
