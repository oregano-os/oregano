import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompiledSprintRuntime } from "../../companyos-builder/types.ts";
import { InMemoryDurableTimerStore } from "../../runtime/memory-durable-timers.ts";
import { InMemorySprintOrchestrationStore } from "../../runtime/memory-sprint-orchestration.ts";
import { SprintScenarioRunner, type SprintScenarioInput } from "../../runtime/sprint-scenario-runner.ts";
import { parseSprintOperatorRequest } from "../../runner-vercel/src/lib/sprint-runtime.ts";

const compiled: CompiledSprintRuntime = {
  definitionId: "weekly-sprint",
  agentId: "sprint",
  execution: "active-capable",
  servicePrincipal: "companyos:fixture:sprint",
  participantIdentityPrefix: "slack:T1:",
  policy: {
    schema_version: 1,
    id: "weekly-sprint",
    participants: { projection: "sprint-participants", absence_policy: "exclude-approved" },
    work_items: {
      projection: "sprint-work-items",
      master_group: "current-sprint",
      planning_group: "planning",
      planned_status: "planned",
      ready_status: "ready",
      closed_statuses: ["done"],
      required_fields: ["brief", "outcome"],
    },
    calendar: { timezone: "UTC", business_calendar_ref: "fixture-calendar", holiday_shift: "previous-business-day" },
    close: { weekday: "friday", reminder_time: "14:00", complete_by: "16:00", chase_time: "16:20", report_at: "17:00" },
    submission: { task_line_rule: "one-per-committed-task", after_report: "provider-only" },
    effort: "unavailable",
    rollover: { eligible: "all-open" },
    delivery: { shared_thread: true, channel_binding: "live-sprint-channel", direct_binding: "sprint-direct" },
    weekly: { monday_handoff_trigger: "monday-handoff", weekday_digest_trigger: "weekday-digest", readiness_weekday: "wednesday" },
    model_task_profile: "sprint.coordination",
    rendering: {
      reminder: "workflows/sprint/reminder.md",
      chase: "workflows/sprint/chase.md",
      close_report: "workflows/sprint/close.md",
      retro: "workflows/sprint/retro.md",
      monday_handoff: "workflows/sprint/monday.md",
      weekday_digest: "workflows/sprint/digest.md",
      direct_question: "workflows/sprint/question.md",
    },
  },
  calendar: { id: "fixture-calendar", holidays: [] },
  schedule: {
    schemaVersion: 1,
    id: "sprint-rhythm",
    sourcePath: "schedules/sprint.yaml",
    activation: "active",
    timeZone: "UTC",
    businessDays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
    holidaysByYear: {},
    missingYearPolicy: "assume-no-holidays",
    deliveryWindow: { opensAt: "08:00", closesAt: "19:00" },
    triggers: [
      { id: "monday-handoff", weekdays: ["monday"], at: "09:00", holidayShift: "previous-business-day" },
      { id: "weekday-digest", weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"], at: "17:30", holidayShift: "previous-business-day" },
    ],
    sourceDigest: "a".repeat(64),
    provenance: { instanceId: "fixture", coreCommit: "core", workspaceCommit: "workspace", workbenchVersion: "0.1.0-test" },
  },
  templates: {
    reminder: { path: "workflows/sprint/reminder.md", content: "Update {{sprint_id}} by {{due_at}}.", digest: "1".repeat(64) },
    chase: { path: "workflows/sprint/chase.md", content: "Missing: {{missing_names}}\nReformat: {{needs_reformat_names}}", digest: "2".repeat(64) },
    closeReport: { path: "workflows/sprint/close.md", content: "Complete: {{complete_names}}\nReformat: {{needs_reformat_names}}\nMissing: {{missing_names}}", digest: "3".repeat(64) },
    retro: { path: "workflows/sprint/retro.md", content: "Open: {{open_work_item_count}}. Effort: {{total_effort_hours}}.", digest: "4".repeat(64) },
    mondayHandoff: { path: "workflows/sprint/monday.md", content: "Committed: {{committed_work_items}}\nDifferences: {{disagreements}}", digest: "5".repeat(64) },
    weekdayDigest: { path: "workflows/sprint/digest.md", content: "Daily digest\nChanged: {{changed_work_items}}\nReadiness: {{readiness_gaps}}", digest: "6".repeat(64) },
    directQuestion: { path: "workflows/sprint/question.md", content: "Hi {{participant_name}}, {{work_item_title}} needs {{missing_fields}}.", digest: "7".repeat(64) },
  },
  directDestinations: {
    "slack:T1:U1": "direct-alex",
    "slack:T1:U2": "direct-blair",
  },
  directAssignments: {
    "slack:T1:U1": { fromAgentId: "oregano", purpose: "sprint" },
    "slack:T1:U2": { fromAgentId: "oregano", purpose: "sprint" },
  },
  workItem: { resourceBinding: "live-sprint-board", rolloverField: "group", readinessField: "readiness" },
  modelTask: "sprint.coordination",
};

const input = (): SprintScenarioInput => ({
  scenarioRunId: "full-week-2030-05",
  sprintId: "sprint-2030-05",
  periodStart: "2030-01-28",
  periodEnd: "2030-02-01",
  nextSprintId: "sprint-2030-06",
  snapshot: {
    participants: [
      { participant_id: "alex", display_name: "Alex", roles: ["owner"], communication_principal: "slack:T1:U1", approved_absence: false },
      { participant_id: "blair", display_name: "Blair", roles: ["contributor"], communication_principal: "slack:T1:U2", approved_absence: false },
    ],
    workItems: [
      { work_item_id: "current-1", title: "Current work", assignee_ids: ["alex"], group: "current-sprint", status: "working", provider_version: "v1", fields: {} },
      { work_item_id: "plan-1", title: "Plan next", assignee_ids: ["blair"], group: "planning", status: "planned", provider_version: "v2", fields: { brief: "", outcome: "measurable" } },
      { work_item_id: "plan-2", title: "Ready next", assignee_ids: ["alex"], group: "planning", status: "planned", provider_version: "v3", fields: { brief: "clear", outcome: "measurable" } },
    ],
    observedAt: "2030-02-02T10:00:00.000Z",
    participantSourceVersion: "participants-v1",
    workItemSourceVersion: "work-items-v1",
  },
  submissionOutcomes: { alex: "complete", blair: "needs-reformat" },
});

test("a full-week scenario executes the real hosted lifecycle without provider effects", async () => {
  const store = new InMemorySprintOrchestrationStore();
  const timerStore = new InMemoryDurableTimerStore();
  const runner = new SprintScenarioRunner({ instanceId: "fixture", compiled, store, timerStore });
  const report = await runner.run(input());

  assert.deepEqual(report.executed_scenarios, [
    "monday-handoff",
    "weekday-digest",
    "readiness-check",
    "friday-close",
    "retro",
    "rollover-proposal",
  ]);
  assert.equal(report.mode, "proof-only");
  assert.equal(report.final_state.phase, "closed");
  assert.equal(report.final_state.submission_count, 2);
  assert.equal(report.proof_summary.event_count, report.events.length);
  assert.equal(report.proof_summary.intent_count, report.intents.length);
  assert.equal(report.proof_summary.timer_count, report.timers.length);
  assert.equal(report.proof_summary.returned_row_limit, 250);
  assert.equal(report.intents.every((intent) => intent.state === "succeeded"), true);
  assert.equal(report.timers.every((timer) => timer.state === "completed"), true);
  assert.ok(report.intents.some((intent) => intent.intent_type === "message.direct-question" && intent.active_binding === "ready"));
  assert.ok(report.intents.some((intent) => intent.intent_type === "work-item.rollover-proposal" && intent.active_binding === "requires-confirmation"));
  assert.ok(report.limitations.includes("proof-only-no-provider-effects"));
  assert.equal(report.catalog.find((entry) => entry.id === "triage")?.available, false);
  assert.equal(report.catalog.find((entry) => entry.id === "briefing")?.execution, "planned-workflow-runtime");
  assert.equal(await store.getState({ instanceId: "fixture", definitionId: compiled.definitionId }), undefined);
});

test("the same scenario identity is replay-safe and returns stable durable proof", async () => {
  const store = new InMemorySprintOrchestrationStore();
  const timerStore = new InMemoryDurableTimerStore();
  const runner = new SprintScenarioRunner({ instanceId: "fixture", compiled, store, timerStore });
  const first = await runner.run(input());
  const eventCount = store.events.size;
  const intentCount = store.intents.size;
  const timerCount = timerStore.rows.size;
  const second = await runner.run(input());

  assert.equal(second.scenario_definition_id, first.scenario_definition_id);
  assert.equal(second.output_digest, first.output_digest);
  assert.equal(store.events.size, eventCount);
  assert.equal(store.intents.size, intentCount);
  assert.equal(timerStore.rows.size, timerCount);
});

test("the operator parser exposes one bounded proof-only simulation action", () => {
  assert.deepEqual(parseSprintOperatorRequest(JSON.stringify({
    action: "simulate",
    definition_id: "weekly-sprint",
    scenario_run_id: "review-1",
    sprint_id: "sprint-1",
    period_start: "2030-01-28",
    period_end: "2030-02-01",
    next_sprint_id: "sprint-2",
    excluded_participant_ids: ["away"],
    submission_outcomes: { alex: "complete", blair: "missing" },
  })), {
    action: "simulate",
    definitionId: "weekly-sprint",
    scenarioRunId: "review-1",
    sprintId: "sprint-1",
    periodStart: "2030-01-28",
    periodEnd: "2030-02-01",
    nextSprintId: "sprint-2",
    excludedParticipantIds: ["away"],
    submissionOutcomes: { alex: "complete", blair: "missing" },
  });
  assert.throws(() => parseSprintOperatorRequest(JSON.stringify({
    action: "simulate",
    scenario_run_id: "review-1",
    sprint_id: "sprint-1",
    period_start: "2030-01-28",
    period_end: "2030-02-01",
    destination: "live-channel",
  })), /unsupported field 'destination'/);
  assert.throws(() => parseSprintOperatorRequest(JSON.stringify({
    action: "simulate",
    scenario_run_id: "review-1",
    sprint_id: "sprint-1",
    period_start: "2030-01-28",
    period_end: "2030-02-01",
    submission_outcomes: { alex: "almost" },
  })), /submission_outcomes for 'alex' is invalid/);
});

test("the catalog does not claim missing compiled readiness behavior", async () => {
  const store = new InMemorySprintOrchestrationStore();
  const timerStore = new InMemoryDurableTimerStore();
  const withoutReadiness = {
    ...compiled,
    workItem: { resourceBinding: "live-sprint-board", rolloverField: "group" },
  };
  const report = await new SprintScenarioRunner({ instanceId: "fixture", compiled: withoutReadiness, store, timerStore }).run({
    ...input(),
    scenarioRunId: "without-readiness",
  });
  assert.deepEqual(report.catalog.find((entry) => entry.id === "readiness-check"), {
    id: "readiness-check",
    execution: "deterministic-runtime",
    available: false,
    reason: "compiled-readiness-contract-is-incomplete",
  });
  assert.ok(report.intents.some((intent) => intent.intent_type === "work-item.readiness-update" && intent.active_binding === "unavailable"));
});

test("scenario input is fully validated before durable proof is written", async () => {
  const store = new InMemorySprintOrchestrationStore();
  const timerStore = new InMemoryDurableTimerStore();
  const runner = new SprintScenarioRunner({ instanceId: "fixture", compiled, store, timerStore });
  await assert.rejects(() => runner.run({
    ...input(),
    scenarioRunId: "unknown-participant",
    submissionOutcomes: { unknown: "complete" },
  }), /unknown participant 'unknown'/);
  await assert.rejects(() => runner.run({
    ...input(),
    scenarioRunId: "unbounded-period",
    periodEnd: "2030-03-01",
  }), /cannot exceed 31 calendar days/);
  assert.equal(store.events.size, 0);
  assert.equal(store.intents.size, 0);
  assert.equal(timerStore.rows.size, 0);
});
