import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import { engineArtifact, engineFixture, ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";

function scheduledFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "workflow-lifecycle-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(resolve(import.meta.dirname, "lindenhof-studio"), root, { recursive: true });
  const path = join(root, "schedules/sprint-rhythm.yaml"), calendar = YAML.parse(readFileSync(path, "utf8"));
  calendar.activation = "active";
  calendar.holiday_calendar.years["2030"] = ["2030-02-01"];
  writeFileSync(path, YAML.stringify(calendar));
  return engineFixture({ artifact: engineArtifact(undefined, root) });
}

test("a holiday-shifted opening persists both same-day close deadlines across reconstructed workers", async (t) => {
  const h = scheduledFixture(t); h.now = "2030-01-31T14:30:00.000Z";
  const opened = await h.engine().openScheduled({ workflowId: "friday-close", principal: ENGINE_OPERATOR, instant: h.now,
    fields: { sprint_id: "holiday-week", next_sprint_id: "following-week" } });
  let run = (await h.engine().advance(opened.runId))!;
  assert.equal(run.fields.run_date, "2030-01-31");
  assert.equal(run.trigger.instant, "2030-01-31T14:30:00.000Z");
  assert.equal(run.state.cursor, "await-chase");
  assert.equal(run.state.wait!.dueAt, "2030-01-31T15:20:00.000Z");
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 1);
  h.now = "2030-01-31T15:20:00.000Z"; await h.engine().timers();
  run = (await h.engine().advance(run.runId))!;
  assert.equal(run.state.cursor, "await-report");
  assert.equal(run.state.wait!.dueAt, "2030-01-31T16:00:00.000Z");
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 2);
  h.now = "2030-01-31T16:00:00.000Z"; await h.engine().timers();
  run = (await h.engine().advance(run.runId))!;
  assert.equal(run.state.cursor, "approve-rollover", JSON.stringify(run.state));
  assert.equal((run.state.steps["close-view"]!.output as any).cutoff, "2030-01-31T16:00:00.000Z");
  assert.equal(run.state.decisions["approve-rollover"]!.expiresAt, "2030-02-05T16:00:00.000Z");
  const receipts = h.calls.filter((call) => call.capability === "communication.message.publish");
  assert.equal(receipts.length, 5);
  assert.equal(h.calls.filter((call) => call.capability === "work-item.batch-update").length, 0);
});

test("a summer scheduled opening uses the declared local wall time after daylight saving", async (t) => {
  const h = scheduledFixture(t); h.now = "2030-07-01T07:30:00.000Z";
  const opened = await h.engine().openScheduled({ workflowId: "monday-handoff", principal: ENGINE_OPERATOR, instant: h.now,
    fields: { period_start: "2030-07-01", period_end: "2030-07-05" } });
  const run = (await h.engine().advance(opened.runId))!;
  assert.equal(run.state.status, "done");
  assert.equal(run.fields.run_date, "2030-07-01");
  assert.equal(run.trigger.instant, "2030-07-01T07:30:00.000Z");
});

test("the declared week opens six independent workflows and redelivery changes neither evidence nor publications", async (t) => {
  const h = scheduledFixture(t), runs = [];
  const occurrences = [
    { workflowId: "monday-handoff", instant: "2030-01-07T08:30:00.000Z", fields: { period_start: "2030-01-07", period_end: "2030-01-11" } },
    ...["07", "08", "09", "10", "11"].map((day) => ({ workflowId: "weekday-digest", instant: `2030-01-${day}T16:30:00.000Z`, fields: {} })),
  ];
  for (const occurrence of occurrences) {
    h.now = occurrence.instant;
    const opening = { ...occurrence, fields: occurrence.fields as Record<string, string>, principal: ENGINE_OPERATOR };
    const first = await h.engine().openScheduled(opening);
    const completed = (await h.engine().advance(first.runId))!;
    assert.equal(completed.state.status, "done", JSON.stringify(completed.state));
    const events = await h.control.listEvents(first.runId), count = h.calls.length;
    const duplicate = await h.engine().openScheduled(opening);
    assert.deepEqual(duplicate, completed);
    assert.deepEqual(await h.engine().advance(duplicate.runId), completed);
    assert.deepEqual(await h.control.listEvents(first.runId), events);
    assert.equal(h.calls.length, count);
    runs.push(completed);
  }
  assert.equal(new Set(runs.map((run) => run.runId)).size, 6);
  assert.deepEqual(runs.map((run) => run.workflowId), ["monday-handoff", "weekday-digest", "weekday-digest", "weekday-digest", "weekday-digest", "weekday-digest"]);
  assert.deepEqual(runs.slice(1).map((run) => run.trigger.params.readiness), [false, false, true, false, false]);
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 6);
  assert.equal(h.calls.filter((call) => call.capability === "work-item.batch-update").length, 0);
});

test("independent operator runs isolate persisted timers and retry preserves each exact run", async () => {
  const h = engineFixture(), ids: string[] = [], requests = [randomUUID(), randomUUID()];
  const open = (requestId: string) => h.engine().openOperator({ workflowId: "friday-close", requestId, principal: ENGINE_OPERATOR,
    fields: { sprint_id: "same-period", next_sprint_id: "following-period" } });
  for (const request of requests) {
    const opened = await open(request);
    const waiting = (await h.engine().advance(opened.runId))!;
    assert.equal(waiting.state.cursor, "await-chase");
    assert.deepEqual(await open(request), waiting);
    ids.push(opened.runId);
  }
  const before = await h.timerStore.list({ instanceId: h.artifact.instance.id });
  assert.notEqual(ids[0], ids[1]);
  assert.equal(before.length, 2);
  assert.equal(new Set(before.map((timer) => timer.timerId)).size, 2);
  assert.deepEqual(before.map((timer) => timer.dueAt), ["2030-01-04T15:20:00.000Z", "2030-01-04T15:20:00.000Z"]);
  for (const id of ids) await h.engine().advance(id);
  assert.deepEqual(await h.timerStore.list({ instanceId: h.artifact.instance.id }), before);
  h.now = "2030-01-04T15:20:00.000Z"; await h.engine().timers();
  for (const id of ids) assert.equal((await h.engine().advance(id))!.state.cursor, "await-report");
  const after = await h.timerStore.list({ instanceId: h.artifact.instance.id });
  assert.equal(after.filter((timer) => timer.state === "completed").length, 2);
  assert.equal(after.filter((timer) => timer.state === "scheduled").length, 2);
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 4);
});
