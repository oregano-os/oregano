import type { CompiledSprintRuntime } from "../companyos-builder/types.ts";
import {
  addCalendarDays,
  isBusinessDay,
  shiftToBusinessDay,
  sprintCloseSchedule,
  weekdayOf,
  zonedLocalDateTimeToIso,
} from "../domains/sprint/business-time.ts";
import type { SprintEvent, SprintIntent } from "../domains/sprint/contracts.ts";
import type { DurableTimerStore } from "../state-store/durable-timers.ts";
import type { SprintOrchestrationStore } from "../state-store/sprint-orchestration.ts";
import { sha256 } from "./canonical.ts";
import { DurableTimerService } from "./durable-timers.ts";
import { CompiledSprintToolExecutionResolver, HostedSprintRuntime, type SprintSnapshot } from "./sprint-host.ts";

export type SprintScenarioId =
  | "monday-handoff"
  | "weekday-digest"
  | "readiness-check"
  | "friday-close"
  | "retro"
  | "rollover-proposal"
  | "triage"
  | "briefing"
  | "inactivity-nudge"
  | "blocker-follow-up";

export interface SprintScenarioCatalogEntry {
  id: SprintScenarioId;
  execution: "deterministic-runtime" | "planned-workflow-runtime";
  available: boolean;
  reason?: string;
}

export type SprintScenarioSubmissionOutcome = "complete" | "needs-reformat" | "missing";

export interface SprintScenarioInput {
  scenarioRunId: string;
  sprintId: string;
  periodStart: string;
  periodEnd: string;
  snapshot: SprintSnapshot;
  excludedParticipantIds?: string[];
  nextSprintId?: string;
  submissionOutcomes?: Record<string, SprintScenarioSubmissionOutcome>;
}

export interface SprintScenarioReport {
  schema_version: 1;
  mode: "proof-only";
  scenario_run_id: string;
  sprint_id: string;
  period_start: string;
  period_end: string;
  source_definition_id: string;
  scenario_definition_id: string;
  input_digest: string;
  source_versions: {
    participants: string;
    work_items: string;
    observed_at: string;
  };
  compiled_context: {
    agent_id: string;
    agent_instructions_digest: string;
    skill_material_digests: Array<{ path: string; digest: string }>;
    model_task: string;
    schedule_digest: string;
    template_digests: string[];
    bindings_digest: string;
  };
  catalog: SprintScenarioCatalogEntry[];
  executed_scenarios: SprintScenarioId[];
  proof_summary: {
    event_count: number;
    intent_count: number;
    timer_count: number;
    events_digest: string;
    intents_digest: string;
    timers_digest: string;
    returned_row_limit: number;
  };
  events: Array<{
    event_id: string;
    event_type: SprintEvent["type"];
    occurred_at: string;
    state_version: number;
    decisions: Array<{ rule: string; outcome: string }>;
  }>;
  intents: Array<{
    intent_id: string;
    intent_type: SprintIntent["type"];
    state: "pending" | "leased" | "succeeded" | "failed" | "cancelled";
    attempts: number;
    active_binding: "ready" | "requires-confirmation" | "unavailable";
    grant_id?: string;
    error_digest?: string;
  }>;
  timers: Array<{
    timer_id: string;
    due_at: string;
    state: "scheduled" | "leased" | "completed" | "failed" | "cancelled";
    attempts: number;
    error_digest?: string;
  }>;
  final_state: {
    state_version: number;
    phase: "idle" | "open" | "reminding" | "reporting" | "closed";
    participant_count: number;
    work_item_count: number;
    submission_count: number;
  };
  limitations: string[];
  output_digest: string;
}

const REPORT_ROW_LIMIT = 250;

const exactDate = (value: string, label: string): void => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be an exact calendar date`);
  }
};

const text = (value: string, label: string, maximum = 255): void => {
  if (!value || value.length > maximum) throw new Error(`${label} must contain 1 to ${maximum} characters`);
};

const lease = (definitionId: string, kind: "timer" | "intent", now: string, pass: number) => ({
  now,
  owner: `scenario-${kind}`,
  leaseToken: `${kind}-${sha256([definitionId, now, pass]).slice(0, 48)}`,
  leaseExpiresAt: new Date(Date.parse(now) + 5 * 60_000).toISOString(),
});

const scenarioDefinition = (inputDigest: string): string => `scenario-${inputDigest.slice(0, 40)}`;

function scenarioCatalog(compiled: CompiledSprintRuntime, nextSprintId?: string): SprintScenarioCatalogEntry[] {
  const weekly = Boolean(compiled.policy.weekly);
  const monday = weekly && Boolean(compiled.policy.weekly?.monday_handoff_trigger) && Boolean(compiled.templates.mondayHandoff);
  const digest = weekly && Boolean(compiled.policy.weekly?.weekday_digest_trigger) && Boolean(compiled.templates.weekdayDigest);
  const readiness = digest && Boolean(compiled.policy.weekly?.readiness_weekday) && Boolean(compiled.policy.work_items.required_fields?.length)
    && Boolean(compiled.templates.directQuestion) && Boolean(compiled.workItem?.readinessField);
  return [
    { id: "monday-handoff", execution: "deterministic-runtime", available: monday, ...(monday ? {} : { reason: "compiled-weekly-handoff-is-unavailable" }) },
    { id: "weekday-digest", execution: "deterministic-runtime", available: digest, ...(digest ? {} : { reason: "compiled-weekday-digest-is-unavailable" }) },
    { id: "readiness-check", execution: "deterministic-runtime", available: readiness, ...(readiness ? {} : { reason: "compiled-readiness-contract-is-incomplete" }) },
    { id: "friday-close", execution: "deterministic-runtime", available: true },
    { id: "retro", execution: "deterministic-runtime", available: true },
    { id: "rollover-proposal", execution: "deterministic-runtime", available: Boolean(nextSprintId), ...(nextSprintId ? {} : { reason: "next-sprint-id-was-not-supplied" }) },
    { id: "triage", execution: "planned-workflow-runtime", available: false, reason: "durable-conversational-workflow-is-not-hosted" },
    { id: "briefing", execution: "planned-workflow-runtime", available: false, reason: "durable-conversational-workflow-is-not-hosted" },
    { id: "inactivity-nudge", execution: "planned-workflow-runtime", available: false, reason: "durable-nudge-policy-is-not-hosted" },
    { id: "blocker-follow-up", execution: "planned-workflow-runtime", available: false, reason: "durable-nudge-policy-is-not-hosted" },
  ];
}

function weeklyMoments(compiled: CompiledSprintRuntime, periodStart: string, periodEnd: string): string[] {
  if (!compiled.policy.weekly) return [];
  const selected = new Set([
    compiled.policy.weekly.monday_handoff_trigger,
    compiled.policy.weekly.weekday_digest_trigger,
  ].filter((id): id is string => Boolean(id)));
  const triggers = compiled.schedule.triggers.filter((trigger) => selected.has(trigger.id));
  if (new Set(triggers.map((trigger) => trigger.id)).size !== selected.size) {
    throw new Error("Sprint scenario references an absent compiled weekly trigger");
  }
  const moments = new Set<string>();
  for (let date = periodStart; date <= periodEnd; date = addCalendarDays(date, 1)) {
    for (const trigger of triggers) {
      if (!trigger.weekdays.includes(weekdayOf(date))) continue;
      let effectiveDate = date;
      if (!isBusinessDay(date, compiled.calendar)) {
        const shift = trigger.holidayShift ?? "none";
        if (shift === "none") continue;
        effectiveDate = shiftToBusinessDay(date, shift === "previous-business-day" ? "previous" : "next", compiled.calendar);
      }
      moments.add(zonedLocalDateTimeToIso(effectiveDate, trigger.at, compiled.policy.calendar.timezone));
    }
  }
  return [...moments].sort();
}

function syntheticSubmissionEvents(args: {
  definitionId: string;
  input: SprintScenarioInput;
  snapshot: SprintSnapshot;
  masterGroup: string;
  occurredAt: string;
}): Extract<SprintEvent, { type: "submission.received" }>[] {
  const outcomes = args.input.submissionOutcomes ?? {};
  const participants = new Map(args.snapshot.participants.map((participant) => [participant.participant_id, participant]));
  const unknown = Object.keys(outcomes).find((participantId) => !participants.has(participantId));
  if (unknown) throw new Error(`Sprint scenario submission references unknown participant '${unknown}'`);
  return Object.entries(outcomes)
    .filter(([, outcome]) => outcome !== "missing")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([participantId, outcome]) => {
      const taskIds = args.snapshot.workItems
        .filter((item) => item.group === args.masterGroup && item.assignee_ids.includes(participantId))
        .map((item) => item.work_item_id)
        .sort();
      return {
        type: "submission.received",
        event_id: `scenario-submission:${sha256([args.definitionId, participantId, outcome])}`,
        occurred_at: args.occurredAt,
        participant_id: participantId,
        submission_id: `scenario:${sha256([args.definitionId, participantId]).slice(0, 32)}`,
        task_ids: taskIds,
        complete: outcome === "complete",
      };
    });
}

function executedScenarios(intents: SprintIntent[]): SprintScenarioId[] {
  const types = new Set(intents.map((intent) => intent.type));
  const readiness = intents.some((intent) => intent.type === "message.weekday-digest" && intent.readiness !== undefined)
    || types.has("message.direct-question") || types.has("work-item.readiness-update");
  return [
    ...(types.has("message.monday-handoff") ? ["monday-handoff" as const] : []),
    ...(types.has("message.weekday-digest") ? ["weekday-digest" as const] : []),
    ...(readiness ? ["readiness-check" as const] : []),
    ...(types.has("message.close-report") ? ["friday-close" as const] : []),
    ...(types.has("message.retro") ? ["retro" as const] : []),
    ...(types.has("work-item.rollover-proposal") ? ["rollover-proposal" as const] : []),
  ];
}

/**
 * Executes one complete Sprint week in an isolated durable namespace.
 *
 * The runner deliberately forces the production host into Shadow mode. It
 * accepts no destination, Tool, template, event, or provider input from the
 * operator, so the exact compiled Workspace can be exercised without gaining
 * any provider authority.
 */
export class SprintScenarioRunner {
  readonly instanceId: string;
  readonly compiled: CompiledSprintRuntime;
  readonly store: SprintOrchestrationStore;
  readonly timerStore: DurableTimerStore;
  readonly agentEvidence: {
    instructionsDigest: string;
    skillMaterialDigests: Array<{ path: string; digest: string }>;
  };

  constructor(args: {
    instanceId: string;
    compiled: CompiledSprintRuntime;
    store: SprintOrchestrationStore;
    timerStore: DurableTimerStore;
    agentEvidence: {
      instructionsDigest: string;
      skillMaterialDigests: Array<{ path: string; digest: string }>;
    };
  }) {
    text(args.instanceId, "Sprint scenario Instance id", 127);
    if (!/^[a-f0-9]{64}$/.test(args.agentEvidence.instructionsDigest)) {
      throw new Error("Sprint scenario Agent instructions digest must be one exact SHA-256 digest");
    }
    for (const material of args.agentEvidence.skillMaterialDigests) {
      text(material.path, "Sprint scenario Skill material path", 512);
      if (!/^[a-f0-9]{64}$/.test(material.digest)) {
        throw new Error("Sprint scenario Skill material digest must be one exact SHA-256 digest");
      }
    }
    this.instanceId = args.instanceId;
    this.compiled = structuredClone(args.compiled);
    this.store = args.store;
    this.timerStore = args.timerStore;
    this.agentEvidence = {
      instructionsDigest: args.agentEvidence.instructionsDigest,
      skillMaterialDigests: structuredClone(args.agentEvidence.skillMaterialDigests)
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
  }

  async run(input: SprintScenarioInput): Promise<SprintScenarioReport> {
    text(input.scenarioRunId, "Sprint scenario run id", 127);
    text(input.sprintId, "Sprint scenario Sprint id");
    exactDate(input.periodStart, "Sprint scenario periodStart");
    exactDate(input.periodEnd, "Sprint scenario periodEnd");
    if (input.periodStart > input.periodEnd) throw new Error("Sprint scenario periodStart must not follow periodEnd");
    const periodDays = Math.round((Date.parse(`${input.periodEnd}T00:00:00.000Z`) - Date.parse(`${input.periodStart}T00:00:00.000Z`)) / 86_400_000) + 1;
    if (periodDays > 31) throw new Error("Sprint scenario period cannot exceed 31 calendar days");
    if (input.nextSprintId !== undefined) text(input.nextSprintId, "Sprint scenario next Sprint id");
    const excluded = new Set(input.excludedParticipantIds ?? []);
    if (excluded.size !== (input.excludedParticipantIds?.length ?? 0)) throw new Error("Excluded Sprint scenario participant ids must be unique");
    const unknownExcluded = [...excluded].find((participantId) => !input.snapshot.participants.some((participant) => participant.participant_id === participantId));
    if (unknownExcluded) throw new Error(`Excluded Sprint scenario participant '${unknownExcluded}' is not present in the snapshot`);

    const inputDigest = sha256({
      scenario_run_id: input.scenarioRunId,
      sprint_id: input.sprintId,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      next_sprint_id: input.nextSprintId ?? null,
      excluded_participant_ids: [...excluded].sort(),
      submission_outcomes: input.submissionOutcomes ?? {},
      participant_source_version: input.snapshot.participantSourceVersion,
      work_item_source_version: input.snapshot.workItemSourceVersion,
      participants: input.snapshot.participants,
      work_items: input.snapshot.workItems,
      compiled_definition_id: this.compiled.definitionId,
      compiled_schedule_digest: this.compiled.schedule.sourceDigest,
      compiled_template_digests: Object.values(this.compiled.templates).map((template) => template.digest).sort(),
      agent_instructions_digest: this.agentEvidence.instructionsDigest,
      skill_material_digests: this.agentEvidence.skillMaterialDigests,
    });
    const definitionId = scenarioDefinition(inputDigest);
    const scheduleDigest = sha256(["sprint-scenario", this.compiled.schedule.sourceDigest, inputDigest]);
    const compiled: CompiledSprintRuntime = {
      ...structuredClone(this.compiled),
      definitionId,
      policy: { ...structuredClone(this.compiled.policy), id: definitionId },
      schedule: { ...structuredClone(this.compiled.schedule), sourceDigest: scheduleDigest },
    };
    const openedAt = zonedLocalDateTimeToIso(input.periodStart, "00:00", compiled.policy.calendar.timezone);
    const snapshot: SprintSnapshot = {
      ...structuredClone(input.snapshot),
      observedAt: openedAt,
      participants: input.snapshot.participants.map((participant) => ({
        ...structuredClone(participant),
        approved_absence: participant.approved_absence || excluded.has(participant.participant_id),
      })),
    };
    const close = sprintCloseSchedule({ policy: compiled.policy, periodEnd: input.periodEnd, calendar: compiled.calendar });
    if (close.local_date < input.periodStart || close.local_date > input.periodEnd) {
      throw new Error("Sprint scenario period must contain its reviewed Close business day");
    }
    const submissionAt = new Date(Date.parse(close.reminder_at) - 60_000).toISOString();
    const submissions = syntheticSubmissionEvents({
      definitionId,
      input,
      snapshot,
      masterGroup: compiled.policy.work_items.master_group,
      occurredAt: submissionAt,
    });
    const moments = [...new Set([
      ...weeklyMoments(compiled, input.periodStart, input.periodEnd),
      close.reminder_at,
      close.chase_at,
      close.report_at,
    ])].sort();
    if (moments.some((moment) => moment < openedAt)) {
      throw new Error("Sprint scenario contains a holiday-shifted trigger before its period start");
    }
    const timers = new DurableTimerService({ store: this.timerStore, instanceId: this.instanceId });
    const hosted = new HostedSprintRuntime({
      instanceId: this.instanceId,
      compiled,
      mode: "shadow",
      store: this.store,
      timers,
    });
    await hosted.open({
      sprintId: input.sprintId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      openedAt,
      snapshot,
      excludedParticipantIds: [...excluded],
      ...(input.nextSprintId ? { nextSprintId: input.nextSprintId } : {}),
    });
    const timeline = [
      ...moments.map((at) => ({ at, kind: "timer" as const })),
      ...submissions.map((event) => ({ at: event.occurred_at, kind: "submission" as const, event })),
    ].sort((left, right) => left.at.localeCompare(right.at) || (left.kind === "submission" ? -1 : 1));
    for (const entry of timeline) {
      if (entry.kind === "submission") {
        await hosted.service.processEvent(entry.event);
        continue;
      }
      const now = entry.at;
      for (let pass = 0; pass < 10; pass += 1) {
        const timerResults = await hosted.processDueTimers({ ...lease(definitionId, "timer", now, pass), limit: 200 });
        for (let intentPass = 0; intentPass < 10; intentPass += 1) {
          const intentResults = await hosted.dispatchIntents({ ...lease(definitionId, "intent", now, intentPass), limit: 100 });
          if (intentResults.length === 0) break;
        }
        if (timerResults.length === 0 || timerResults.every((result) => result.status !== "deferred")) break;
      }
    }

    const key = { instanceId: this.instanceId, definitionId };
    const [stored, events, intents, storedTimers] = await Promise.all([
      this.store.getState(key),
      this.store.listEvents(key),
      this.store.listIntents(key),
      timers.list(`sprint.clock-reached:${definitionId}`),
    ]);
    if (!stored) throw new Error("Sprint scenario did not persist final state");
    const activeResolver = new CompiledSprintToolExecutionResolver(compiled);
    const intentReports: SprintScenarioReport["intents"] = [];
    for (const row of intents) {
      const executionErrorDigest = row.state === "failed" && row.evidence && typeof row.evidence === "object" && !Array.isArray(row.evidence)
        ? String((row.evidence as Record<string, unknown>).error_digest ?? "") || undefined
        : undefined;
      if (row.intent.type === "work-item.rollover" || row.intent.type === "work-item.rollover-proposal") {
        intentReports.push({
          intent_id: row.intent.intent_id,
          intent_type: row.intent.type,
          state: row.state,
          attempts: row.attempts,
          active_binding: "requires-confirmation",
          ...(executionErrorDigest ? { error_digest: executionErrorDigest } : {}),
        });
        continue;
      }
      try {
        const resolved = await activeResolver.resolve({
          instanceId: this.instanceId,
          definitionId,
          state: stored.state,
          intent: row.intent,
        });
        intentReports.push({
          intent_id: row.intent.intent_id,
          intent_type: row.intent.type,
          state: row.state,
          attempts: row.attempts,
          active_binding: "ready",
          grant_id: resolved.grantId,
          ...(executionErrorDigest ? { error_digest: executionErrorDigest } : {}),
        });
      } catch (error) {
        intentReports.push({
          intent_id: row.intent.intent_id,
          intent_type: row.intent.type,
          state: row.state,
          attempts: row.attempts,
          active_binding: "unavailable",
          error_digest: sha256(error instanceof Error ? error.message : String(error)),
        });
      }
    }
    const eventReports: SprintScenarioReport["events"] = events.map((row) => ({
      event_id: row.event.event_id,
      event_type: row.event.type,
      occurred_at: row.event.occurred_at,
      state_version: row.stateVersion,
      decisions: row.decision.evidence.map((item) => ({ rule: item.rule, outcome: item.outcome })),
    }));
    const timerReports: SprintScenarioReport["timers"] = storedTimers.map((timer) => ({
      timer_id: timer.timerId,
      due_at: timer.dueAt,
      state: timer.state,
      attempts: timer.attempts,
      ...(timer.state === "failed" && timer.evidence && typeof timer.evidence === "object" && !Array.isArray(timer.evidence)
        ? { error_digest: String((timer.evidence as Record<string, unknown>).error_digest ?? "") }
        : {}),
    }));
    const sampled = eventReports.length > REPORT_ROW_LIMIT
      || intentReports.length > REPORT_ROW_LIMIT
      || timerReports.length > REPORT_ROW_LIMIT;
    const limitations = [
      "proof-only-no-provider-effects",
      "synthetic-submission-outcomes-do-not-parse-slack-text",
      ...(input.snapshot.observedAt > close.report_at ? ["operational-snapshot-is-newer-than-controlled-period"] : []),
      ...(sampled ? ["proof-report-rows-are-sampled;complete-proof-remains-durable"] : []),
    ];
    const base = {
      schema_version: 1 as const,
      mode: "proof-only" as const,
      scenario_run_id: input.scenarioRunId,
      sprint_id: input.sprintId,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      source_definition_id: this.compiled.definitionId,
      scenario_definition_id: definitionId,
      input_digest: inputDigest,
      source_versions: {
        participants: input.snapshot.participantSourceVersion,
        work_items: input.snapshot.workItemSourceVersion,
        observed_at: input.snapshot.observedAt,
      },
      compiled_context: {
        agent_id: this.compiled.agentId,
        agent_instructions_digest: this.agentEvidence.instructionsDigest,
        skill_material_digests: structuredClone(this.agentEvidence.skillMaterialDigests),
        model_task: this.compiled.modelTask,
        schedule_digest: this.compiled.schedule.sourceDigest,
        template_digests: Object.values(this.compiled.templates).map((template) => template.digest).sort(),
        bindings_digest: sha256({
          channel: this.compiled.policy.delivery.channel_binding,
          direct: this.compiled.directDestinations,
          work_item: this.compiled.workItem,
        }),
      },
      catalog: scenarioCatalog(this.compiled, input.nextSprintId),
      executed_scenarios: executedScenarios(intents.map((row) => row.intent)),
      proof_summary: {
        event_count: eventReports.length,
        intent_count: intentReports.length,
        timer_count: timerReports.length,
        events_digest: sha256(eventReports),
        intents_digest: sha256(intentReports),
        timers_digest: sha256(timerReports),
        returned_row_limit: REPORT_ROW_LIMIT,
      },
      events: eventReports.slice(0, REPORT_ROW_LIMIT),
      intents: intentReports.slice(0, REPORT_ROW_LIMIT),
      timers: timerReports.slice(0, REPORT_ROW_LIMIT),
      final_state: {
        state_version: stored.stateVersion,
        phase: stored.state.phase,
        participant_count: Object.keys(stored.state.participants).length,
        work_item_count: Object.keys(stored.state.work_items).length,
        submission_count: Object.values(stored.state.submissions).reduce((total, submissions) => total + submissions.length, 0),
      },
      limitations,
    };
    return { ...base, output_digest: sha256(base) };
  }
}
