import assert from "node:assert/strict";
import { test } from "node:test";
import type { SprintDomainDeclaration } from "../../domains/sprint/contracts.ts";
import type { RecordProjectionRow } from "../../records/contracts.ts";
import { DurableTimerService } from "../../runtime/durable-timers.ts";
import { InMemoryDurableTimerStore } from "../../runtime/memory-durable-timers.ts";
import { InMemorySprintOrchestrationStore } from "../../runtime/memory-sprint-orchestration.ts";
import { runSprintReplayInMemory, SprintReplayService } from "../../runtime/sprint-replay.ts";

const policy: SprintDomainDeclaration = {
  schema_version: 1,
  id: "weekly-delivery",
  participants: { projection: "participants", absence_policy: "exclude-approved" },
  work_items: { projection: "sprint-items", master_group: "current", ready_status: "ready", closed_statuses: ["done"] },
  calendar: { timezone: "UTC", business_calendar_ref: "fixture-calendar", holiday_shift: "previous-business-day" },
  close: { weekday: "friday", reminder_time: "14:00", complete_by: "16:00", chase_time: "16:20", report_at: "17:00" },
  submission: { task_line_rule: "one-per-committed-task", after_report: "provider-only" },
  effort: "actual-hours",
  rollover: { eligible: "all-open" },
  delivery: { shared_thread: true, channel_binding: "live-sprint-channel" },
};

const row = (args: { id: string; at: string; author: string; text: string }): RecordProjectionRow => ({
  instance_id: "fixture-instance",
  projection_id: "conversation-messages",
  record_id: args.id,
  record_type: "communication-message",
  source_version_id: `version-${args.id}`,
  projected_at: "2030-02-01T00:00:00.000Z",
  values: {
    message_id: args.id,
    team_id: "T11111",
    occurred_at: args.at,
    author_id: args.author,
    thread_id: args.id,
    text: args.text,
  },
});

const complete = `MY FRIDAY SPRINT UPDATE — Alex, week of 2030-01-04

THIS WEEK
:white_check_mark: Alpha — Done. :link: https://work.example/items/a

:thought_balloon: Biggest blocker / learning (one line): None

NEXT WEEK
:dart: Sprint goal (one weekly-sized outcome): Ship beta
:bar_chart: Measurable outcome (number/condition that proves it's done): One accepted result
Tasks (one line each):
• Beta — :link: <https://work.example/items/b|Open card>`;

const input = () => ({
  replayId: "historical-week-1",
  sprintId: "week-2030-01-04",
  periodStart: "2030-01-01",
  periodEnd: "2030-01-04",
  messageProjectionId: "conversation-messages",
  messages: [
    row({ id: "message-1", at: "2030-01-04T15:30:00.000Z", author: "U11111", text: complete }),
    row({ id: "message-2", at: "2030-01-04T15:40:00.000Z", author: "U22222", text: "MY FRIDAY SPRINT UPDATE\nTHIS WEEK\nNot in template" }),
    row({ id: "message-3", at: "2030-01-04T15:41:00.000Z", author: "U11111", text: "Ordinary conversation" }),
    row({ id: "message-4", at: "2030-01-04T18:00:00.000Z", author: "U11111", text: complete }),
  ],
  principalByProviderAuthor: {
    "T11111:U11111": "chat:fixture:person-a",
    "T11111:U22222": "chat:fixture:person-b",
  },
  snapshot: {
    participants: [
      { participant_id: "person-a", display_name: "Alex", roles: ["contributor"], communication_principal: "chat:fixture:person-a", approved_absence: false },
      { participant_id: "person-b", display_name: "Blair", roles: ["contributor"], communication_principal: "chat:fixture:person-b", approved_absence: false },
    ],
    workItems: [
      { work_item_id: "item-a", title: "Alpha", assignee_ids: ["person-a"], group: "current", status: "done", actual_hours: 2, url: "https://work.example/items/a", provider_version: "item-version-a", fields: {} },
      { work_item_id: "item-b", title: "Beta", assignee_ids: ["person-b"], group: "current", status: "working", actual_hours: 1, url: "https://work.example/items/b", provider_version: "item-version-b", fields: {} },
    ],
    observedAt: "2030-02-01T00:00:00.000Z",
    participantSourceVersion: "participants-v1",
    workItemSourceVersion: "items-v1",
  },
  policy,
  calendar: { id: "fixture-calendar", holidays: [] },
  output: {
    mode: "proof-only" as const,
    communication_binding: "test-sprint-channel",
    test_only: true as const,
    forbidden_bindings: ["live-sprint-channel", "live-sprint-board"],
  },
});

test("Sprint replay derives domain records, advances a controlled Friday Close, and records evidence limits", async () => {
  const first = await runSprintReplayInMemory("fixture-instance", input());
  const second = await runSprintReplayInMemory("fixture-instance", input());
  assert.equal(first.final_phase, "closed");
  assert.equal(first.participant_states["person-a"], "complete");
  assert.equal(first.participant_states["person-b"], "needs-reformat");
  assert.deepEqual(first.open_work_item_ids, ["item-b"]);
  assert.equal(first.total_effort_hours, 3);
  assert.equal(first.submission_records.length, 3);
  assert.equal(first.submission_records[0]?.domain, "sprint");
  assert.equal(first.submission_records[0]?.type, "submission");
  assert.deepEqual(first.submission_records[0]?.source, {
    projection_id: "conversation-messages",
    record_id: "message-1",
    source_version_id: "version-message-1",
  });
  assert.deepEqual(first.submission_records[0]?.references.map((reference) => reference.record_id), ["item-a", "item-b"]);
  assert.ok(first.ignored_messages.some((message) => message.record_id === "message-3" && message.reason === "not-sprint-update"));
  assert.ok(first.ignored_messages.some((message) => message.record_id === "message-4" && message.reason === "after-report"));
  assert.deepEqual(first.limitations, ["operational-snapshot-is-newer-than-replayed-period"]);
  assert.equal(second.output_digest, first.output_digest);
});

test("Sprint replay refuses a production output binding before processing records", async () => {
  const unsafe = input();
  unsafe.output.communication_binding = "live-sprint-channel";
  await assert.rejects(() => runSprintReplayInMemory("fixture-instance", unsafe), /forbidden production binding/);
});

test("Sprint replay is idempotent against the same durable stores", async () => {
  const store = new InMemorySprintOrchestrationStore();
  const timerStore = new InMemoryDurableTimerStore();
  const service = new SprintReplayService({
    instanceId: "fixture-instance",
    store,
    timers: new DurableTimerService({ instanceId: "fixture-instance", store: timerStore }),
  });
  const first = await service.run(input());
  const eventCount = store.events.size;
  const intentCount = store.intents.size;
  const second = await service.run(input());
  assert.equal(second.output_digest, first.output_digest);
  assert.equal(store.events.size, eventCount);
  assert.equal(store.intents.size, intentCount);
});

test("Sprint replay includes a submission at the exact report cutoff in the report intent", async () => {
  const store = new InMemorySprintOrchestrationStore();
  const service = new SprintReplayService({
    instanceId: "fixture-instance",
    store,
    timers: new DurableTimerService({ instanceId: "fixture-instance", store: new InMemoryDurableTimerStore() }),
  });
  const exactCutoff = input();
  exactCutoff.messages = [
    row({ id: "message-at-cutoff", at: "2030-01-04T17:00:00.000Z", author: "U11111", text: complete }),
  ];
  await service.run(exactCutoff);
  const report = [...store.intents.values()].find((candidate) => candidate.intent.type === "message.close-report");
  assert.ok(report && report.intent.type === "message.close-report");
  assert.equal(report.intent.participant_states["person-a"], "complete");
});
