import type { BusinessCalendar } from "../domains/sprint/business-time.ts";
import { addCalendarDays, sprintCloseSchedule, zonedLocalDateTimeToIso } from "../domains/sprint/business-time.ts";
import { buildSprintCloseReadModel } from "../domains/sprint/read-models.ts";
import type { SprintDomainDeclaration, SprintEvent, SprintIntent, SprintState } from "../domains/sprint/contracts.ts";
import type { RecordProjectionRow } from "../records/contracts.ts";
import type { DerivedRecordEnvelope } from "../records/derived-record.ts";
import type { SprintOrchestrationStore } from "../state-store/sprint-orchestration.ts";
import { sha256 } from "./canonical.ts";
import { DurableTimerService } from "./durable-timers.ts";
import { InMemoryDurableTimerStore } from "./memory-durable-timers.ts";
import { InMemorySprintOrchestrationStore } from "./memory-sprint-orchestration.ts";
import { deriveHistoricalSprintSubmission, isFridaySprintUpdate } from "./sprint-slack-submission.ts";
import { sprintMessageLifecycleEvents, SprintOrchestrationService, type SprintDispatchEvidence, type SprintIntentDispatcher } from "./sprint-orchestration.ts";
import type { SprintSnapshot } from "./sprint-host.ts";

export interface SprintReplayOutputPolicy {
  mode: "proof-only" | "test-only";
  communication_binding: string;
  work_item_binding?: string;
  test_only: true;
  forbidden_bindings: string[];
}

export interface SprintReplayInput {
  replayId: string;
  sprintId: string;
  periodStart: string;
  periodEnd: string;
  messageProjectionId: string;
  messages: RecordProjectionRow[];
  principalByProviderAuthor: Record<string, string>;
  snapshot: SprintSnapshot;
  policy: SprintDomainDeclaration;
  calendar: BusinessCalendar;
  output: SprintReplayOutputPolicy;
}

export interface SprintReplayIgnoredMessage {
  record_id: string;
  reason: "outside-period" | "after-report" | "not-sprint-update" | "unresolved-author" | "invalid-submission";
  error_digest?: string;
}

export interface SprintReplayReport {
  schema_version: 1;
  replay_id: string;
  sprint_id: string;
  period_start: string;
  period_end: string;
  mode: SprintReplayOutputPolicy["mode"];
  definition_id: string;
  controlled_clock_completed_at: string;
  input_digest: string;
  submission_records: DerivedRecordEnvelope<Record<string, import("../capabilities/contracts.ts").JsonValue>>[];
  ignored_messages: SprintReplayIgnoredMessage[];
  participant_states: Record<string, "complete" | "needs-reformat" | "missing">;
  open_work_item_ids: string[];
  total_effort_hours: number | null;
  limitations: string[];
  final_phase: SprintState["phase"];
  output_digest: string;
}

const identifier = /^[a-z][a-z0-9-]{1,62}$/;
const exactDate = (value: string, label: string): void => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be an exact calendar date`);
  }
};
const text = (value: string, label: string, maximum = 255): void => {
  if (!value || value.length > maximum) throw new Error(`${label} must contain 1 to ${maximum} characters`);
};
const leaseExpiry = (instant: string): string => new Date(Date.parse(instant) + 5 * 60_000).toISOString();

const messageValue = (row: RecordProjectionRow, name: string): string | undefined => {
  const value = row.values[name];
  return typeof value === "string" && value ? value : undefined;
};

const replayDispatcher = (replayId: string, output: SprintReplayOutputPolicy): SprintIntentDispatcher => ({
  async dispatch(args): Promise<SprintDispatchEvidence> {
    const intent = args.claimed.intent;
    const base = {
      dispatcherId: output.mode === "proof-only" ? "sprint-replay-proof" : "sprint-replay-test",
      executionId: `replay:${replayId}:${intent.intent_id}`,
      outcomeDigest: sha256({ replay_id: replayId, mode: output.mode, intent }),
    };
    if (!intent.type.startsWith("message.")) return base;
    const message = intent as Extract<SprintIntent, { type: `message.${string}` }>;
    if (!("channel_binding" in message) && message.type !== "message.direct-question") return base;
    if (message.type === "message.direct-question") {
      // Historical replay reports the private-question intent but does not
      // impersonate a participant DM, even when the result target is test-only.
      return base;
    }
    const purpose = message.type.slice("message.".length) as Extract<SprintEvent, { type: "message.delivered" }>["purpose"];
    const threadReference = message.type === "message.close-reminder"
      ? `replay-thread:${sha256(replayId).slice(0, 24)}`
      : "thread_reference" in message ? String(message.thread_reference) : `replay-thread:${sha256(replayId).slice(0, 24)}`;
    const delivery: Extract<SprintEvent, { type: "message.delivered" }> = {
      type: "message.delivered",
      event_id: `replay-delivery:${sha256([replayId, message.intent_id])}`,
      occurred_at: args.dispatchedAt,
      intent_id: message.intent_id,
      purpose,
      destination_binding: output.communication_binding,
      message_id: `replay:${sha256([replayId, message.intent_id]).slice(0, 24)}`,
      thread_reference: threadReference,
    };
    return {
      ...base,
      receiptIds: [delivery.message_id],
      events: sprintMessageLifecycleEvents({
        definitionId: args.definitionId,
        sprintId: args.state.sprint_id!,
        intent: message as Parameters<typeof sprintMessageLifecycleEvents>[0]["intent"],
        delivery,
      }),
    };
  },
});

/**
 * Replays one historical Sprint against immutable Record projections. The
 * service can use a Postgres-backed store for durable proof, while this module
 * never talks to Slack or a work provider directly.
 */
export class SprintReplayService {
  readonly instanceId: string;
  readonly store: SprintOrchestrationStore;
  readonly timers: DurableTimerService;

  constructor(args: { instanceId: string; store: SprintOrchestrationStore; timers: DurableTimerService }) {
    text(args.instanceId, "Sprint Replay Instance id", 127);
    if (args.timers.instanceId !== args.instanceId) throw new Error("Sprint Replay timers and state must belong to the same Instance");
    this.instanceId = args.instanceId;
    this.store = args.store;
    this.timers = args.timers;
  }

  async run(input: SprintReplayInput): Promise<SprintReplayReport> {
    text(input.replayId, "Sprint Replay id", 127);
    text(input.sprintId, "Sprint Replay Sprint id");
    exactDate(input.periodStart, "Sprint Replay periodStart");
    exactDate(input.periodEnd, "Sprint Replay periodEnd");
    if (input.periodStart > input.periodEnd) throw new Error("Sprint Replay periodStart must not follow periodEnd");
    if (!input.output.test_only) throw new Error("Sprint Replay output must be explicitly test-only");
    if (input.output.forbidden_bindings.includes(input.output.communication_binding)
      || (input.output.work_item_binding && input.output.forbidden_bindings.includes(input.output.work_item_binding))) {
      throw new Error("Sprint Replay output selects a forbidden production binding");
    }
    if (input.messages.length > 100_000) throw new Error("Sprint Replay messages exceed the supported limit");
    const inputDigest = sha256({
      replay_id: input.replayId,
      sprint_id: input.sprintId,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      projection_id: input.messageProjectionId,
      messages: input.messages.map((row) => [row.record_id, row.source_version_id]),
      participant_source_version: input.snapshot.participantSourceVersion,
      work_item_source_version: input.snapshot.workItemSourceVersion,
      policy: input.policy,
      calendar: input.calendar,
      output: input.output,
    });
    const definitionId = `replay-${sha256([input.replayId, inputDigest]).slice(0, 40)}`;
    if (!identifier.test(definitionId)) throw new Error("Sprint Replay definition identity is invalid");
    const policy: SprintDomainDeclaration = {
      ...structuredClone(input.policy),
      id: definitionId,
      delivery: { ...structuredClone(input.policy.delivery), channel_binding: input.output.communication_binding },
      // A Friday-close replay deliberately excludes ordinary weekday workers.
      weekly: undefined,
    };
    const service = new SprintOrchestrationService({
      instanceId: this.instanceId,
      policy,
      calendar: input.calendar,
      store: this.store,
      timers: this.timers,
    });
    const openedAt = zonedLocalDateTimeToIso(input.periodStart, "00:00", policy.calendar.timezone);
    await service.openSprint({
      event: {
        type: "sprint.opened",
        event_id: `replay-open:${inputDigest}`,
        occurred_at: openedAt,
        sprint_id: input.sprintId,
        period_start: input.periodStart,
        period_end: input.periodEnd,
      },
    });
    const snapshotAt = new Date(Date.parse(openedAt) + 1).toISOString();
    await service.processEvent({
      type: "participants.observed",
      event_id: `replay-participants:${sha256([inputDigest, input.snapshot.participantSourceVersion])}`,
      occurred_at: snapshotAt,
      participants: structuredClone(input.snapshot.participants),
    });
    await service.processEvent({
      type: "work-items.observed",
      event_id: `replay-work-items:${sha256([inputDigest, input.snapshot.workItemSourceVersion])}`,
      occurred_at: snapshotAt,
      work_items: structuredClone(input.snapshot.workItems),
    });
    const initial = await this.store.getState({ instanceId: this.instanceId, definitionId });
    if (!initial) throw new Error("Sprint Replay did not persist its initial state");
    const closeSchedule = sprintCloseSchedule({ policy, periodEnd: input.periodEnd, calendar: input.calendar });
    const periodEndExclusive = zonedLocalDateTimeToIso(addCalendarDays(input.periodEnd, 1), "00:00", policy.calendar.timezone);
    const ignored: SprintReplayIgnoredMessage[] = [];
    const derived: Array<ReturnType<typeof deriveHistoricalSprintSubmission>> = [];
    for (const row of [...input.messages].sort((left, right) => {
      const time = String(left.values.occurred_at ?? "").localeCompare(String(right.values.occurred_at ?? ""));
      return time || left.record_id.localeCompare(right.record_id);
    })) {
      const occurredAt = messageValue(row, "occurred_at");
      const body = messageValue(row, "text") ?? "";
      if (!occurredAt || occurredAt < openedAt || occurredAt >= periodEndExclusive) {
        ignored.push({ record_id: row.record_id, reason: "outside-period" });
        continue;
      }
      if (!isFridaySprintUpdate(body)) {
        ignored.push({ record_id: row.record_id, reason: "not-sprint-update" });
        continue;
      }
      const teamId = messageValue(row, "team_id");
      const authorId = messageValue(row, "author_id");
      const principal = teamId && authorId ? input.principalByProviderAuthor[`${teamId}:${authorId}`] : undefined;
      if (!principal) {
        ignored.push({ record_id: row.record_id, reason: "unresolved-author" });
        continue;
      }
      try {
        const projected = deriveHistoricalSprintSubmission({
          row,
          expectedProjectionId: input.messageProjectionId,
          participantPrincipal: principal,
          state: initial.state,
          policy,
        });
        derived.push(projected);
        if (projected.event.occurred_at > closeSchedule.report_at) {
          ignored.push({ record_id: row.record_id, reason: "after-report" });
        }
      } catch (error) {
        ignored.push({
          record_id: row.record_id,
          reason: "invalid-submission",
          error_digest: sha256(error instanceof Error ? error.message : String(error)),
        });
      }
    }

    const eligible = derived.filter((item) => item.event.occurred_at <= closeSchedule.report_at);
    const timeline = [
      ...eligible.map((item) => ({ at: item.event.occurred_at, kind: "submission" as const, event: item.event })),
      { at: closeSchedule.reminder_at, kind: "timer" as const },
      { at: closeSchedule.chase_at, kind: "timer" as const },
      { at: closeSchedule.report_at, kind: "timer" as const },
    ].sort((left, right) => left.at.localeCompare(right.at) || (left.kind === "timer" ? -1 : 1));
    const dispatcher = replayDispatcher(input.replayId, input.output);
    for (const entry of timeline) {
      if (entry.kind === "submission") {
        await service.processEvent(entry.event);
        continue;
      }
      await service.processDueTimers({
        now: entry.at,
        owner: `replay-timer:${input.replayId}`,
        leaseToken: `timer-${sha256([input.replayId, entry.at]).slice(0, 48)}`,
        leaseExpiresAt: leaseExpiry(entry.at),
        limit: 20,
      });
      for (let pass = 0; pass < 5; pass += 1) {
        const dispatched = await service.dispatchIntents({
          now: entry.at,
          owner: `replay-intent:${input.replayId}`,
          leaseToken: `intent-${sha256([input.replayId, entry.at, pass]).slice(0, 48)}`,
          leaseExpiresAt: leaseExpiry(entry.at),
          dispatcher,
          limit: 100,
        });
        if (dispatched.length === 0) break;
        if (dispatched.some((result) => result.status === "failed")) throw new Error("Sprint Replay intent dispatch failed");
      }
    }
    const completed = await this.store.getState({ instanceId: this.instanceId, definitionId });
    if (!completed) throw new Error("Sprint Replay did not produce final state");
    const close = buildSprintCloseReadModel({ state: completed.state, policy, reportAt: closeSchedule.report_at });
    const limitations = [
      ...(input.snapshot.observedAt > closeSchedule.report_at ? ["operational-snapshot-is-newer-than-replayed-period"] : []),
      ...(input.snapshot.observedAt < openedAt ? ["operational-snapshot-predates-replayed-period"] : []),
    ];
    const base = {
      schema_version: 1 as const,
      replay_id: input.replayId,
      sprint_id: input.sprintId,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      mode: input.output.mode,
      definition_id: definitionId,
      controlled_clock_completed_at: closeSchedule.report_at,
      input_digest: inputDigest,
      submission_records: derived.map((item) => item.record),
      ignored_messages: ignored,
      participant_states: Object.fromEntries(close.participants.filter((participant) => participant.included).map((participant) => [participant.participant_id, participant.close_state])),
      open_work_item_ids: close.open_work_items.map((item) => item.work_item_id).sort(),
      total_effort_hours: close.total_effort_hours,
      limitations,
      final_phase: completed.state.phase,
    };
    return { ...base, output_digest: sha256(base) };
  }
}

/** Convenience entrypoint for deterministic local tests and review previews. */
export async function runSprintReplayInMemory(instanceId: string, input: SprintReplayInput): Promise<SprintReplayReport> {
  const store = new InMemorySprintOrchestrationStore();
  const timers = new DurableTimerService({ store: new InMemoryDurableTimerStore(), instanceId });
  return new SprintReplayService({ instanceId, store, timers }).run(input);
}
