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
} from "../../runtime/sprint-host.ts";
import { normalizeSprintSnapshot } from "../../runtime/sprint-snapshot.ts";
import { renderSprintMessageIntent } from "../../runtime/sprint-intent-renderer.ts";
import {
  authorizeSprintOperator,
  authorizeSprintScheduler,
  executeSprintOperator,
  parseSprintOperatorRequest,
  scheduledSprintRuntimeDefinitions,
  stabilizeSprintProjection,
} from "../../runner-vercel/src/lib/sprint-runtime.ts";

const compiled: CompiledSprintRuntime = {
  definitionId: "weekly-delivery",
  agentId: "sprint",
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
    provenance: { instanceId: "fixture", coreCommit: "core", workspaceCommit: "workspace", workbenchVersion: "0.5.5" },
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
  assert.deepEqual((await host.dispatchIntents({ now: "2030-02-01T17:03:00.000Z", owner: "intent", leaseToken: "intent-5", leaseExpiresAt: "2030-02-01T17:07:00.000Z" })).map((entry) => entry.status), ["succeeded", "succeeded"]);
  const state = (await store.getState({ instanceId: "fixture", definitionId: "weekly-delivery" }))!.state;
  assert.equal(state.close_thread_reference, root);
  assert.deepEqual(Object.values(state.deliveries).map((entry) => entry.purpose).sort(), ["close-chase", "close-reminder", "close-report", "retro"]);
  assert.deepEqual([...store.intents.values()].map((row) => row.intent.type).sort(), [
    "message.close-chase", "message.close-reminder", "message.close-report", "message.retro", "work-item.rollover", "work-item.rollover",
  ]);
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
  const resolver = new CompiledSprintToolExecutionResolver(compiled);
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
    sprintRuntimes: [{ definitionId: "weekly-delivery", agentId: "sprint", servicePrincipal: "companyos:fixture:sprint", participantIdentityPrefix: "monday:A1:", directDestinations: { "slack:T1:U1": "direct-alex" } }],
  };
  const runtimes = compileSprintRuntimes({ workspace, instance, coreCommit: "core-commit", workspaceCommit: "workspace-commit", workbenchVersion: "0.5.5" });
  assert.equal(runtimes.length, 1);
  assert.equal(runtimes[0].modelTask, "sprint.coordination");
  assert.equal(runtimes[0].schedule.provenance.instanceId, "fixture");
  assert.deepEqual(runtimes[0].schedule.triggers.map((trigger) => trigger.holidayShift), [
    "previous-business-day",
    "previous-business-day",
    "previous-business-day",
  ]);
  assert.equal(runtimes[0].templates.reminder.content, "Post in this thread for {{sprint_id}}");
  const missingDestination = structuredClone(instance);
  missingDestination.connectors![0].configuration.destinations = [];
  assert.throws(() => compileSprintRuntimes({ workspace, instance: missingDestination, coreCommit: "core", workspaceCommit: "workspace", workbenchVersion: "0.5.5" }), /channel binding/);
  const missingParticipantDm = structuredClone(instance);
  missingParticipantDm.sprintRuntimes![0].directDestinations = {};
  assert.throws(() => compileSprintRuntimes({ workspace, instance: missingParticipantDm, coreCommit: "core", workspaceCommit: "workspace", workbenchVersion: "0.5.5" }), /lacks an exact direct-message destination binding/);
  const unknownPlaceholder = structuredClone(workspace);
  unknownPlaceholder.allFiles["workflows/sprint/reminder.md"] = "Hi {{company_secret}}";
  assert.throws(() => compileSprintRuntimes({ workspace: unknownPlaceholder, instance, coreCommit: "core", workspaceCommit: "workspace", workbenchVersion: "0.5.5" }), /unsupported placeholder/);
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
      { instance_id: "fixture", projection_id: "sprint-items", record_id: "work-1", record_type: "work-item", source_version_id: "wv1", projected_at: "2030-01-28T08:00:00.000Z", values: { work_item_id: "work-1", title: "Ship", assignee_ids: ["102"], group: "current", status: "working", provider_version: "wv1" } },
    ],
    observedAt: "2030-01-28T08:00:00.000Z",
    participantSourceVersion: "roles-v1",
    workItemSourceVersion: "items-v1",
  });
  assert.deepEqual(snapshot.participants.map((participant) => [participant.participant_id, participant.roles]), [["alex", ["Delivery"]], ["blair", ["Delivery"]]]);
  assert.deepEqual(snapshot.workItems[0].assignee_ids, ["blair"]);
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
});
