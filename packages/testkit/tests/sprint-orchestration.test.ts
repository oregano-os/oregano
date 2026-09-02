import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { BusinessCalendar } from "../../domains/sprint/business-time.ts";
import type { SprintDomainDeclaration, SprintEvent, SprintParticipant, SprintWorkItem } from "../../domains/sprint/contracts.ts";
import { DurableTimerService } from "../../runtime/durable-timers.ts";
import { InMemoryDurableTimerStore } from "../../runtime/memory-durable-timers.ts";
import { InMemorySprintOrchestrationStore } from "../../runtime/memory-sprint-orchestration.ts";
import {
  CompanyOSSprintIntentDispatcher,
  SprintOrchestrationService,
  type SprintIntentDispatcher,
} from "../../runtime/sprint-orchestration.ts";

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
];
const workItems: SprintWorkItem[] = [
  { work_item_id: "item-a", title: "Alpha", assignee_ids: ["person-a"], group: "current", status: "working", actual_hours: 3, provider_version: "version-a", fields: {} },
  { work_item_id: "item-b", title: "Beta", assignee_ids: ["person-b"], group: "current", status: "done", actual_hours: 2, provider_version: "version-b", fields: {} },
];

const fixture = () => {
  const store = new InMemorySprintOrchestrationStore();
  const timerStore = new InMemoryDurableTimerStore();
  const timers = new DurableTimerService({ store: timerStore, instanceId: "fixture-instance" });
  const service = new SprintOrchestrationService({ instanceId: "fixture-instance", policy, calendar, store, timers });
  return { store, timerStore, timers, service };
};

const opened: Extract<SprintEvent, { type: "sprint.opened" }> = {
  type: "sprint.opened",
  event_id: "open-sprint-5",
  occurred_at: "2030-01-28T09:00:00.000Z",
  sprint_id: "sprint-5",
  period_start: "2030-01-28",
  period_end: "2030-02-01",
};

async function prepare(service: SprintOrchestrationService): Promise<void> {
  await service.openSprint({ event: opened, nextSprintId: "sprint-6" });
  await service.processEvent({ type: "participants.observed", event_id: "participants-1", occurred_at: "2030-01-28T09:01:00.000Z", participants });
  await service.processEvent({ type: "work-items.observed", event_id: "items-1", occurred_at: "2030-01-28T09:02:00.000Z", work_items: workItems });
}

test("Sprint orchestration persists one immutable outcome and suppresses duplicate events", async () => {
  const { service, store } = fixture();
  const first = await service.openSprint({ event: opened, nextSprintId: "sprint-6" });
  const duplicate = await service.openSprint({ event: opened, nextSprintId: "sprint-6" });
  assert.equal(first.status, "applied");
  assert.equal(duplicate.status, "duplicate");
  assert.equal(first.outcome.stateVersion, 1);
  assert.deepEqual(duplicate.outcome, first.outcome);
  assert.equal(store.events.size, 1);
  assert.equal(store.states.get("fixture-instance\0weekly-delivery")?.stateVersion, 1);
  assert.deepEqual(first.timers, { scheduled: 3, existing: 0 });
  assert.deepEqual(duplicate.timers, { scheduled: 0, existing: 3 });
  await assert.rejects(() => service.processEvent({ ...opened, sprint_id: "different-sprint" }), /conflicts with its durable identity/);
});

test("concurrent different events retry optimistic state conflicts without losing either event", async () => {
  const { service, store } = fixture();
  await service.openSprint({ event: opened });
  const original = store.commitEvent.bind(store);
  let barrier = 0;
  store.commitEvent = async (args) => {
    barrier += 1;
    if (barrier <= 2) await new Promise((resolve) => setTimeout(resolve, 5));
    return original(args);
  };
  const [people, items] = await Promise.all([
    service.processEvent({ type: "participants.observed", event_id: "participants-1", occurred_at: "2030-01-28T09:01:00.000Z", participants }),
    service.processEvent({ type: "work-items.observed", event_id: "items-1", occurred_at: "2030-01-28T09:01:00.000Z", work_items: workItems }),
  ]);
  assert.equal(people.status, "applied");
  assert.equal(items.status, "applied");
  assert.equal((await store.getState({ instanceId: "fixture-instance", definitionId: "weekly-delivery" }))?.stateVersion, 3);
  assert.equal(store.events.size, 3);
});

test("due timers become durable clock events and a replay completes without duplicate intents", async () => {
  const { service, store, timerStore } = fixture();
  await prepare(service);
  const reminder = await service.processDueTimers({
    now: "2030-02-01T14:00:00.000Z",
    owner: "timer-worker",
    leaseToken: "timer-lease-1",
    leaseExpiresAt: "2030-02-01T14:05:00.000Z",
  });
  assert.deepEqual(reminder.map((result) => result.status), ["applied"]);
  assert.equal(store.intents.size, 2);
  assert.equal([...timerStore.rows.values()].filter((timer) => timer.state === "completed").length, 1);
  const replay = await service.processEvent({
    type: "clock.reached",
    event_id: reminder[0].timerId.startsWith("timer:") ? reminder[0].timerId : `timer:${reminder[0].timerId}`,
    occurred_at: "2030-02-01T14:00:00.000Z",
    instant: "2030-02-01T14:00:00.000Z",
    next_sprint_id: "sprint-6",
  });
  assert.equal(replay.status, "duplicate");
  assert.equal(store.intents.size, 2);
});

test("intent dispatch is disabled without an exact dispatcher and preserves lease outcomes", async () => {
  const { service, store } = fixture();
  await prepare(service);
  await service.processDueTimers({
    now: "2030-02-01T14:00:00.000Z",
    owner: "timer-worker",
    leaseToken: "timer-lease",
    leaseExpiresAt: "2030-02-01T14:05:00.000Z",
  });
  await assert.rejects(() => service.dispatchIntents({
    now: "2030-02-01T14:01:00.000Z",
    owner: "intent-worker",
    leaseToken: "intent-lease",
    leaseExpiresAt: "2030-02-01T14:06:00.000Z",
  }), /disabled/);
  const dispatcher: SprintIntentDispatcher = {
    async dispatch({ claimed }) {
      if (claimed.intent.type === "message.reminder" && claimed.intent.participant_id === "person-b") throw new Error("synthetic delivery failure");
      return {
        dispatcherId: "fixture-dispatcher",
        executionId: `fixture:${claimed.intent.intent_id}`,
        outcomeDigest: "a".repeat(64),
      };
    },
  };
  const results = await service.dispatchIntents({
    now: "2030-02-01T14:01:00.000Z",
    owner: "intent-worker",
    leaseToken: "intent-lease",
    leaseExpiresAt: "2030-02-01T14:06:00.000Z",
    dispatcher,
  });
  assert.deepEqual(results.map((result) => result.status).sort(), ["failed", "succeeded"]);
  assert.equal([...store.intents.values()].filter((row) => row.state === "succeeded").length, 1);
  assert.equal([...store.intents.values()].filter((row) => row.state === "failed").length, 1);
});

test("intent leases reject stale workers and preserve explicit retry and cancellation", async () => {
  const { service, store } = fixture();
  await prepare(service);
  await service.processDueTimers({
    now: "2030-02-01T14:00:00.000Z",
    owner: "timer-worker",
    leaseToken: "timer-lease",
    leaseExpiresAt: "2030-02-01T14:05:00.000Z",
  });
  const claimed = await store.claimIntents({
    instanceId: "fixture-instance",
    definitionId: "weekly-delivery",
    now: "2030-02-01T14:01:00.000Z",
    owner: "worker-a",
    leaseToken: "lease-a",
    leaseExpiresAt: "2030-02-01T14:06:00.000Z",
    limit: 1,
  });
  assert.equal(claimed.length, 1);
  assert.equal(await store.completeIntent({
    instanceId: "fixture-instance",
    definitionId: "weekly-delivery",
    intentId: claimed[0].intent.intent_id,
    leaseToken: "stale-lease",
    evidence: null,
    completedAt: "2030-02-01T14:02:00.000Z",
  }), false);
  assert.equal(await store.retryIntent({
    instanceId: "fixture-instance",
    definitionId: "weekly-delivery",
    intentId: claimed[0].intent.intent_id,
    leaseToken: "lease-a",
    availableAt: "2030-02-01T14:10:00.000Z",
    evidence: { reason: "synthetic-transient" },
    retriedAt: "2030-02-01T14:02:00.000Z",
  }), true);
  const pending = [...store.intents.values()].find((row) => row.state === "pending" && row.intent.intent_id !== claimed[0].intent.intent_id);
  assert.ok(pending);
  assert.equal(await store.cancelIntent({
    instanceId: "fixture-instance",
    definitionId: "weekly-delivery",
    intentId: pending.intent.intent_id,
    evidence: { reason: "synthetic-cancel" },
    cancelledAt: "2030-02-01T14:02:00.000Z",
  }), true);
  assert.equal([...store.intents.values()].filter((row) => row.state === "cancelled").length, 1);
});

test("CompanyOS dispatcher resolves exact Agent and grant before invoking the normal runtime", async () => {
  const calls: unknown[] = [];
  const dispatcher = new CompanyOSSprintIntentDispatcher({
    runtime: { async execute(request) { calls.push(request); return { ok: true }; } },
    resolver: {
      async resolve({ intent }) {
        assert.equal(intent.type, "message.reminder");
        return { agentId: "sprint", grantId: "oregano:communications/publish", input: { destination_binding: "sprint-direct", content: "Synthetic reminder" } };
      },
    },
  });
  const dispatchEvidence = await dispatcher.dispatch({
    instanceId: "fixture-instance",
    definitionId: "weekly-delivery",
    state: { sprint_id: "sprint-5", period_start: "2030-01-28", period_end: "2030-02-01", phase: "open", participants: {}, work_items: {}, submissions: {}, processed_event_ids: [], last_event_at: null },
    claimed: {
      instanceId: "fixture-instance",
      definitionId: "weekly-delivery",
      intent: { type: "message.reminder", intent_id: "intent-1", participant_id: "person-a", destination_principal: "chat:fixture:person-a", destination_binding: "sprint-direct", due_at: "2030-02-01T14:00:00.000Z", reason: "initial" },
      leaseOwner: "worker",
      leaseToken: "lease",
      leaseExpiresAt: "2030-02-01T14:05:00.000Z",
      attempts: 1,
    },
  });
  assert.deepEqual(calls, [{
    agentId: "sprint",
    grantId: "oregano:communications/publish",
    input: { destination_binding: "sprint-direct", content: "Synthetic reminder" },
    runId: "sprint:weekly-delivery:sprint-5",
    stepId: "intent:intent-1",
  }]);
  assert.deepEqual(dispatchEvidence, {
    dispatcherId: "companyos-runtime",
    executionId: "sprint:weekly-delivery:sprint-5/intent:intent-1",
    outcomeDigest: "4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93",
  });
});

test("reminder decisions fail closed when a direct-message identity or binding is absent", async () => {
  const missingDirect = structuredClone(policy);
  delete missingDirect.delivery.direct_binding;
  const store = new InMemorySprintOrchestrationStore();
  const service = new SprintOrchestrationService({ instanceId: "fixture-instance", policy: missingDirect, calendar, store });
  await service.processEvent(opened);
  await service.processEvent({ type: "participants.observed", event_id: "participants-1", occurred_at: "2030-01-28T09:01:00.000Z", participants });
  await service.processEvent({ type: "work-items.observed", event_id: "items-1", occurred_at: "2030-01-28T09:02:00.000Z", work_items: workItems });
  await assert.rejects(() => service.processEvent({ type: "clock.reached", event_id: "clock-reminder", occurred_at: "2030-02-01T14:00:00.000Z", instant: "2030-02-01T14:00:00.000Z" }), /direct-message principal and binding/);
  assert.equal(store.events.size, 3);
  assert.equal(store.intents.size, 0);
});

test("Postgres Sprint orchestration uses one atomic event commit and leased bounded dispatch", () => {
  const source = readFileSync(new URL("../../state-postgres/sprint-orchestration-store.ts", import.meta.url), "utf8");
  assert.match(source, /with new_intents as \([\s\S]*state_written as \([\s\S]*event_written as \([\s\S]*intents_written as \(/);
  assert.match(source, /where companyos_records\.sprint_states\.state_version = \$\{args\.expectedStateVersion\}/);
  assert.match(source, /for update skip locked/);
  assert.match(source, /state = 'leased' and lease_token = \$\{args\.leaseToken\}/);
  assert.doesNotMatch(source, /MONDAY_|SLACK_|VERCEL_|NEON_/);
});
