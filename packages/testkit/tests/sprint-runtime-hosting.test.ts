import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompiledSprintRuntime } from "../../companyos-builder/types.ts";
import { compileSprintRuntimes } from "../../companyos-builder/sprint-loader.ts";
import type { InstanceBuildConfiguration } from "../../companyos-builder/types.ts";
import type { LoadedWorkspace } from "../../companyos-builder/workspace-loader.ts";
import type { SprintParticipant, SprintWorkItem } from "../../domains/sprint/contracts.ts";
import { DurableTimerService } from "../../runtime/durable-timers.ts";
import { InMemoryDurableTimerStore } from "../../runtime/memory-durable-timers.ts";
import { InMemorySprintOrchestrationStore } from "../../runtime/memory-sprint-orchestration.ts";
import {
  CompiledSprintToolExecutionResolver,
  HostedSprintRuntime,
  sprintRolloverToolRequest,
} from "../../runtime/sprint-host.ts";
import { normalizeSprintSnapshot } from "../../runtime/sprint-snapshot.ts";
import { renderSprintMessageIntent } from "../../runtime/sprint-intent-renderer.ts";
import {
  assertSprintRuntimeModeCompatible,
  authorizeSprintOperator,
  authorizeSprintScheduler,
  currentSprintRuntimeMode,
  executeSprintOperator,
  parseSprintOperatorRequest,
  scheduledSprintRuntimeDefinitions,
  stabilizeSprintProjection,
} from "../../runner-vercel/src/lib/sprint-runtime.ts";

const compiled: CompiledSprintRuntime = {
  definitionId: "weekly-delivery",
  agentId: "sprint",
  execution: "active-capable",
  servicePrincipal: "companyos:fixture:sprint",
  participantIdentityPrefix: "monday:A1:",
  policy: {
    schema_version: 1,
    id: "weekly-delivery",
    participants: { projection: "participants", absence_policy: "exclude-approved", roster_group: "sprint-participant" },
    work_items: { projection: "sprint-items", master_group: "current", ready_status: "ready", closed_statuses: ["done"] },
    calendar: { timezone: "UTC", business_calendar_ref: "schedules/sprint.yaml", holiday_shift: "previous-business-day" },
    close: { weekday: "friday", reminder_time: "14:00", complete_by: "16:00", chase_time: "16:15", report_at: "17:00" },
    submission: { task_line_rule: "one-per-committed-task", after_report: "provider-only" },
    effort: "unavailable",
    rollover: { eligible: "all-open" },
    delivery: { shared_thread: true, channel_binding: "sprint-channel", direct_binding: "sprint-direct" },
    model_task_profile: "sprint.coordination",
    rendering: { reminder: "workflows/sprint/reminder.md", chase: "workflows/sprint/chase.md", close_report: "workflows/sprint/close.md", retro: "workflows/sprint/retro.md" },
  },
  calendar: { id: "schedules/sprint.yaml", holidays: [] },
  schedule: {
    schemaVersion: 1,
    id: "sprint-schedule",
    sourcePath: "schedules/sprint.yaml",
    activation: "active",
    timeZone: "UTC",
    businessDays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
    holidaysByYear: {},
    missingYearPolicy: "assume-no-holidays",
    deliveryWindow: { opensAt: "08:00", closesAt: "19:00" },
    triggers: [{ id: "friday-close", weekdays: ["friday"], at: "17:00", holidayShift: "previous-business-day" }],
    sourceDigest: "a".repeat(64),
    provenance: { instanceId: "fixture", coreCommit: "core", workspaceCommit: "workspace", workbenchVersion: "0.1.0-experimental.15" },
  },
  templates: {
    reminder: {
      path: "workflows/sprint/reminder.md",
      content: "Post your Friday update for {{sprint_id}} in this thread by {{due_at}}.",
      digest: "b".repeat(64),
    },
    chase: {
      path: "workflows/sprint/chase.md",
      content: "Please complete: {{missing_names}}. Please reformat: {{needs_reformat_names}}.",
      digest: "d".repeat(64),
    },
    closeReport: {
      path: "workflows/sprint/close.md",
      content: "Complete: {{complete_names}}\nReformat: {{needs_reformat_names}}\nMissing: {{missing_names}}",
      digest: "c".repeat(64),
    },
    retro: {
      path: "workflows/sprint/retro.md",
      content: "Open: {{open_work_item_count}}. Effort: {{total_effort_hours}}.",
      digest: "e".repeat(64),
    },
  },
  directDestinations: {
    "slack:T1:U1": "direct-alex",
    "slack:T1:U2": "direct-blair",
  },
  directAssignments: {
    "slack:T1:U1": { fromAgentId: "oregano", purpose: "sprint" },
    "slack:T1:U2": { fromAgentId: "oregano", purpose: "sprint" },
  },
  modelTask: "sprint.coordination",
};

const participants: SprintParticipant[] = [
  { participant_id: "alex", display_name: "Alex", roles: ["owner"], communication_principal: "slack:T1:U1", approved_absence: false },
  { participant_id: "blair", display_name: "Blair", roles: ["contributor"], communication_principal: "slack:T1:U2", approved_absence: false },
];

test("Sprint rendering omits company template lines whose list value is empty", () => {
  const rendered = renderSprintMessageIntent({
    intent: {
      type: "message.close-report",
      intent_id: "report-1",
      channel_binding: "sprint-channel",
      thread_reference: "thread-1",
      due_at: "2030-02-01T17:00:00.000Z",
      participant_states: { alex: "complete", blair: "missing" },
    },
    state: {
      sprint_id: "sprint-5",
      period_start: "2030-01-28",
      period_end: "2030-02-01",
      phase: "open",
      participants: Object.fromEntries(participants.map((participant) => [participant.participant_id, participant])),
      work_items: {},
      submissions: {},
      deliveries: {},
      close_thread_reference: null,
      next_sprint_id: null,
      processed_event_ids: [],
      last_event_at: null,
    },
    templates: {
      ...compiled.templates,
      closeReport: {
        path: "workflows/sprint/close.md",
        content: "Complete: {{complete_names}}\nReformat: {{needs_reformat_names}}\nMissing: {{missing_names}}",
        digest: "f".repeat(64),
      },
    },
  });
  assert.equal(rendered.content, "Complete: Alex\nMissing: Blair");
});

const workItems: SprintWorkItem[] = [
  { work_item_id: "item-1", title: "Ship runtime", assignee_ids: ["alex"], group: "current", status: "working", url: "https://fixture.test/item-1", provider_version: "v1", fields: {} },
  { work_item_id: "item-2", title: "Test runtime", assignee_ids: ["blair"], group: "current", status: "working", url: "https://fixture.test/item-2", provider_version: "v2", fields: {} },
];

const weeklyCompiled: CompiledSprintRuntime = {
  ...compiled,
  policy: {
    ...compiled.policy,
    work_items: {
      ...compiled.policy.work_items,
      planning_group: "planning",
      planned_status: "planned",
      required_fields: ["brief", "outcome"],
    },
    weekly: { monday_handoff_trigger: "monday-handoff", weekday_digest_trigger: "weekday-digest", readiness_weekday: "wednesday" },
    rendering: {
      ...compiled.policy.rendering!,
      monday_handoff: "workflows/sprint/monday.md",
      weekday_digest: "workflows/sprint/digest.md",
      direct_question: "workflows/sprint/question.md",
    },
  },
  schedule: {
    ...compiled.schedule,
    triggers: [
      { id: "monday-handoff", weekdays: ["monday"], at: "09:30", holidayShift: "previous-business-day" },
      { id: "weekday-digest", weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"], at: "17:30", holidayShift: "previous-business-day" },
    ],
  },
  templates: {
    ...compiled.templates,
    mondayHandoff: { path: "workflows/sprint/monday.md", content: "Committed: {{committed_work_items}}\nDifferences: {{disagreements}}", digest: "1".repeat(64) },
    weekdayDigest: { path: "workflows/sprint/digest.md", content: "Daily Sprint digest\nChanged: {{changed_work_items}}\nReadiness: {{readiness_gaps}}", digest: "2".repeat(64) },
    directQuestion: { path: "workflows/sprint/question.md", content: "Hi {{participant_name}}, {{work_item_title}} needs {{missing_fields}}.", digest: "3".repeat(64) },
  },
};

function fixture(mode: "shadow" | "active" = "shadow", scheduleActivation: "blocked" | "active" = "active") {
  const store = new InMemorySprintOrchestrationStore();
  const timerStore = new InMemoryDurableTimerStore();
  const timers = new DurableTimerService({ store: timerStore, instanceId: "fixture" });
  const calls: unknown[] = [];
  const activeDispatcher = {
    async dispatch(args: any) {
      calls.push(args.claimed.intent);
      return { dispatcherId: "fixture", executionId: args.claimed.intent.intent_id, outcomeDigest: "d".repeat(64) };
    },
  };
  const hostedCompiled = { ...compiled, schedule: { ...compiled.schedule, activation: scheduleActivation } };
  const host = new HostedSprintRuntime({ instanceId: "fixture", compiled: hostedCompiled, mode, store, timers, ...(mode === "active" ? { activeDispatcher } : {}) });
  return { host, store, timerStore, calls };
}

test("blocked Workspace schedules can be rehearsed in shadow but never dispatched active", async () => {
  const snapshot = {
    participants,
    workItems,
    observedAt: "2030-01-28T09:01:00.000Z",
    participantSourceVersion: "participants-v1",
    workItemSourceVersion: "items-v1",
  };
  const shadow = fixture("shadow", "blocked");
  await shadow.host.open({ sprintId: "sprint-shadow", periodStart: "2030-01-28", periodEnd: "2030-02-01", openedAt: "2030-01-28T09:00:00.000Z", snapshot });
  assert.equal((await shadow.host.processDueTimers({ now: "2030-02-01T14:00:00.000Z", owner: "shadow", leaseToken: "shadow-lease", leaseExpiresAt: "2030-02-01T14:04:00.000Z" })).length, 1);

  const active = fixture("active", "blocked");
  await active.host.open({ sprintId: "sprint-active", periodStart: "2030-01-28", periodEnd: "2030-02-01", openedAt: "2030-01-28T09:00:00.000Z", snapshot });
  await assert.rejects(
    () => active.host.processDueTimers({ now: "2030-02-01T14:00:00.000Z", owner: "active", leaseToken: "active-lease", leaseExpiresAt: "2030-02-01T14:04:00.000Z" }),
    /schedule is blocked/,
  );
});

test("the hosted scheduler selects blocked runtimes only in shadow", () => {
  const artifact = { sprints: [compiled] } as any;
  assert.deepEqual(scheduledSprintRuntimeDefinitions(artifact, "disabled"), []);
  assert.deepEqual(scheduledSprintRuntimeDefinitions(artifact, "shadow"), [compiled.definitionId]);
  assert.deepEqual(scheduledSprintRuntimeDefinitions(artifact, "active"), [compiled.definitionId]);
  const blocked = { ...compiled, schedule: { ...compiled.schedule, activation: "blocked" as const } };
  const blockedArtifact = { sprints: [blocked] } as any;
  assert.deepEqual(scheduledSprintRuntimeDefinitions(blockedArtifact, "shadow"), [compiled.definitionId]);
  assert.deepEqual(scheduledSprintRuntimeDefinitions(blockedArtifact, "active"), []);
});

test("the configured Sprint runtime mode is exact and fails closed", () => {
  assert.equal(currentSprintRuntimeMode({ COMPANYOS_SPRINT_RUNTIME_MODE: "shadow" } as NodeJS.ProcessEnv), "shadow");
  assert.equal(currentSprintRuntimeMode({} as NodeJS.ProcessEnv), "disabled");
  assert.throws(
    () => currentSprintRuntimeMode({ COMPANYOS_SPRINT_RUNTIME_MODE: "shdow" } as NodeJS.ProcessEnv),
    /must be disabled, shadow, or active/,
  );
});

test("a compiled shadow-only Sprint can never start in active mode", () => {
  const shadowOnly: CompiledSprintRuntime = { ...compiled, execution: "shadow-only" };
  assert.doesNotThrow(() => assertSprintRuntimeModeCompatible(shadowOnly, "shadow"));
  assert.doesNotThrow(() => assertSprintRuntimeModeCompatible(shadowOnly, "disabled"));
  assert.throws(() => assertSprintRuntimeModeCompatible(shadowOnly, "active"), /shadow-only and cannot start in active mode/);
});

test("hosted Sprint runtime opens from one frozen snapshot and is replay-safe", async () => {
  const { host, store } = fixture();
  const input = {
    sprintId: "sprint-5",
    periodStart: "2030-01-28",
    periodEnd: "2030-02-01",
    openedAt: "2030-01-28T09:00:00.000Z",
    snapshot: {
      participants,
      workItems,
      observedAt: "2030-01-28T09:01:00.000Z",
      participantSourceVersion: "participants-v1",
      workItemSourceVersion: "items-v1",
    },
  };
  const first = await host.open(input);
  const replay = await host.open(input);
  assert.deepEqual(first, { opened: "applied", timers: { scheduled: 3, existing: 0 }, participants: "applied", workItems: "applied", stateVersion: 3 });
  assert.deepEqual(replay, { opened: "duplicate", timers: { scheduled: 0, existing: 3 }, participants: "duplicate", workItems: "duplicate", stateVersion: 3 });
  assert.equal(store.events.size, 3);
  assert.equal((await host.inspect()).workItemCount, 2);
});

test("a stabilized refresh updates only mutable work facts and remains replay-safe", async () => {
  const { host, store } = fixture();
  await host.open({
    sprintId: "sprint-refresh",
    periodStart: "2030-01-28",
    periodEnd: "2030-02-01",
    openedAt: "2030-01-28T09:00:00.000Z",
    snapshot: { participants, workItems, observedAt: "2030-01-28T09:01:00.000Z", participantSourceVersion: "p1", workItemSourceVersion: "w1" },
  });
  const changedItems = workItems.map((item) => item.work_item_id === "item-1" ? { ...item, status: "done", provider_version: "v3" } : item);
  const snapshot = { participants: [], workItems: changedItems, observedAt: "2030-01-29T17:29:00.000Z", participantSourceVersion: "ignored", workItemSourceVersion: "w2" };
  const first = await host.refreshWorkItems({ snapshot, refreshedAt: "2030-01-29T17:30:00.000Z" });
  const replay = await host.refreshWorkItems({ snapshot, refreshedAt: "2030-01-29T17:30:00.000Z" });
  assert.equal(first.status, "applied");
  assert.equal(replay.status, "duplicate");
  const state = (await store.getState({ instanceId: "fixture", definitionId: "weekly-delivery" }))!.state;
  assert.deepEqual(Object.keys(state.participants).sort(), ["alex", "blair"]);
  assert.equal(state.work_items["item-1"]?.status, "done");
  assert.deepEqual(state.work_item_changes, [{
    work_item_id: "item-1", title: "Ship runtime", previous_version: "v1", provider_version: "v3", changed_fields: ["status"],
  }]);
});

test("a stabilized snapshot observed before Sprint open refreshes at the runtime clock", async () => {
  const { host, store } = fixture();
  const snapshot = {
    participants,
    workItems,
    observedAt: "2030-01-28T08:59:00.000Z",
    participantSourceVersion: "participants-before-open",
    workItemSourceVersion: "items-before-open",
  };
  await host.open({
    sprintId: "sprint-refresh-chronology",
    periodStart: "2030-01-28",
    periodEnd: "2030-02-01",
    openedAt: "2030-01-28T09:00:00.000Z",
    snapshot,
  });

  const first = await host.refreshWorkItems({ snapshot, refreshedAt: "2030-01-28T09:01:00.000Z" });
  const replay = await host.refreshWorkItems({ snapshot, refreshedAt: "2030-01-28T09:02:00.000Z" });

  assert.equal(first.status, "applied");
  assert.equal(replay.status, "duplicate");
  const state = (await store.getState({ instanceId: "fixture", definitionId: "weekly-delivery" }))!.state;
  assert.equal(state.last_event_at, "2030-01-28T09:01:00.000Z");
  assert.equal(store.events.size, 4);
});

test("a Sprint refresh rejects an existing durable event with the wrong type", async () => {
  const { host, store } = fixture();
  await host.open({
    sprintId: "sprint-refresh-type-guard",
    periodStart: "2030-01-28",
    periodEnd: "2030-02-01",
    openedAt: "2030-01-28T09:00:00.000Z",
    snapshot: {
      participants,
      workItems,
      observedAt: "2030-01-28T09:01:00.000Z",
      participantSourceVersion: "participants-v1",
      workItemSourceVersion: "items-v1",
    },
  });
  const snapshot = {
    participants,
    workItems,
    observedAt: "2030-01-28T09:02:00.000Z",
    participantSourceVersion: "participants-v1",
    workItemSourceVersion: "items-v2",
  };
  await host.refreshWorkItems({ snapshot, refreshedAt: "2030-01-28T09:03:00.000Z" });
  const refresh = [...store.events.entries()].find(([eventKey]) => eventKey.includes("refresh:work-items:"));
  assert.ok(refresh);
  (refresh[1].event as any).type = "sprint.opened";

  await assert.rejects(
    () => host.refreshWorkItems({ snapshot, refreshedAt: "2030-01-28T09:04:00.000Z" }),
    /has an invalid durable type/,
  );
});

test("the hosted weekly runtime executes Monday, weekday, and one focused Wednesday DM in shadow", async () => {
  const store = new InMemorySprintOrchestrationStore();
  const timerStore = new InMemoryDurableTimerStore();
  const timers = new DurableTimerService({ store: timerStore, instanceId: "fixture" });
  const host = new HostedSprintRuntime({ instanceId: "fixture", compiled: weeklyCompiled, mode: "shadow", store, timers });
  const weeklyItems: SprintWorkItem[] = [
    ...workItems,
    { work_item_id: "item-3", title: "Prepare brief", assignee_ids: ["alex"], group: "planning", status: "planned", provider_version: "v3", fields: { brief: "", outcome: "one approved brief" } },
    { work_item_id: "item-4", title: "Ready brief", assignee_ids: ["blair"], group: "planning", status: "planned", provider_version: "v4", fields: { brief: "approved", outcome: "one approved result" } },
  ];
  const opened = await host.open({
    sprintId: "sprint-week",
    periodStart: "2030-01-28",
    periodEnd: "2030-02-01",
    openedAt: "2030-01-28T09:00:00.000Z",
    snapshot: { participants, workItems: weeklyItems, observedAt: "2030-01-28T09:01:00.000Z", participantSourceVersion: "p1", workItemSourceVersion: "w1" },
  });
  assert.deepEqual(opened.timers, { scheduled: 9, existing: 0 });
  await host.processDueTimers({ now: "2030-01-28T09:30:00.000Z", owner: "timer", leaseToken: "monday", leaseExpiresAt: "2030-01-28T09:35:00.000Z" });
  assert.deepEqual((await host.dispatchIntents({ now: "2030-01-28T09:31:00.000Z", owner: "intent", leaseToken: "monday-intent", leaseExpiresAt: "2030-01-28T09:36:00.000Z" })).map((entry) => entry.status), ["succeeded"]);
  for (const [day, lease] of [["2030-01-28", "d1"], ["2030-01-29", "d2"]] as const) {
    await host.processDueTimers({ now: `${day}T17:30:00.000Z`, owner: "timer", leaseToken: lease, leaseExpiresAt: `${day}T17:35:00.000Z` });
    assert.deepEqual((await host.dispatchIntents({ now: `${day}T17:31:00.000Z`, owner: "intent", leaseToken: `${lease}-intent`, leaseExpiresAt: `${day}T17:36:00.000Z` })).map((entry) => entry.status), ["succeeded"]);
  }
  await host.processDueTimers({ now: "2030-01-30T17:30:00.000Z", owner: "timer", leaseToken: "wednesday", leaseExpiresAt: "2030-01-30T17:35:00.000Z" });
  assert.deepEqual((await host.dispatchIntents({ now: "2030-01-30T17:31:00.000Z", owner: "intent", leaseToken: "wednesday-intent", leaseExpiresAt: "2030-01-30T17:36:00.000Z" })).map((entry) => entry.status), ["succeeded", "succeeded", "succeeded"]);
  const state = (await store.getState({ instanceId: "fixture", definitionId: "weekly-delivery" }))!.state;
  const direct = Object.values(state.deliveries).find((delivery) => delivery.purpose === "direct-question");
  assert.equal(direct?.participant_id, "alex");
  assert.equal(direct?.destination_binding, "direct-alex");
  assert.equal(([...store.intents.values()].find((row) => row.intent.type === "message.direct-question")?.evidence as any)?.dispatcherId, "sprint-shadow");
  assert.equal(([...store.intents.values()].find((row) => row.intent.type === "work-item.readiness-update")?.evidence as any)?.dispatcherId, "sprint-shadow");
});

test("Slack Friday updates enter the durable Sprint state only after a routed participant match", async () => {
  const { host, store } = fixture();
  await host.open({
    sprintId: "sprint-5",
    periodStart: "2030-01-28",
    periodEnd: "2030-02-01",
    openedAt: "2030-01-28T09:00:00.000Z",
    snapshot: { participants, workItems, observedAt: "2030-01-28T09:01:00.000Z", participantSourceVersion: "p1", workItemSourceVersion: "w1" },
  });
  await host.processDueTimers({ now: "2030-02-01T14:00:00.000Z", owner: "timer", leaseToken: "timer-root", leaseExpiresAt: "2030-02-01T14:04:00.000Z" });
  await host.dispatchIntents({ now: "2030-02-01T14:01:00.000Z", owner: "intent", leaseToken: "intent-root", leaseExpiresAt: "2030-02-01T14:05:00.000Z" });
  const threadReference = (await store.getState({ instanceId: "fixture", definitionId: "weekly-delivery" }))!.state.close_thread_reference!;
  const accepted = await host.ingestSlackSubmission({
    messageId: "message-1",
    occurredAt: "2030-02-01T16:30:00.000Z",
    principal: "slack:T1:U1",
    threadReference,
    text: "MY FRIDAY SPRINT UPDATE — Alex, week of 2030-01-28\n\nTHIS WEEK\n:white_check_mark: Ship runtime — done. https://fixture.test/item-1\n\n:thought_balloon: Biggest blocker / learning: none\n\nNEXT WEEK\n:dart: Sprint goal: Next\n:bar_chart: Measurable outcome: one\nTasks:\n• Next — https://fixture.test/next",
  });
  assert.deepEqual(accepted, { accepted: true, status: "applied", stateVersion: 6 });
  const duplicate = await host.ingestSlackSubmission({
    messageId: "message-1",
    occurredAt: "2030-02-01T16:30:00.000Z",
    principal: "slack:T1:U1",
    threadReference,
    text: "MY FRIDAY SPRINT UPDATE — Alex, week of 2030-01-28\n\nTHIS WEEK\n:white_check_mark: Ship runtime — done. https://fixture.test/item-1\n\n:thought_balloon: Biggest blocker / learning: none\n\nNEXT WEEK\n:dart: Sprint goal: Next\n:bar_chart: Measurable outcome: one\nTasks:\n• Next — https://fixture.test/next",
  });
  assert.equal(duplicate.status, "duplicate");
  const storedSubmission = (await store.getState({ instanceId: "fixture", definitionId: "weekly-delivery" }))!.state.submissions.alex?.at(-1);
  assert.deepEqual(storedSubmission?.next_week, {
    goal: "Next",
    measurable_outcome: "one",
    tasks: [{ title: "Next", url: "https://fixture.test/next" }],
  });
  await assert.rejects(() => host.ingestSlackSubmission({ messageId: "message-2", occurredAt: "2030-02-01T16:31:00.000Z", principal: "slack:T1:UNKNOWN", threadReference, text: "MY FRIDAY SPRINT UPDATE\nTHIS WEEK\nNEXT WEEK" }), /not an included Sprint participant/);
  await assert.rejects(() => host.ingestSlackSubmission({ messageId: "message-3", occurredAt: "2030-02-01T16:32:00.000Z", principal: "slack:T1:U1", threadReference: "slack:C1:wrong-thread", text: "MY FRIDAY SPRINT UPDATE\nTHIS WEEK\nNEXT WEEK" }), /not in the active shared Close thread/);
});

test("shadow workers render and persist only digest evidence without external effects", async () => {
  const { host, store, timerStore } = fixture();
  await host.open({
    sprintId: "sprint-5",
    periodStart: "2030-01-28",
    periodEnd: "2030-02-01",
    openedAt: "2030-01-28T09:00:00.000Z",
    snapshot: { participants, workItems, observedAt: "2030-01-28T09:01:00.000Z", participantSourceVersion: "p1", workItemSourceVersion: "w1" },
  });
  await timerStore.schedule({ instanceId: "fixture", timerId: "foreign", timerKind: "other.timer", dueAt: "2030-02-01T13:00:00.000Z", idempotencyKey: "foreign", payload: {} });
  const timers = await host.processDueTimers({ now: "2030-02-01T14:00:00.000Z", owner: "timer", leaseToken: "timer-lease", leaseExpiresAt: "2030-02-01T14:04:00.000Z" });
  assert.equal(timers.length, 1);
  assert.equal(timerStore.rows.get("fixture\0foreign")?.state, "scheduled");
  const intents = await host.dispatchIntents({ now: "2030-02-01T14:01:00.000Z", owner: "intent", leaseToken: "intent-lease", leaseExpiresAt: "2030-02-01T14:05:00.000Z" });
  assert.equal(intents.length, 1);
  assert.ok(intents.every((intent) => intent.status === "succeeded"));
  const evidence = [...store.intents.values()].map((row: any) => row.evidence);
  assert.ok(evidence.every((entry) => entry.dispatcherId === "sprint-shadow"));
  assert.ok(evidence.every((entry) => !JSON.stringify(entry).includes("please post")));
});

test("hosted shadow runtime proves the ordered shared-thread Friday Close without provider effects", async () => {
  const { host, store } = fixture();
  await host.open({
    sprintId: "sprint-5",
    periodStart: "2030-01-28",
    periodEnd: "2030-02-01",
    openedAt: "2030-01-28T09:00:00.000Z",
    nextSprintId: "sprint-6",
    snapshot: { participants, workItems, observedAt: "2030-01-28T09:01:00.000Z", participantSourceVersion: "p1", workItemSourceVersion: "w1" },
  });
  await host.processDueTimers({ now: "2030-02-01T14:00:00.000Z", owner: "timer", leaseToken: "timer-1", leaseExpiresAt: "2030-02-01T14:04:00.000Z" });
  assert.deepEqual((await host.dispatchIntents({ now: "2030-02-01T14:01:00.000Z", owner: "intent", leaseToken: "intent-1", leaseExpiresAt: "2030-02-01T14:05:00.000Z" })).map((entry) => entry.status), ["succeeded"]);
  const root = (await store.getState({ instanceId: "fixture", definitionId: "weekly-delivery" }))!.state.close_thread_reference!;
  await host.ingestSlackSubmission({
    messageId: "submission-alex",
    occurredAt: "2030-02-01T15:00:00.000Z",
    principal: "slack:T1:U1",
    threadReference: root,
    text: "MY FRIDAY SPRINT UPDATE — Alex\nTHIS WEEK\n:white_check_mark: Ship runtime — done. https://fixture.test/item-1\n:thought_balloon: Biggest blocker / learning: none\nNEXT WEEK\n:dart: Sprint goal: Next\n:bar_chart: Measurable outcome: one\nTasks:\n• Next — https://fixture.test/next",
  });
  await host.processDueTimers({ now: "2030-02-01T16:15:00.000Z", owner: "timer", leaseToken: "timer-2", leaseExpiresAt: "2030-02-01T16:19:00.000Z" });
  assert.deepEqual((await host.dispatchIntents({ now: "2030-02-01T16:16:00.000Z", owner: "intent", leaseToken: "intent-2", leaseExpiresAt: "2030-02-01T16:20:00.000Z" })).map((entry) => entry.status), ["succeeded"]);
  await host.processDueTimers({ now: "2030-02-01T17:00:00.000Z", owner: "timer", leaseToken: "timer-3", leaseExpiresAt: "2030-02-01T17:04:00.000Z" });
  assert.deepEqual((await host.dispatchIntents({ now: "2030-02-01T17:01:00.000Z", owner: "intent", leaseToken: "intent-3", leaseExpiresAt: "2030-02-01T17:05:00.000Z" })).map((entry) => entry.status), ["succeeded"]);
  assert.deepEqual((await host.dispatchIntents({ now: "2030-02-01T17:02:00.000Z", owner: "intent", leaseToken: "intent-4", leaseExpiresAt: "2030-02-01T17:06:00.000Z" })).map((entry) => entry.status), ["succeeded"]);
  assert.deepEqual((await host.dispatchIntents({ now: "2030-02-01T17:03:00.000Z", owner: "intent", leaseToken: "intent-5", leaseExpiresAt: "2030-02-01T17:07:00.000Z" })).map((entry) => entry.status), ["succeeded"]);
  const state = (await store.getState({ instanceId: "fixture", definitionId: "weekly-delivery" }))!.state;
  assert.equal(state.close_thread_reference, root);
  assert.equal(state.phase, "closed");
  assert.deepEqual(Object.values(state.deliveries).map((entry) => entry.purpose).sort(), ["close-chase", "close-reminder", "close-report", "retro"]);
  assert.deepEqual([...store.intents.values()].map((row) => row.intent.type).sort(), [
    "message.close-chase", "message.close-reminder", "message.close-report", "message.retro", "work-item.rollover-proposal",
  ]);
  assert.equal(([...store.intents.values()].find((row) => row.intent.type === "work-item.rollover-proposal")?.evidence as any)?.dispatcherId, "sprint-proposal");
  await assert.doesNotReject(() => host.open({
    sprintId: "sprint-6",
    periodStart: "2030-02-04",
    periodEnd: "2030-02-08",
    openedAt: "2030-02-04T09:00:00.000Z",
    snapshot: { participants, workItems, observedAt: "2030-02-04T09:01:00.000Z", participantSourceVersion: "p2", workItemSourceVersion: "w2" },
  }));
});

test("a late worker defers dependent timers and catches up in reviewed close order", async () => {
  const { host, store, timerStore } = fixture();
  await host.open({
    sprintId: "sprint-late",
    periodStart: "2030-01-28",
    periodEnd: "2030-02-01",
    openedAt: "2030-01-28T09:00:00.000Z",
    snapshot: { participants, workItems, observedAt: "2030-01-28T09:01:00.000Z", participantSourceVersion: "p-late", workItemSourceVersion: "w-late" },
  });

  const first = await host.processDueTimers({
    now: "2030-02-01T17:00:00.000Z",
    owner: "late-timer",
    leaseToken: "late-timer-1",
    leaseExpiresAt: "2030-02-01T17:04:00.000Z",
  });
  assert.deepEqual(first.map((entry) => entry.status), ["applied", "deferred", "deferred"]);
  assert.equal([...timerStore.rows.values()].filter((row) => row.state === "failed").length, 0);

  assert.deepEqual((await host.dispatchIntents({
    now: "2030-02-01T17:01:00.000Z",
    owner: "late-intent",
    leaseToken: "late-intent-1",
    leaseExpiresAt: "2030-02-01T17:05:00.000Z",
  })).map((entry) => entry.status), ["succeeded"]);

  const second = await host.processDueTimers({
    now: "2030-02-01T17:02:00.000Z",
    owner: "late-timer",
    leaseToken: "late-timer-2",
    leaseExpiresAt: "2030-02-01T17:06:00.000Z",
  });
  assert.deepEqual(second.map((entry) => entry.status), ["applied", "applied"]);

  const due = [...store.intents.values()]
    .filter((row) => row.state === "pending")
    .sort((left, right) => left.availableAt.localeCompare(right.availableAt));
  assert.deepEqual(due.map((row) => row.intent.type), ["message.close-chase", "message.close-report"]);
  assert.ok(due[0].availableAt < due[1].availableAt);
  assert.deepEqual((await host.dispatchIntents({
    now: "2030-02-01T17:03:00.000Z",
    owner: "late-intent",
    leaseToken: "late-intent-2",
    leaseExpiresAt: "2030-02-01T17:07:00.000Z",
  })).map((entry) => entry.status), ["succeeded", "succeeded"]);
});

test("operator opening time cannot move the projection freshness check into the past", async () => {
  const input = parseSprintOperatorRequest(JSON.stringify({
    action: "open",
    sprint_id: "future-sprint",
    period_start: "2030-01-28",
    period_end: "2030-02-01",
    opened_at: "2030-01-28T10:00:00.000Z",
    excluded_participant_ids: [],
  }));
  await assert.rejects(
    () => executeSprintOperator(input, "2030-01-28T09:00:00.000Z"),
    /must not be in the future/,
  );
});

test("Sprint projection freezing requires two consecutive canonical reads", async () => {
  const versions = ["v1", "v2", "v2"];
  const stable = await stabilizeSprintProjection("sprint-items", async (pass) => ({
    rows: [],
    version: versions[pass],
    observedAt: "2030-01-28T09:00:00.000Z",
  }));
  assert.equal(stable.version, "v2");

  await assert.rejects(
    () => stabilizeSprintProjection("sprint-items", async (pass) => ({
      rows: [],
      version: ["v1", "v2", "v3"][pass],
      observedAt: "2030-01-28T09:00:00.000Z",
    })),
    /changed while its frozen snapshot was being read/,
  );
});

test("hosted Sprint timers refuse a stale compiled schedule version", async () => {
  const { host, timerStore } = fixture();
  await host.open({
    sprintId: "sprint-5",
    periodStart: "2030-01-28",
    periodEnd: "2030-02-01",
    openedAt: "2030-01-28T09:00:00.000Z",
    snapshot: { participants, workItems, observedAt: "2030-01-28T09:01:00.000Z", participantSourceVersion: "p1", workItemSourceVersion: "w1" },
  });
  const reminder = [...timerStore.rows.values()].find((row) => row.payload && typeof row.payload === "object" && (row.payload as any).moment === "reminder");
  assert.ok(reminder);
  reminder.payload = { ...(reminder.payload as Record<string, any>), schedule_version: "f".repeat(64) };
  const results = await host.processDueTimers({ now: "2030-02-01T14:00:00.000Z", owner: "timer", leaseToken: "timer-lease", leaseExpiresAt: "2030-02-01T14:04:00.000Z" });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "failed");
  assert.equal(reminder.state, "failed");
});

test("compiled resolver binds messages exactly and refuses unconfirmed work-item effects", async () => {
  const compiledWithWrites: CompiledSprintRuntime = {
    ...compiled,
    workItem: { resourceBinding: "sprint-board", rolloverField: "sprint", readinessField: "status" },
  };
  const resolver = new CompiledSprintToolExecutionResolver(compiledWithWrites);
  const state = {
    sprint_id: "sprint-5",
    period_start: "2030-01-28",
    period_end: "2030-02-01",
    phase: "open" as const,
    participants: Object.fromEntries(participants.map((participant) => [participant.participant_id, participant])),
    work_items: Object.fromEntries(workItems.map((item) => [item.work_item_id, item])),
    submissions: {}, deliveries: {}, close_thread_reference: null, next_sprint_id: null, processed_event_ids: [], last_event_at: null,
  };
  const message = await resolver.resolve({ instanceId: "fixture", definitionId: "weekly-delivery", state, intent: { type: "message.close-reminder", intent_id: "i1", channel_binding: "sprint-channel", due_at: "2030-02-01T14:00:00.000Z" } });
  assert.equal(message.agentId, "sprint");
  assert.equal(message.grantId, "oregano:communications/publish");
  assert.equal((message.input as any).destination_binding, "sprint-channel");
  await assert.rejects(() => resolver.resolve({ instanceId: "fixture", definitionId: "weekly-delivery", state, intent: { type: "message.close-reminder", intent_id: "wrong-binding", channel_binding: "some-other-channel", due_at: "2030-02-01T14:00:00.000Z" } }), /widen its reviewed shared-channel binding/);
  await assert.rejects(() => resolver.resolve({ instanceId: "fixture", definitionId: "weekly-delivery", state, intent: { type: "work-item.rollover", intent_id: "i2", work_item_id: "item-1", target_sprint_id: "sprint-6", expected_version: "v1" } }), /separate confirmation path/);
  const readiness = await resolver.resolve({ instanceId: "fixture", definitionId: "weekly-delivery", state, intent: { type: "work-item.readiness-update", intent_id: "i3", work_item_id: "item-1", expected_version: "v1", target_status: "ready", reason: "ready" } });
  assert.deepEqual(readiness, {
    agentId: "sprint",
    grantId: "oregano:work-items/update",
    subjectPrincipal: "companyos:fixture:sprint",
    input: { resource_binding: "sprint-board", work_item_id: "item-1", expected_version: "v1", changes: { status: "ready" } },
  });
  assert.deepEqual(sprintRolloverToolRequest({
    compiled: compiledWithWrites,
    intent: { type: "work-item.rollover-proposal", intent_id: "i4", target_sprint_id: "sprint-6", items: [{ work_item_id: "item-1", expected_version: "v1" }] },
  }), {
    agentId: "sprint",
    grantId: "oregano:work-items/batch-update",
    subjectPrincipal: "companyos:fixture:sprint",
    input: { resource_binding: "sprint-board", updates: [{ work_item_id: "item-1", expected_version: "v1", changes: { sprint: "sprint-6" } }] },
  });
});

test("Workbench compiles one immutable hosted schedule only from exact Workspace and Instance bindings", () => {
  const workspace: LoadedWorkspace = {
    company: "Fixture",
    version: "1.0.0",
    roster: [
      { id: "service", role: "automation", name: "Sprint Service", status: "active", type: "service", mayApprove: [], principals: ["companyos:fixture:sprint"], groups: ["sprint-participant"] },
      { id: "alex", role: "contributor", name: "Alex", status: "active", mayApprove: [], principals: ["slack:T1:U1", "monday:A1:101"], groups: ["sprint-participant"] },
    ],
    agents: [
      { id: "oregano", instructions: "Answer general questions.", grants: [], scopeRead: [], handoffs: [{ id: "oregano-to-sprint", fromAgentId: "oregano", toAgentId: "sprint", purpose: "sprint", surfaces: ["slack"], eligibleRoles: [], eligibleGroups: ["sprint-participant"], ttlSeconds: 3_600 }], tools: [] },
      { id: "sprint", instructions: "Coordinate the Sprint.", grants: ["oregano:records/query", "oregano:communications/publish"], scopeRead: [], handoffs: [], tools: [] },
    ],
    allowedCapabilities: ["records.query", "communication.message.publish"],
    allFiles: {
      "workflows/sprint/config.yaml": `schema_version: 1
id: weekly-delivery
participants: { projection: participants, absence_policy: exclude-approved, roster_group: sprint-participant }
work_items: { projection: sprint-items, master_group: current, ready_status: ready, closed_statuses: [done] }
calendar: { timezone: UTC, business_calendar_ref: schedules/sprint.yaml, holiday_shift: previous-business-day }
close: { weekday: friday, reminder_time: "14:00", complete_by: "16:00", chase_time: "16:15", report_at: "17:00" }
submission: { task_line_rule: one-per-committed-task, after_report: provider-only }
effort: unavailable
rollover: { eligible: all-open }
delivery: { shared_thread: true, channel_binding: sprint-channel, direct_binding: sprint-direct }
model_task_profile: sprint.coordination
rendering: { reminder: workflows/sprint/reminder.md, chase: workflows/sprint/chase.md, close_report: workflows/sprint/close.md, retro: workflows/sprint/retro.md }
`,
      "schedules/sprint.yaml": `schema_version: 1
id: sprint-schedule
activation: active
timezone: UTC
business_days: [monday, tuesday, wednesday, thursday, friday]
holiday_calendar: { missing_year_policy: assume-no-holidays, years: {} }
delivery_window: { opens_at: "08:00", closes_at: "19:00" }
triggers:
  - { id: reminder, weekdays: [friday], at: "14:00", holiday_shift: previous-business-day }
  - { id: chase, weekdays: [friday], at: "16:15", holiday_shift: previous-business-day }
  - { id: report, weekdays: [friday], at: "17:00", holiday_shift: previous-business-day }
`,
      "records/projections/participants.yaml": "schema_version: 1\nid: participants\nfields:\n  - { name: person_ids, path: person_ids }\n  - { name: role, path: role }\n",
      "records/projections/sprint-items.yaml": "schema_version: 1\nid: sprint-items\nfields:\n  - { name: work_item_id, path: work_item_id }\n  - { name: title, path: title }\n  - { name: assignee_ids, path: assignee_ids }\n  - { name: group, path: group }\n  - { name: status, path: status }\n  - { name: provider_version, path: provider_version }\n",
      "records/projections/sprint-messages.yaml": "schema_version: 1\nid: sprint-messages\nrecord_type: communication-message\nfields:\n  - { name: message_id, path: message_id }\n  - { name: team_id, path: team_id }\n  - { name: author_id, path: author_id }\n  - { name: thread_id, path: thread_id }\n  - { name: text, path: text }\n  - { name: occurred_at, path: occurred_at }\n",
      "workflows/sprint/reminder.md": "---\ntype: concept\ndescription: Runtime reminder.\n---\nPost in this thread for {{sprint_id}}",
      "workflows/sprint/chase.md": "Missing: {{missing_names}}",
      "workflows/sprint/close.md": "Missing: {{missing_names}}",
      "workflows/sprint/retro.md": "Open: {{open_work_item_count}}",
    },
    workspaceHash: "workspace-hash",
  };
  const instance: InstanceBuildConfiguration = {
    version: 1,
    instanceId: "fixture",
    environment: "preview",
    bindings: [],
    agentBindings: [],
    connectors: [{
      id: "slack",
      connector: "oregano/slack-communication",
      connectorVersion: "0.1.0",
      configuration: { destinations: [
        { id: "sprint-channel", account_id: "T1", kind: "channel", channel_id: "C1" },
        { id: "direct-alex", account_id: "T1", kind: "direct-message", user_id: "U1" },
      ] },
    }],
    sprintRuntimes: [{ definitionId: "weekly-delivery", agentId: "sprint", execution: "active-capable", servicePrincipal: "companyos:fixture:sprint", participantIdentityPrefix: "monday:A1:", directDestinations: { "slack:T1:U1": "direct-alex" }, replay: { messageProjection: "sprint-messages" } }],
  };
  const runtimes = compileSprintRuntimes({ workspace, instance, coreCommit: "core-commit", workspaceCommit: "workspace-commit", workbenchVersion: "0.1.0-experimental.15" });
  assert.equal(runtimes.length, 1);
  assert.equal(runtimes[0].modelTask, "sprint.coordination");
  assert.equal(runtimes[0].execution, "active-capable");
  assert.deepEqual(runtimes[0].replay, { messageProjection: "sprint-messages" });
  assert.equal(runtimes[0].schedule.provenance.instanceId, "fixture");
  assert.deepEqual(runtimes[0].schedule.triggers.map((trigger) => trigger.holidayShift), [
    "previous-business-day",
    "previous-business-day",
    "previous-business-day",
  ]);
  assert.equal(runtimes[0].templates.reminder.content, "Post in this thread for {{sprint_id}}");
  const missingDestination = structuredClone(instance);
  missingDestination.connectors![0].configuration.destinations = [];
  assert.throws(() => compileSprintRuntimes({ workspace, instance: missingDestination, coreCommit: "core", workspaceCommit: "workspace", workbenchVersion: "0.1.0-experimental.15" }), /channel binding/);
  const missingParticipantDm = structuredClone(instance);
  missingParticipantDm.sprintRuntimes![0].directDestinations = {};
  assert.throws(() => compileSprintRuntimes({ workspace, instance: missingParticipantDm, coreCommit: "core", workspaceCommit: "workspace", workbenchVersion: "0.1.0-experimental.15" }), /lacks an exact direct-message destination binding/);
  const unknownPlaceholder = structuredClone(workspace);
  unknownPlaceholder.allFiles["workflows/sprint/reminder.md"] = "Hi {{company_secret}}";
  assert.throws(() => compileSprintRuntimes({ workspace: unknownPlaceholder, instance, coreCommit: "core", workspaceCommit: "workspace", workbenchVersion: "0.1.0-experimental.15" }), /unsupported placeholder/);
  const invalidReplay = structuredClone(workspace);
  invalidReplay.allFiles["records/projections/sprint-messages.yaml"] = invalidReplay.allFiles["records/projections/sprint-messages.yaml"]!.replace("  - { name: team_id, path: team_id }\n", "");
  assert.throws(() => compileSprintRuntimes({ workspace: invalidReplay, instance, coreCommit: "core", workspaceCommit: "workspace", workbenchVersion: "0.1.0-experimental.15" }), /canonical field 'team_id'/);

  const shadowWorkspace = structuredClone(workspace);
  shadowWorkspace.agents[1]!.grants = ["oregano:records/query"];
  shadowWorkspace.allowedCapabilities = ["records.query"];
  const shadowInstance = structuredClone(instance);
  shadowInstance.sprintRuntimes![0]!.execution = "shadow-only";
  const shadowRuntimes = compileSprintRuntimes({ workspace: shadowWorkspace, instance: shadowInstance, coreCommit: "core", workspaceCommit: "workspace", workbenchVersion: "0.1.0-experimental.15" });
  assert.equal(shadowRuntimes[0]!.execution, "shadow-only");
  assert.deepEqual(shadowWorkspace.agents[1]!.grants, ["oregano:records/query"]);

  const shadowWithWorkItem = structuredClone(shadowInstance);
  shadowWithWorkItem.sprintRuntimes![0]!.workItem = { resourceBinding: "sprint-board", rolloverField: "sprint" };
  assert.throws(() => compileSprintRuntimes({ workspace: shadowWorkspace, instance: shadowWithWorkItem, coreCommit: "core", workspaceCommit: "workspace", workbenchVersion: "0.1.0-experimental.15" }), /cannot bind a work-item resource/);

  const publicationWorkspace = structuredClone(workspace);
  publicationWorkspace.agents.push({
    id: "sprint-replay-publisher",
    instructions: "Publish reviewed replay reports only.",
    grants: ["oregano:communications/publish", "oregano:work-items/comment"],
    scopeRead: [],
    handoffs: [],
    tools: [],
  });
  publicationWorkspace.allowedCapabilities.push("work-item.comment");
  publicationWorkspace.allFiles["workflows/sprint/config.yaml"] = publicationWorkspace.allFiles["workflows/sprint/config.yaml"]!
    .replace("retro: workflows/sprint/retro.md", "retro: workflows/sprint/retro.md, replay_report: workflows/sprint/replay.md");
  publicationWorkspace.allFiles["workflows/sprint/replay.md"] = "Replay {{replay_id}} complete: {{complete_names}} digest {{output_digest}}";
  const publicationInstance = structuredClone(instance);
  publicationInstance.connectors![0]!.configuration.destinations = [
    ...(publicationInstance.connectors![0]!.configuration.destinations as any[]),
    { id: "sprint-test-channel", account_id: "T1", kind: "channel", channel_id: "CTEST" },
  ];
  publicationInstance.connectors!.push({
    id: "monday",
    connector: "oregano/monday-work-items",
    connectorVersion: "0.1.0",
    configuration: { resources: [{ id: "sprint-test-board", board_id: "200", permission: "read-write", fields: {} }] },
  });
  publicationInstance.sprintRuntimes![0]!.replay!.testPublication = {
    testOnly: true,
    publisherAgentId: "sprint-replay-publisher",
    communicationBinding: "sprint-test-channel",
    workItemBinding: "sprint-test-board",
    workItemId: "201",
    forbiddenChannelIds: ["C1"],
    forbiddenBoardIds: ["100"],
  };
  const publicationRuntime = compileSprintRuntimes({ workspace: publicationWorkspace, instance: publicationInstance, coreCommit: "core", workspaceCommit: "workspace", workbenchVersion: "0.1.0-experimental.15" })[0]!;
  assert.equal(publicationRuntime.replay?.testPublication?.publisherAgentId, "sprint-replay-publisher");
  assert.equal(publicationRuntime.templates.replayReport?.path, "workflows/sprint/replay.md");

  const routedPublisher = structuredClone(publicationInstance);
  routedPublisher.agentBindings.push({ id: "publisher-chat", agentId: "sprint-replay-publisher", surface: "slack", accountId: "T1", channelId: "CTEST" });
  assert.throws(() => compileSprintRuntimes({ workspace: publicationWorkspace, instance: routedPublisher, coreCommit: "core", workspaceCommit: "workspace", workbenchVersion: "0.1.0-experimental.15" }), /must not be reachable/);

  const overprivilegedPublisher = structuredClone(publicationWorkspace);
  overprivilegedPublisher.agents.find((candidate) => candidate.id === "sprint-replay-publisher")!.grants.push("oregano:records/query");
  assert.throws(() => compileSprintRuntimes({ workspace: overprivilegedPublisher, instance: publicationInstance, coreCommit: "core", workspaceCommit: "workspace", workbenchVersion: "0.1.0-experimental.15" }), /exactly the two test-publication Tool grants/);

  const handoffPublisher = structuredClone(publicationWorkspace);
  handoffPublisher.agents.find((candidate) => candidate.id === "sprint")!.handoffs.push({
    id: "unsafe-publisher-handoff",
    fromAgentId: "sprint",
    toAgentId: "sprint-replay-publisher",
    purpose: "unsafe",
    surfaces: ["slack"],
    eligibleRoles: ["contributor"],
    eligibleGroups: [],
    ttlSeconds: 60,
  });
  assert.throws(() => compileSprintRuntimes({ workspace: handoffPublisher, instance: publicationInstance, coreCommit: "core", workspaceCommit: "workspace", workbenchVersion: "0.1.0-experimental.15" }), /must not be reachable through an Agent handoff/);

  const protectedChannel = structuredClone(publicationInstance);
  (protectedChannel.connectors![0]!.configuration.destinations as any[])[2]!.channel_id = "C1";
  assert.throws(() => compileSprintRuntimes({ workspace: publicationWorkspace, instance: protectedChannel, coreCommit: "core", workspaceCommit: "workspace", workbenchVersion: "0.1.0-experimental.15" }), /protected Slack channel/);

  const protectedBoard = structuredClone(publicationInstance);
  (protectedBoard.connectors![1]!.configuration.resources as any[])[0]!.board_id = "100";
  assert.throws(() => compileSprintRuntimes({ workspace: publicationWorkspace, instance: protectedBoard, coreCommit: "core", workspaceCommit: "workspace", workbenchVersion: "0.1.0-experimental.15" }), /protected Monday board/);
});

test("Sprint snapshots join provider subjects to stable roster ids without display-name matching", () => {
  const snapshot = normalizeSprintSnapshot({
    roster: [
      { id: "alex", role: "contributor", name: "Alex", status: "active", mayApprove: [], principals: ["slack:T1:U1", "monday:A1:101"], groups: ["sprint-participant"] },
      { id: "blair", role: "contributor", name: "Blair", status: "active", mayApprove: [], principals: ["slack:T1:U2", "monday:A1:102"], groups: ["sprint-participant"] },
    ],
    compiled,
    participantRows: [
      { instance_id: "fixture", projection_id: "participants", record_id: "role-1", record_type: "role", source_version_id: "pv1", projected_at: "2030-01-28T08:00:00.000Z", values: { person_ids: ["101", "102"], role: "Delivery" } },
    ],
    workItemRows: [
      { instance_id: "fixture", projection_id: "sprint-items", record_id: "work-1", record_type: "work-item", source_version_id: "wv1", projected_at: "2030-01-28T08:00:00.000Z", values: { work_item_id: "work-1", title: "Ship", assignee_ids: ["102"], group: "current", status: "working", planned_effort: "0 hours", actual_hours: "not available", provider_version: "wv1" } },
      { instance_id: "fixture", projection_id: "sprint-items", record_id: "work-2", record_type: "work-item", source_version_id: "wv2", projected_at: "2030-01-28T08:00:00.000Z", values: { work_item_id: "work-2", title: "Unclassified", assignee_ids: [], group: "backlog", provider_version: "wv2" } },
    ],
    observedAt: "2030-01-28T08:00:00.000Z",
    participantSourceVersion: "roles-v1",
    workItemSourceVersion: "items-v1",
  });
  assert.deepEqual(snapshot.participants.map((participant) => [participant.participant_id, participant.roles]), [["alex", ["Delivery"]], ["blair", ["Delivery"]]]);
  assert.deepEqual(snapshot.workItems.map((item) => [item.work_item_id, item.assignee_ids, item.status]), [
    ["work-1", ["blair"], "working"],
    ["work-2", [], ""],
  ]);
  assert.equal(snapshot.workItems[0].planned_effort, undefined);
  assert.equal(snapshot.workItems[0].actual_hours, undefined);
  assert.throws(() => normalizeSprintSnapshot({
    roster: [{ id: "alex", role: "contributor", name: "Blair", status: "active", mayApprove: [], principals: ["slack:T1:U1"], groups: ["sprint-participant"] }],
    compiled,
    participantRows: [{ instance_id: "fixture", projection_id: "participants", record_id: "role-1", record_type: "role", source_version_id: "pv1", projected_at: "2030-01-28T08:00:00.000Z", values: { person_ids: ["101"], role: "Delivery" } }],
    workItemRows: [],
    observedAt: "2030-01-28T08:00:00.000Z",
    participantSourceVersion: "roles-v1",
    workItemSourceVersion: "items-v1",
  }), /no verified role projection mapping/);
});

test("hosted Sprint operator and scheduler surfaces require separate exact secrets", () => {
  const operator = new Request("https://fixture.test/api/sprint/operator", {
    headers: { authorization: "Bearer operator-secret" },
  });
  const scheduler = new Request("https://fixture.test/api/sprint/timers", {
    headers: { authorization: "Bearer cron-secret" },
  });
  const environment = {
    COMPANYOS_SPRINT_OPERATOR_SECRET: "operator-secret",
    CRON_SECRET: "cron-secret",
  } as NodeJS.ProcessEnv;
  assert.equal(authorizeSprintOperator(operator, environment), true);
  assert.equal(authorizeSprintScheduler(operator, environment), false);
  assert.equal(authorizeSprintScheduler(scheduler, environment), true);
  assert.equal(authorizeSprintOperator(scheduler, environment), false);
  assert.equal(authorizeSprintOperator(new Request("https://fixture.test"), environment), false);

  assert.deepEqual(parseSprintOperatorRequest(JSON.stringify({
    action: "open",
    definition_id: "weekly-delivery",
    sprint_id: "sprint-5",
    period_start: "2030-01-28",
    period_end: "2030-02-01",
    opened_at: "2030-01-28T09:00:00.000Z",
    excluded_participant_ids: ["blair"],
  })), {
    action: "open",
    definitionId: "weekly-delivery",
    sprintId: "sprint-5",
    periodStart: "2030-01-28",
    periodEnd: "2030-02-01",
    openedAt: "2030-01-28T09:00:00.000Z",
    excludedParticipantIds: ["blair"],
  });
  assert.throws(() => parseSprintOperatorRequest('{"action":"open","sprint_id":"x","period_start":"2030-01-28","period_end":"2030-02-01","opened_at":"2030-01-28T09:00:00.000Z","extra":true}'), /unsupported field/);
  assert.deepEqual(parseSprintOperatorRequest(JSON.stringify({
    action: "replay",
    definition_id: "weekly-delivery",
    replay_id: "historical-week-1",
    sprint_id: "sprint-1",
    period_start: "2030-01-28",
    period_end: "2030-02-01",
    excluded_participant_ids: ["blair"],
  })), {
    action: "replay",
    definitionId: "weekly-delivery",
    replayId: "historical-week-1",
    sprintId: "sprint-1",
    periodStart: "2030-01-28",
    periodEnd: "2030-02-01",
    excludedParticipantIds: ["blair"],
  });
  assert.deepEqual(parseSprintOperatorRequest(JSON.stringify({
    action: "publish-replay",
    definition_id: "weekly-delivery",
    replay_id: "historical-week-1",
    sprint_id: "sprint-1",
    period_start: "2030-01-28",
    period_end: "2030-02-01",
    excluded_participant_ids: [],
    expected_output_digest: "a".repeat(64),
  })), {
    action: "publish-replay",
    definitionId: "weekly-delivery",
    replayId: "historical-week-1",
    sprintId: "sprint-1",
    periodStart: "2030-01-28",
    periodEnd: "2030-02-01",
    excludedParticipantIds: [],
    expectedOutputDigest: "a".repeat(64),
  });
  assert.throws(() => parseSprintOperatorRequest(JSON.stringify({
    action: "publish-replay",
    replay_id: "historical-week-1",
    sprint_id: "sprint-1",
    period_start: "2030-01-28",
    period_end: "2030-02-01",
    expected_output_digest: "not-a-digest",
  })), /exact SHA-256 digest|expected_output_digest is invalid/);
});
