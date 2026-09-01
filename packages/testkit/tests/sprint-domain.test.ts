import assert from "node:assert/strict";
import { test } from "node:test";
import { sprintCloseSchedule, zonedLocalDateTimeToIso, type BusinessCalendar } from "../../domains/sprint/business-time.ts";
import type { SprintDomainDeclaration, SprintEvent, SprintParticipant, SprintState, SprintWorkItem } from "../../domains/sprint/contracts.ts";
import { decideSprintEvent } from "../../domains/sprint/decisions.ts";
import { buildSprintCloseReadModel } from "../../domains/sprint/read-models.ts";
import { initialSprintState, reduceSprintEvent } from "../../domains/sprint/reducer.ts";
import { scheduleSprintCloseTimers } from "../../domains/sprint/timers.ts";
import { DurableTimerService } from "../../runtime/durable-timers.ts";
import { InMemoryDurableTimerStore } from "../../runtime/memory-durable-timers.ts";

const policy: SprintDomainDeclaration = {
  schema_version: 1,
  id: "weekly-delivery",
  participants: { projection: "participants", absence_policy: "exclude-approved" },
  work_items: { projection: "sprint-items", master_group: "current", ready_status: "ready", closed_statuses: ["done"] },
  calendar: { timezone: "UTC", business_calendar_ref: "fixture-calendar", holiday_shift: "previous-business-day" },
  close: { weekday: "friday", reminder_time: "14:00", complete_by: "16:00", report_at: "17:00" },
  submission: { task_line_rule: "one-per-committed-task", after_report: "provider-only" },
  effort: "actual-hours",
  rollover: { eligible: "all-open" },
  delivery: { shared_thread: true, channel_binding: "sprint-channel" },
};

const calendar: BusinessCalendar = { id: "fixture-calendar", holidays: [] };

const participants: SprintParticipant[] = [
  { participant_id: "person-a", display_name: "Alex", roles: ["owner"], approved_absence: false },
  { participant_id: "person-b", display_name: "Blair", roles: ["contributor"], approved_absence: false },
  { participant_id: "person-c", display_name: "Casey", roles: ["contributor"], approved_absence: true },
];

const workItems: SprintWorkItem[] = [
  { work_item_id: "item-a", title: "Alpha", assignee_ids: ["person-a"], group: "current", status: "working", actual_hours: 3.5, provider_version: "v1", fields: {} },
  { work_item_id: "item-b", title: "Beta", assignee_ids: ["person-b"], group: "current", status: "done", actual_hours: 2, provider_version: "v1", fields: {} },
  { work_item_id: "item-c", title: "Gamma", assignee_ids: ["person-c"], group: "current", status: "working", actual_hours: 8, provider_version: "v1", fields: {} },
  { work_item_id: "item-d", title: "Delta", assignee_ids: ["person-a"], group: "backlog", status: "working", actual_hours: 5, provider_version: "v1", fields: {} },
];

const apply = (state: SprintState, event: SprintEvent): SprintState => reduceSprintEvent(state, event);

const preparedState = (): SprintState => {
  let state = apply(initialSprintState(), { type: "sprint.opened", event_id: "open", occurred_at: "2030-01-28T09:00:00.000Z", sprint_id: "sprint-5", period_start: "2030-01-28", period_end: "2030-02-01" });
  state = apply(state, { type: "participants.observed", event_id: "people", occurred_at: "2030-01-28T09:01:00.000Z", participants });
  state = apply(state, { type: "work-items.observed", event_id: "items", occurred_at: "2030-01-28T09:02:00.000Z", work_items: workItems });
  state = apply(state, { type: "submission.received", event_id: "submit-a", occurred_at: "2030-02-01T16:30:00.000Z", participant_id: "person-a", submission_id: "submission-a", task_ids: ["item-a"], complete: true });
  state = apply(state, { type: "submission.received", event_id: "submit-b", occurred_at: "2030-02-01T16:10:00.000Z", participant_id: "person-b", submission_id: "submission-b", task_ids: [], complete: false });
  return state;
};

test("business time shifts a holiday Friday to the previous business day", () => {
  const shifted = sprintCloseSchedule({ policy, periodEnd: "2030-02-01", calendar: { ...calendar, holidays: ["2030-02-01"] } });
  assert.equal(shifted.local_date, "2030-01-31");
  assert.equal(shifted.report_at, "2030-01-31T17:00:00.000Z");
  assert.equal(zonedLocalDateTimeToIso("2030-07-01", "09:30", "Europe/Berlin"), "2030-07-01T07:30:00.000Z");
});

test("the reducer is deterministic and suppresses duplicate events", () => {
  const open: SprintEvent = { type: "sprint.opened", event_id: "open", occurred_at: "2030-01-28T09:00:00.000Z", sprint_id: "sprint-5", period_start: "2030-01-28", period_end: "2030-02-01" };
  const first = apply(initialSprintState(), open);
  assert.deepEqual(apply(first, open), first);
});

test("the close read model includes submissions through report time and excludes approved absence", () => {
  const close = buildSprintCloseReadModel({ state: preparedState(), policy, reportAt: "2030-02-01T17:00:00.000Z" });
  assert.deepEqual(Object.fromEntries(close.participants.map((person) => [person.participant_id, person.close_state])), {
    "person-a": "complete",
    "person-b": "needs-reformat",
    "person-c": "complete",
  });
  assert.equal(close.participants.find((person) => person.participant_id === "person-c")?.included, false);
  assert.equal(close.total_actual_hours, 5.5);
  assert.deepEqual(close.open_work_items.map((item) => item.work_item_id).sort(), ["item-a", "item-c"]);
});

test("clock decisions emit reminders, one close report, and all-open rollover intents", () => {
  let state = preparedState();
  const reminder = decideSprintEvent({ state, policy, calendar, event: { type: "clock.reached", event_id: "clock-reminder", occurred_at: "2030-02-01T14:00:00.000Z", instant: "2030-02-01T14:00:00.000Z" } });
  assert.deepEqual(reminder.intents.filter((intent) => intent.type === "message.reminder").map((intent) => intent.participant_id), ["person-b"]);
  assert.equal(reminder.intents[0].type === "message.reminder" && reminder.intents[0].reason, "initial");
  state = reminder.state;

  const deadline = decideSprintEvent({ state, policy, calendar, event: { type: "clock.reached", event_id: "clock-deadline", occurred_at: "2030-02-01T16:00:00.000Z", instant: "2030-02-01T16:00:00.000Z" } });
  assert.equal(deadline.intents[0].type === "message.reminder" && deadline.intents[0].reason, "deadline");
  state = deadline.state;

  const report = decideSprintEvent({ state, policy, calendar, event: { type: "clock.reached", event_id: "clock-report", occurred_at: "2030-02-01T17:00:00.000Z", instant: "2030-02-01T17:00:00.000Z", next_sprint_id: "sprint-6" } });
  assert.equal(report.intents.filter((intent) => intent.type === "message.close-report").length, 1);
  assert.deepEqual(report.intents.filter((intent) => intent.type === "work-item.rollover").map((intent) => intent.work_item_id).sort(), ["item-a", "item-c"]);
  assert.equal(report.state.phase, "reporting");
  const duplicate = decideSprintEvent({ state: report.state, policy, calendar, event: { type: "clock.reached", event_id: "clock-report", occurred_at: "2030-02-01T17:00:00.000Z", instant: "2030-02-01T17:00:00.000Z", next_sprint_id: "sprint-6" } });
  assert.deepEqual(duplicate.intents, []);
});

test("a submission after report time does not change the close overview", () => {
  const state = apply(preparedState(), { type: "submission.received", event_id: "late-b", occurred_at: "2030-02-01T17:01:00.000Z", participant_id: "person-b", submission_id: "late-submission", task_ids: ["item-b"], complete: true });
  const close = buildSprintCloseReadModel({ state, policy, reportAt: "2030-02-01T17:00:00.000Z" });
  assert.equal(close.participants.find((person) => person.participant_id === "person-b")?.close_state, "needs-reformat");
});

test("Sprint cadence is persisted as idempotent durable timers and claimed without sleeping", async () => {
  const store = new InMemoryDurableTimerStore();
  const timers = new DurableTimerService({ store, instanceId: "fixture-instance" });
  const first = await scheduleSprintCloseTimers({ timers, policy, calendar, sprintId: "sprint-5", periodEnd: "2030-02-01", nextSprintId: "sprint-6" });
  const second = await scheduleSprintCloseTimers({ timers, policy, calendar, sprintId: "sprint-5", periodEnd: "2030-02-01", nextSprintId: "sprint-6" });
  assert.deepEqual(first, { scheduled: 3, existing: 0 });
  assert.deepEqual(second, { scheduled: 0, existing: 3 });
  const claimed = await timers.claimDue({ now: "2030-02-01T16:00:00.000Z", owner: "worker-1", leaseToken: "lease-1", leaseExpiresAt: "2030-02-01T16:05:00.000Z" });
  assert.equal(claimed.length, 2);
  assert.deepEqual(claimed.map((timer) => (timer.payload as Record<string, unknown>).moment), ["reminder", "complete-by"]);
  assert.equal(await timers.complete(claimed[0], { delivered: true }, "2030-02-01T16:00:01.000Z"), true);
  assert.equal(await timers.complete(claimed[0], { delivered: true }, "2030-02-01T16:00:02.000Z"), false);
  const reclaimed = await timers.claimDue({ now: "2030-02-01T16:06:00.000Z", owner: "worker-2", leaseToken: "lease-2", leaseExpiresAt: "2030-02-01T16:10:00.000Z" });
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].attempts, 2);
});
