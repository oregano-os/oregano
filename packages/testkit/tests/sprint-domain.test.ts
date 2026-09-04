import assert from "node:assert/strict";
import { test } from "node:test";
import { sprintCloseSchedule, zonedLocalDateTimeToIso, type BusinessCalendar } from "../../domains/sprint/business-time.ts";
import type { SprintDomainDeclaration, SprintEvent, SprintParticipant, SprintState, SprintWorkItem } from "../../domains/sprint/contracts.ts";
import { decideSprintEvent } from "../../domains/sprint/decisions.ts";
import { buildSprintCloseReadModel } from "../../domains/sprint/read-models.ts";
import { initialSprintState, reduceSprintEvent } from "../../domains/sprint/reducer.ts";
import { scheduleSprintCloseTimers, scheduleSprintWeekTimers } from "../../domains/sprint/timers.ts";
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
  delivery: { shared_thread: true, channel_binding: "sprint-channel", direct_binding: "sprint-direct" },
};

const calendar: BusinessCalendar = { id: "fixture-calendar", holidays: [] };

const participants: SprintParticipant[] = [
  { participant_id: "person-a", display_name: "Alex", roles: ["owner"], communication_principal: "chat:fixture:person-a", approved_absence: false },
  { participant_id: "person-b", display_name: "Blair", roles: ["contributor"], communication_principal: "chat:fixture:person-b", approved_absence: false },
  { participant_id: "person-c", display_name: "Casey", roles: ["contributor"], communication_principal: "chat:fixture:person-c", approved_absence: true },
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
  assert.equal(close.effort_basis, "actual-hours");
  assert.equal(close.total_effort_hours, 5.5);
  assert.deepEqual(close.open_work_items.map((item) => item.work_item_id).sort(), ["item-a", "item-c"]);
});

test("unavailable or incomplete effort remains unavailable instead of becoming zero", () => {
  const state = preparedState();
  const unavailable = buildSprintCloseReadModel({
    state,
    policy: { ...policy, effort: "unavailable" },
    reportAt: "2030-02-01T17:00:00.000Z",
  });
  assert.equal(unavailable.effort_basis, "unavailable");
  assert.equal(unavailable.total_effort_hours, null);
  assert.ok(unavailable.participants.every((participant) => participant.effort_hours === null));

  const incompleteState = structuredClone(state);
  delete incompleteState.work_items["item-a"]!.actual_hours;
  const incomplete = buildSprintCloseReadModel({ state: incompleteState, policy, reportAt: "2030-02-01T17:00:00.000Z" });
  assert.equal(incomplete.participants.find((participant) => participant.participant_id === "person-a")?.effort_hours, null);
  assert.equal(incomplete.total_effort_hours, null);

  const planned = buildSprintCloseReadModel({
    state: {
      ...state,
      work_items: Object.fromEntries(Object.entries(state.work_items).map(([id, item]) => [id, { ...item, planned_effort: item.actual_hours }])),
    },
    policy: { ...policy, effort: "planned-effort" },
    reportAt: "2030-02-01T17:00:00.000Z",
  });
  assert.equal(planned.effort_basis, "planned-effort");
  assert.equal(planned.total_effort_hours, 5.5);
});

test("clock decisions emit reminders, one close report, and one frozen all-open rollover proposal", () => {
  let state = preparedState();
  const reminder = decideSprintEvent({ state, policy, calendar, event: { type: "clock.reached", event_id: "clock-reminder", occurred_at: "2030-02-01T14:00:00.000Z", instant: "2030-02-01T14:00:00.000Z" } });
  assert.deepEqual(reminder.intents.map((intent) => intent.type), ["message.close-reminder"]);
  const reminderIntent = reminder.intents[0]!;
  assert.equal(reminderIntent.type === "message.close-reminder" && reminderIntent.channel_binding, "sprint-channel");
  const deliveredReminder = decideSprintEvent({
    state: reminder.state,
    policy,
    calendar,
    event: {
      type: "message.delivered",
      event_id: "delivered-reminder",
      occurred_at: "2030-02-01T14:00:01.000Z",
      intent_id: reminderIntent.intent_id,
      purpose: "close-reminder",
      destination_binding: "sprint-channel",
      message_id: "message-root",
      thread_reference: "chat:channel:thread-root",
    },
  });
  state = deliveredReminder.state;

  const chase = decideSprintEvent({ state, policy, calendar, event: { type: "clock.reached", event_id: "clock-chase", occurred_at: "2030-02-01T16:15:00.000Z", instant: "2030-02-01T16:15:00.000Z" } });
  assert.equal(chase.intents[0]?.type, "message.close-chase");
  assert.equal(chase.intents[0]?.type === "message.close-chase" && chase.intents[0].thread_reference, "chat:channel:thread-root");
  assert.deepEqual(chase.intents[0]?.type === "message.close-chase" && chase.intents[0].participant_states, { "person-b": "needs-reformat" });
  state = chase.state;

  const report = decideSprintEvent({ state, policy, calendar, event: { type: "clock.reached", event_id: "clock-report", occurred_at: "2030-02-01T17:00:00.000Z", instant: "2030-02-01T17:00:00.000Z", next_sprint_id: "sprint-6" } });
  assert.deepEqual(report.intents.map((intent) => intent.type), ["message.close-report"]);
  assert.equal(report.state.phase, "reporting");
  const duplicate = decideSprintEvent({ state: report.state, policy, calendar, event: { type: "clock.reached", event_id: "clock-report", occurred_at: "2030-02-01T17:00:00.000Z", instant: "2030-02-01T17:00:00.000Z", next_sprint_id: "sprint-6" } });
  assert.deepEqual(duplicate.intents, []);

  const reportIntent = report.intents[0]!;
  const deliveredReport = decideSprintEvent({ state: report.state, policy, calendar, event: {
    type: "message.delivered", event_id: "delivered-report", occurred_at: "2030-02-01T17:00:01.000Z",
    intent_id: reportIntent.intent_id, purpose: "close-report", destination_binding: "sprint-channel",
    message_id: "message-report", thread_reference: "chat:channel:thread-root",
  } });
  assert.deepEqual(deliveredReport.intents.map((intent) => intent.type), ["message.retro"]);
  const retroIntent = deliveredReport.intents[0]!;
  const deliveredRetro = decideSprintEvent({ state: deliveredReport.state, policy, calendar, event: {
    type: "message.delivered", event_id: "delivered-retro", occurred_at: "2030-02-01T17:00:02.000Z",
    intent_id: retroIntent.intent_id, purpose: "retro", destination_binding: "sprint-channel",
    message_id: "message-retro", thread_reference: "chat:channel:thread-root",
  } });
  const rollover = deliveredRetro.intents.find((intent) => intent.type === "work-item.rollover-proposal");
  assert.ok(rollover && rollover.type === "work-item.rollover-proposal");
  assert.deepEqual(rollover.items, [
    { work_item_id: "item-a", expected_version: "v1" },
    { work_item_id: "item-c", expected_version: "v1" },
  ]);
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
  assert.deepEqual(claimed.map((timer) => (timer.payload as Record<string, unknown>).moment), ["reminder", "chase"]);
  assert.equal(await timers.complete(claimed[0], { delivered: true }, "2030-02-01T16:00:01.000Z"), true);
  assert.equal(await timers.complete(claimed[0], { delivered: true }, "2030-02-01T16:00:02.000Z"), false);
  const reclaimed = await timers.claimDue({ now: "2030-02-01T16:06:00.000Z", owner: "worker-2", leaseToken: "lease-2", leaseExpiresAt: "2030-02-01T16:10:00.000Z" });
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].attempts, 2);
});

test("weekly Sprint triggers schedule the Monday handoff and every weekday digest exactly once", async () => {
  const store = new InMemoryDurableTimerStore();
  const timers = new DurableTimerService({ store, instanceId: "fixture-instance" });
  const weeklyPolicy: SprintDomainDeclaration = {
    ...policy,
    weekly: { monday_handoff_trigger: "monday-handoff", weekday_digest_trigger: "weekday-digest", readiness_weekday: "wednesday" },
  };
  const triggers = [
    { id: "monday-handoff", weekdays: ["monday" as const], at: "09:30", holidayShift: "previous-business-day" as const },
    { id: "weekday-digest", weekdays: ["monday" as const, "tuesday" as const, "wednesday" as const, "thursday" as const, "friday" as const], at: "17:30", holidayShift: "previous-business-day" as const },
  ];
  const first = await scheduleSprintWeekTimers({ timers, policy: weeklyPolicy, calendar, sprintId: "sprint-5", periodStart: "2030-01-28", periodEnd: "2030-02-01", triggers, scheduleVersion: "schedule-v1" });
  const replay = await scheduleSprintWeekTimers({ timers, policy: weeklyPolicy, calendar, sprintId: "sprint-5", periodStart: "2030-01-28", periodEnd: "2030-02-01", triggers, scheduleVersion: "schedule-v1" });
  assert.deepEqual(first, { scheduled: 6, existing: 0 });
  assert.deepEqual(replay, { scheduled: 0, existing: 6 });
  assert.deepEqual([...store.rows.values()].map((timer) => (timer.payload as any).trigger_id).sort(), [
    "monday-handoff", "weekday-digest", "weekday-digest", "weekday-digest", "weekday-digest", "weekday-digest",
  ]);
});

test("weekly decisions reconcile Monday facts and ask at most one focused Wednesday question per participant", () => {
  const weeklyPolicy: SprintDomainDeclaration = {
    ...policy,
    work_items: {
      ...policy.work_items,
      planning_group: "backlog",
      planned_status: "working",
      required_fields: ["brief"],
    },
    weekly: { monday_handoff_trigger: "monday-handoff", weekday_digest_trigger: "weekday-digest", readiness_weekday: "wednesday" },
  };
  let state = preparedState();
  state.work_items["item-e"] = { work_item_id: "item-e", title: "Ready candidate", assignee_ids: ["person-b"], group: "backlog", status: "working", provider_version: "v1", fields: { brief: "Complete" } };
  state.work_items["item-f"] = { work_item_id: "item-f", title: "Invalidated candidate", assignee_ids: ["person-a"], group: "backlog", status: "ready", provider_version: "v2", fields: {} };
  state = apply(state, {
    type: "carry-forward.observed",
    event_id: "carry-forward",
    occurred_at: "2030-01-28T09:03:00.000Z",
    plans: { "person-a": { goal: "Ship", measurable_outcome: "One", tasks: [{ title: "Alpha", work_item_id: "item-a" }] } },
  });
  const monday = decideSprintEvent({
    state,
    policy: weeklyPolicy,
    calendar,
    event: { type: "clock.reached", event_id: "monday", occurred_at: "2030-01-28T09:30:00.000Z", instant: "2030-01-28T09:30:00.000Z", trigger_id: "monday-handoff" },
  });
  const handoff = monday.intents[0];
  assert.ok(handoff?.type === "message.monday-handoff");
  assert.deepEqual(handoff.committed_work_item_ids, ["item-a", "item-b", "item-c"]);
  assert.deepEqual(handoff.disagreements, ["committed-not-proposed:item-b", "committed-not-proposed:item-c"]);

  const wednesday = decideSprintEvent({
    state: monday.state,
    policy: weeklyPolicy,
    calendar,
    event: { type: "clock.reached", event_id: "wednesday", occurred_at: "2030-01-30T17:30:00.000Z", instant: "2030-01-30T17:30:00.000Z", trigger_id: "weekday-digest" },
  });
  assert.deepEqual(wednesday.intents.map((intent) => intent.type), [
    "message.weekday-digest",
    "message.direct-question",
    "work-item.readiness-update",
    "work-item.readiness-update",
  ]);
  const question = wednesday.intents.find((intent) => intent.type === "message.direct-question");
  assert.ok(question?.type === "message.direct-question");
  assert.equal(question.participant_id, "person-a");
  assert.equal(question.work_item_id, "item-d");
  assert.deepEqual(question.missing_fields, ["brief"]);
  assert.deepEqual(wednesday.intents.filter((intent) => intent.type === "work-item.readiness-update"), [
    {
      type: "work-item.readiness-update",
      intent_id: (wednesday.intents[2] as any).intent_id,
      work_item_id: "item-e",
      expected_version: "v1",
      target_status: "ready",
      reason: "ready",
    },
    {
      type: "work-item.readiness-update",
      intent_id: (wednesday.intents[3] as any).intent_id,
      work_item_id: "item-f",
      expected_version: "v2",
      target_status: "working",
      reason: "invalidated",
    },
  ]);
});
