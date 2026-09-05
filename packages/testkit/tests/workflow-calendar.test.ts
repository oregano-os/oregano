import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import type { WorkflowSchedule } from "../../companyos-builder/workflow-types.ts";
import { workflowBusinessDeadline, workflowDeliveryInstant, workflowNextTrigger, workflowOccurrences } from "../../runtime/workflow-engine/calendar.ts";
import { InMemoryDurableTimerStore } from "../../runtime/memory-durable-timers.ts";

const calendar = (): WorkflowSchedule => YAML.parse(readFileSync(resolve(import.meta.dirname, "../fixtures/lindenhof-studio/schedules/sprint-rhythm.yaml"), "utf8"));

test("holiday shifts preserve the reviewed trigger parameters and all three same-day waits", () => {
  const schedule = calendar();
  const rows = workflowOccurrences(schedule, { fromDate: "2026-04-03", toDate: "2026-04-03" }).filter((row) => row.triggerId.startsWith("friday-close"));
  assert.deepEqual(rows.map((row) => [row.triggerId, row.nominalDate, row.localDate, row.instant]), [
    ["friday-close-reminder", "2026-04-03", "2026-04-02", "2026-04-02T13:30:00.000Z"],
    ["friday-close-chase", "2026-04-03", "2026-04-02", "2026-04-02T14:20:00.000Z"],
    ["friday-close-finalize", "2026-04-03", "2026-04-02", "2026-04-02T15:00:00.000Z"],
  ]);
  const chase = workflowNextTrigger(schedule, "friday-close-chase", rows[0]!.instant);
  assert.equal(chase.instant, rows[1]!.instant);
  assert.equal(workflowNextTrigger(schedule, "friday-close-finalize", chase.instant).instant, rows[2]!.instant);
  assert.equal(schedule.activation, "blocked", "calendar evaluation never activates a schedule");
});

test("business-day expiry preserves wall time, seconds and milliseconds across daylight saving", () => {
  const schedule = calendar();
  assert.equal(workflowBusinessDeadline(schedule, "2026-03-27T13:30:24.123Z", 2), "2026-03-31T12:30:24.123Z");
  assert.equal(workflowBusinessDeadline(schedule, "2026-10-23T12:30:24.123Z", 2), "2026-10-27T13:30:24.123Z");
  assert.equal(workflowBusinessDeadline(schedule, "2026-04-02T13:00:00.000Z", 2), "2026-04-08T13:00:00.000Z");
});

test("delivery window includes opening, excludes closing and skips weekends and holidays", () => {
  const schedule = calendar();
  assert.equal(workflowDeliveryInstant(schedule, "2026-04-02T06:00:00.000Z"), "2026-04-02T06:00:00.000Z");
  assert.equal(workflowDeliveryInstant(schedule, "2026-04-02T05:30:00.000Z"), "2026-04-02T06:00:00.000Z");
  assert.equal(workflowDeliveryInstant(schedule, "2026-04-02T17:00:00.000Z"), "2026-04-07T06:00:00.000Z");
  assert.equal(workflowDeliveryInstant(schedule, "2026-04-05T10:00:00.000Z"), "2026-04-07T06:00:00.000Z");
});

test("a trigger shifted forward from a previous holiday is still found on the next business day", () => {
  const schedule = calendar();
  schedule.triggers = [{ id: "review", weekdays: ["friday"], at: "12:00", holiday_shift: "next-business-day" }];
  assert.equal(workflowNextTrigger(schedule, "review", "2026-04-07T08:00:00.000Z").instant, "2026-04-07T10:00:00.000Z");
});

test("opaque trigger variants are frozen without business interpretation", () => {
  const schedule = calendar();
  const rows = workflowOccurrences(schedule, { fromDate: "2026-09-07", toDate: "2026-09-11", triggerId: "weekday-activity-digest" });
  assert.deepEqual(rows.map((row) => row.params), [{ readiness: false }, { readiness: false }, { readiness: true }, { readiness: false }, { readiness: false }]);
  rows[0]!.params.readiness = true;
  assert.equal(schedule.triggers.find((trigger) => trigger.id === "weekday-activity-digest")!.params!.readiness, false);
});

test("missing calendar years and conflicting shifted triggers fail instead of guessing", () => {
  const schedule = calendar(); schedule.holiday_calendar.missing_year_policy = "block";
  assert.throws(() => workflowBusinessDeadline(schedule, "2026-12-31T12:00:00.000Z", 2), /no reviewed holidays for 2027/);
  schedule.triggers = [
    { id: "review", weekdays: ["friday"], at: "12:00", holiday_shift: "previous-business-day", params: { choice: "first" } },
    { id: "review", weekdays: ["thursday"], at: "12:00", params: { choice: "second" } },
  ];
  assert.throws(() => workflowOccurrences(schedule, { fromDate: "2026-04-02", toDate: "2026-04-03" }), /Colliding/);
  assert.throws(() => workflowNextTrigger(schedule, "absent", "2026-04-02T12:00:00.000Z"), /absent/);
  assert.throws(() => workflowBusinessDeadline(schedule, "2026-04-02T12:00:00.000Z", 0), /integer/);
});

test("equivalent converging triggers produce one occurrence; nonexistent local time is rejected", () => {
  const schedule = calendar();
  schedule.triggers = [{ id: "review", weekdays: ["thursday", "friday"], at: "12:00", holiday_shift: "previous-business-day", params: { value: 1 } }];
  assert.equal(workflowOccurrences(schedule, { fromDate: "2026-04-02", toDate: "2026-04-03" }).length, 1);
  schedule.business_days = ["sunday"];
  schedule.triggers = [{ id: "review", weekdays: ["sunday"], at: "02:30" }];
  assert.throws(() => workflowOccurrences(schedule, { fromDate: "2026-03-29", toDate: "2026-03-29" }), /does not exist/);
});

test("memory durable timer identity matches JSONB ordering rules and rejects changed kind or values", async () => {
  const store = new InMemoryDurableTimerStore();
  const timer = { instanceId: "test", timerId: "one", timerKind: "workflow.wait", dueAt: "2026-09-07T12:00:00.000Z", idempotencyKey: "one", payload: { first: 1, second: { a: 2, b: 3 } } };
  assert.equal(await store.schedule(timer), true);
  assert.equal(await store.schedule({ ...timer, payload: { second: { b: 3, a: 2 }, first: 1 } }), false);
  await assert.rejects(store.schedule({ ...timer, timerKind: "other" }), /conflicts/);
  await assert.rejects(store.schedule({ ...timer, payload: { first: 2, second: { a: 2, b: 3 } } }), /conflicts/);
});


test("a later nominal weekend trigger can shift to an earlier time on the same business day", () => {
  const schedule = calendar();
  schedule.triggers = [
    { id: "review", weekdays: ["friday"], at: "12:00" },
    { id: "review", weekdays: ["saturday"], at: "09:00", holiday_shift: "previous-business-day" },
  ];
  assert.equal(workflowNextTrigger(schedule, "review", "2026-09-10T06:00:00.000Z").instant, "2026-09-11T07:00:00.000Z");
});
