import type { JsonValue } from "../capabilities/contracts.ts";
import type { BusinessCalendar } from "../domains/sprint/business-time.ts";
import type {
  SprintDecision,
  SprintDomainDeclaration,
  SprintEvent,
  SprintIntent,
  SprintState,
} from "../domains/sprint/contracts.ts";
import { decideSprintEvent } from "../domains/sprint/decisions.ts";
import { initialSprintState } from "../domains/sprint/reducer.ts";
import { scheduleSprintCloseTimers } from "../domains/sprint/timers.ts";
import type { ClaimedDurableTimer } from "../state-store/durable-timers.ts";
import type {
  ClaimedSprintIntent,
  SprintOrchestrationStore,
  StoredSprintEvent,
} from "../state-store/sprint-orchestration.ts";
import type { ExecuteToolRequest } from "./companyos-runtime.ts";
import { sha256 } from "./canonical.ts";
import type { DurableTimerService } from "./durable-timers.ts";

const identifier = /^[a-z][a-z0-9-]{1,62}$/;
const iso = (value: string, label: string): void => {
  if (!value || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be an exact ISO timestamp`);
  }
};
const date = (value: string, label: string): void => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be an exact calendar date`);
  }
};
const text = (value: string, label: string, maximum = 255): void => {
  if (!value || value.length > maximum) throw new Error(`${label} must contain 1 to ${maximum} characters`);
};
const boundedLimit = (value: number | undefined, fallback: number, maximum: number, label: string): number => {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  }
  return resolved;
};
const errorEvidence = (error: unknown): { error_type: string; error_digest: string } => {
  const message = error instanceof Error ? error.message : String(error);
  return {
    error_type: (error instanceof Error && error.name ? error.name : "Error").slice(0, 127),
    error_digest: sha256(message),
  };
};

export interface SprintDispatchEvidence {
  dispatcherId: string;
  executionId: string;
  outcomeDigest: string;
  receiptIds?: string[];
}

function assertDispatchEvidence(evidence: SprintDispatchEvidence): void {
  text(evidence.dispatcherId, "Sprint dispatcher id", 127);
  text(evidence.executionId, "Sprint execution id", 255);
  if (!/^[a-f0-9]{64}$/.test(evidence.outcomeDigest)) throw new Error("Sprint dispatch outcome digest is invalid");
  if ((evidence.receiptIds?.length ?? 0) > 100) throw new Error("Sprint dispatch receipt ids exceed the supported limit");
  for (const receiptId of evidence.receiptIds ?? []) text(receiptId, "Sprint dispatch receipt id", 255);
}

function assertPolicyAndCalendar(policy: SprintDomainDeclaration, calendar: BusinessCalendar): void {
  if (policy.schema_version !== 1 || !identifier.test(policy.id)) throw new Error("Sprint policy identity is invalid");
  if (calendar.id !== policy.calendar.business_calendar_ref) throw new Error("Sprint business calendar does not match the reviewed policy reference");
  new Intl.DateTimeFormat("en", { timeZone: policy.calendar.timezone }).format();
  if (!(policy.close.reminder_time < policy.close.complete_by && policy.close.complete_by <= policy.close.report_at)) {
    throw new Error("Sprint close times must satisfy reminder_time < complete_by <= report_at");
  }
  const uniqueHolidays = new Set(calendar.holidays);
  if (uniqueHolidays.size !== calendar.holidays.length || calendar.holidays.length > 2_000) throw new Error("Sprint holidays must be unique and bounded");
  for (const holiday of calendar.holidays) date(holiday, "Sprint holiday");
}

function assertEvent(event: SprintEvent, state: SprintState): void {
  text(event.event_id, "Sprint event id", 255);
  iso(event.occurred_at, "Sprint event occurred_at");
  if (state.last_event_at && event.occurred_at < state.last_event_at) throw new Error("Sprint event is older than the current durable state");
  if (event.type === "sprint.opened") {
    text(event.sprint_id, "Sprint id", 255);
    date(event.period_start, "Sprint period_start");
    date(event.period_end, "Sprint period_end");
    if (event.period_start > event.period_end) throw new Error("Sprint period_start must not follow period_end");
    if (state.sprint_id && state.phase !== "closed" && state.sprint_id !== event.sprint_id) {
      throw new Error(`Cannot open Sprint '${event.sprint_id}' while '${state.sprint_id}' is active`);
    }
    return;
  }
  if (!state.sprint_id) throw new Error(`Sprint event '${event.type}' requires an open Sprint`);
  if (event.type === "participants.observed") {
    if (event.participants.length > 2_000) throw new Error("Sprint participant snapshot exceeds the supported limit");
    const ids = new Set<string>();
    for (const participant of event.participants) {
      text(participant.participant_id, "Sprint participant id", 255);
      text(participant.display_name, "Sprint participant display name", 255);
      if (ids.has(participant.participant_id)) throw new Error(`Duplicate Sprint participant '${participant.participant_id}'`);
      ids.add(participant.participant_id);
    }
  } else if (event.type === "work-items.observed") {
    if (event.work_items.length > 50_000) throw new Error("Sprint work-item snapshot exceeds the supported limit");
    const ids = new Set<string>();
    for (const item of event.work_items) {
      text(item.work_item_id, "Sprint work-item id", 255);
      text(item.provider_version, "Sprint work-item provider version", 255);
      if (ids.has(item.work_item_id)) throw new Error(`Duplicate Sprint work item '${item.work_item_id}'`);
      ids.add(item.work_item_id);
    }
  } else if (event.type === "submission.received") {
    text(event.submission_id, "Sprint submission id", 255);
    if (!state.participants[event.participant_id]) throw new Error(`Unknown Sprint participant '${event.participant_id}'`);
    if (event.task_ids.length > 10_000 || new Set(event.task_ids).size !== event.task_ids.length) {
      throw new Error("Sprint submission task ids must be unique and bounded");
    }
  } else if (event.type === "clock.reached") {
    iso(event.instant, "Sprint clock instant");
  } else if (event.sprint_id !== state.sprint_id) {
    throw new Error(`Sprint close identity '${event.sprint_id}' does not match active Sprint '${state.sprint_id}'`);
  }
}

export interface SprintEventResult {
  status: "applied" | "duplicate";
  outcome: StoredSprintEvent;
}

export interface SprintIntentDispatcher {
  dispatch(args: {
    instanceId: string;
    definitionId: string;
    state: SprintState;
    claimed: ClaimedSprintIntent;
  }): Promise<SprintDispatchEvidence>;
}

export interface SprintToolExecutionResolver {
  resolve(args: {
    instanceId: string;
    definitionId: string;
    state: SprintState;
    intent: SprintIntent;
  }): Promise<Pick<ExecuteToolRequest, "agentId" | "grantId" | "input" | "subjectPrincipal" | "approvingPrincipal">>;
}

type ToolRuntime = { execute(request: ExecuteToolRequest): Promise<unknown> };

/** Keeps company rendering outside Core while preserving the normal Tool boundary. */
export class CompanyOSSprintIntentDispatcher implements SprintIntentDispatcher {
  readonly runtime: ToolRuntime;
  readonly resolver: SprintToolExecutionResolver;

  constructor(args: { runtime: ToolRuntime; resolver: SprintToolExecutionResolver }) {
    this.runtime = args.runtime;
    this.resolver = args.resolver;
  }

  async dispatch(args: {
    instanceId: string;
    definitionId: string;
    state: SprintState;
    claimed: ClaimedSprintIntent;
  }): Promise<SprintDispatchEvidence> {
    if (!args.state.sprint_id) throw new Error("A claimed Sprint intent has no active Sprint identity");
    const request = await this.resolver.resolve({
      instanceId: args.instanceId,
      definitionId: args.definitionId,
      state: structuredClone(args.state),
      intent: structuredClone(args.claimed.intent),
    });
    if (!request.agentId || !request.grantId) throw new Error("Sprint intent execution did not resolve an exact Agent and Tool grant");
    const runId = `sprint:${args.definitionId}:${args.state.sprint_id}`;
    const stepId = `intent:${args.claimed.intent.intent_id}`;
    const outcome = await this.runtime.execute({
      ...request,
      runId,
      stepId,
    });
    return {
      dispatcherId: "companyos-runtime",
      executionId: `${runId}/${stepId}`,
      outcomeDigest: sha256(outcome),
    };
  }
}

export class SprintOrchestrationService {
  readonly instanceId: string;
  readonly policy: SprintDomainDeclaration;
  readonly calendar: BusinessCalendar;
  readonly store: SprintOrchestrationStore;
  readonly timers?: DurableTimerService;

  constructor(args: {
    instanceId: string;
    policy: SprintDomainDeclaration;
    calendar: BusinessCalendar;
    store: SprintOrchestrationStore;
    timers?: DurableTimerService;
  }) {
    text(args.instanceId, "Company Instance id", 127);
    assertPolicyAndCalendar(args.policy, args.calendar);
    if (args.timers && args.timers.instanceId !== args.instanceId) throw new Error("Sprint timers and state must belong to the same Company Instance");
    this.instanceId = args.instanceId;
    this.policy = structuredClone(args.policy);
    this.calendar = structuredClone(args.calendar);
    this.store = args.store;
    this.timers = args.timers;
  }

  private get key() {
    return { instanceId: this.instanceId, definitionId: this.policy.id };
  }

  async processEvent(event: SprintEvent): Promise<SprintEventResult> {
    const prior = await this.store.getEvent(this.key, event.event_id);
    if (prior) {
      if (sha256(prior.event) !== sha256(event)) throw new Error(`Sprint event '${event.event_id}' conflicts with its durable identity`);
      return { status: "duplicate", outcome: prior };
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const stored = await this.store.getState(this.key);
      const state = stored?.state ?? initialSprintState();
      assertEvent(event, state);
      const decision: SprintDecision = decideSprintEvent({
        state,
        event: structuredClone(event),
        policy: this.policy,
        calendar: this.calendar,
      });
      if (decision.intents.length > 50_100 || new Set(decision.intents.map((intent) => intent.intent_id)).size !== decision.intents.length) {
        throw new Error("Sprint decision intent identities must be unique and bounded");
      }
      if (decision.evidence.length > 100) throw new Error("Sprint decision evidence exceeds the supported limit");
      const committed = await this.store.commitEvent({
        ...this.key,
        expectedStateVersion: stored?.stateVersion ?? 0,
        event: structuredClone(event),
        decision,
        committedAt: event.occurred_at,
      });
      if (committed.status !== "conflict") {
        if (sha256(committed.outcome.event) !== sha256(event)) throw new Error(`Sprint event '${event.event_id}' conflicts with its durable identity`);
        return { status: committed.status, outcome: committed.outcome };
      }
      const duplicate = await this.store.getEvent(this.key, event.event_id);
      if (duplicate) {
        if (sha256(duplicate.event) !== sha256(event)) throw new Error(`Sprint event '${event.event_id}' conflicts with its durable identity`);
        return { status: "duplicate", outcome: duplicate };
      }
    }
    throw new Error("Sprint event state remained contended after eight optimistic retries");
  }

  async openSprint(args: {
    event: Extract<SprintEvent, { type: "sprint.opened" }>;
    nextSprintId?: string;
  }): Promise<SprintEventResult & { timers: { scheduled: number; existing: number } }> {
    if (!this.timers) throw new Error("Sprint opening requires a durable timer service");
    if (args.nextSprintId !== undefined) text(args.nextSprintId, "Next Sprint id", 255);
    const result = await this.processEvent(args.event);
    const timers = await scheduleSprintCloseTimers({
      timers: this.timers,
      policy: this.policy,
      calendar: this.calendar,
      sprintId: args.event.sprint_id,
      periodEnd: args.event.period_end,
      ...(args.nextSprintId ? { nextSprintId: args.nextSprintId } : {}),
    });
    return { ...result, timers };
  }

  async processDueTimers(args: {
    now: string;
    owner: string;
    leaseToken: string;
    leaseExpiresAt: string;
    limit?: number;
  }): Promise<Array<{ timerId: string; status: "applied" | "duplicate" | "failed"; stateVersion?: number; errorDigest?: string }>> {
    if (!this.timers) throw new Error("Sprint timer processing requires a durable timer service");
    iso(args.now, "Sprint timer worker now");
    iso(args.leaseExpiresAt, "Sprint timer lease expiry");
    text(args.owner, "Sprint timer lease owner", 127);
    text(args.leaseToken, "Sprint timer lease token", 255);
    if (args.leaseExpiresAt <= args.now) throw new Error("Sprint timer lease must expire after now");
    const claimed = await this.timers.claimDue({ ...args, limit: boundedLimit(args.limit, 50, 200, "Sprint timer claim limit") });
    const results: Array<{ timerId: string; status: "applied" | "duplicate" | "failed"; stateVersion?: number; errorDigest?: string }> = [];
    for (const timer of claimed) {
      try {
        const event = await this.eventFromTimer(timer, args.now);
        const result = await this.processEvent(event);
        const completed = await this.timers.complete(timer, {
          event_id: event.event_id,
          event_status: result.status,
          state_version: result.outcome.stateVersion,
        }, args.now);
        if (!completed) throw new Error(`Sprint timer '${timer.timerId}' lost its lease before completion`);
        results.push({ timerId: timer.timerId, status: result.status, stateVersion: result.outcome.stateVersion });
      } catch (error) {
        const failure = errorEvidence(error);
        await this.timers.fail(timer, failure, args.now);
        results.push({ timerId: timer.timerId, status: "failed", errorDigest: failure.error_digest });
      }
    }
    return results;
  }

  async dispatchIntents(args: {
    now: string;
    owner: string;
    leaseToken: string;
    leaseExpiresAt: string;
    dispatcher?: SprintIntentDispatcher;
    limit?: number;
  }): Promise<Array<{ intentId: string; status: "succeeded" | "failed"; errorDigest?: string }>> {
    if (!args.dispatcher) throw new Error("Sprint intent dispatch is disabled until an exact dispatcher is bound");
    iso(args.now, "Sprint intent worker now");
    iso(args.leaseExpiresAt, "Sprint intent lease expiry");
    text(args.owner, "Sprint intent lease owner", 127);
    text(args.leaseToken, "Sprint intent lease token", 255);
    if (args.leaseExpiresAt <= args.now) throw new Error("Sprint intent lease must expire after now");
    const stored = await this.store.getState(this.key);
    if (!stored) throw new Error("Sprint intent dispatch requires durable Sprint state");
    const claimed = await this.store.claimIntents({
      ...this.key,
      now: args.now,
      owner: args.owner,
      leaseToken: args.leaseToken,
      leaseExpiresAt: args.leaseExpiresAt,
      limit: boundedLimit(args.limit, 25, 100, "Sprint intent claim limit"),
    });
    const results: Array<{ intentId: string; status: "succeeded" | "failed"; errorDigest?: string }> = [];
    for (const item of claimed) {
      try {
        const evidence = await args.dispatcher.dispatch({
          ...this.key,
          state: structuredClone(stored.state),
          claimed: item,
        });
        assertDispatchEvidence(evidence);
        const completed = await this.store.completeIntent({
          ...this.key,
          intentId: item.intent.intent_id,
          leaseToken: item.leaseToken,
          evidence,
          completedAt: args.now,
        });
        if (!completed) throw new Error(`Sprint intent '${item.intent.intent_id}' lost its lease before completion`);
        results.push({ intentId: item.intent.intent_id, status: "succeeded" });
      } catch (error) {
        const failure = errorEvidence(error);
        await this.store.failIntent({
          ...this.key,
          intentId: item.intent.intent_id,
          leaseToken: item.leaseToken,
          evidence: failure,
          failedAt: args.now,
        });
        results.push({ intentId: item.intent.intent_id, status: "failed", errorDigest: failure.error_digest });
      }
    }
    return results;
  }

  private async eventFromTimer(timer: ClaimedDurableTimer, observedAt: string): Promise<Extract<SprintEvent, { type: "clock.reached" }>> {
    if (timer.timerKind !== "sprint.clock-reached") throw new Error(`Unsupported Sprint timer kind '${timer.timerKind}'`);
    if (!timer.payload || typeof timer.payload !== "object" || Array.isArray(timer.payload)) throw new Error("Sprint timer payload must be an object");
    const payload = timer.payload as Record<string, JsonValue>;
    const instant = String(payload.instant ?? "");
    const sprintId = String(payload.sprint_id ?? "");
    iso(instant, "Sprint timer instant");
    if (instant !== timer.dueAt) throw new Error("Sprint timer instant does not match its durable due_at");
    const stored = await this.store.getState(this.key);
    if (!stored?.state.sprint_id || stored.state.sprint_id !== sprintId) throw new Error("Sprint timer does not match the active durable Sprint");
    const nextSprintId = payload.next_sprint_id === undefined ? undefined : String(payload.next_sprint_id);
    if (nextSprintId !== undefined) text(nextSprintId, "Next Sprint id", 255);
    return {
      type: "clock.reached",
      event_id: `timer:${timer.timerId}`,
      occurred_at: observedAt,
      instant,
      ...(nextSprintId ? { next_sprint_id: nextSprintId } : {}),
    };
  }
}
