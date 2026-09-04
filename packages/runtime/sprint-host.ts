import type { CompiledSprintRuntime } from "../companyos-builder/types.ts";
import type { SprintEvent, SprintIntent, SprintParticipant, SprintState, SprintWorkItem } from "../domains/sprint/contracts.ts";
import type { SprintOrchestrationStore } from "../state-store/sprint-orchestration.ts";
import { sha256 } from "./canonical.ts";
import type { DurableTimerService } from "./durable-timers.ts";
import { renderSprintMessageIntent } from "./sprint-intent-renderer.ts";
import { normalizeSlackFridaySubmission } from "./sprint-slack-submission.ts";
import {
  CompanyOSSprintIntentDispatcher,
  SprintOrchestrationService,
  sprintMessageLifecycleEvents,
  type SprintDispatchEvidence,
  type SprintIntentDispatcher,
  type SprintToolExecutionResolver,
} from "./sprint-orchestration.ts";

type SprintMessageIntent = Extract<SprintIntent, {
  type: "message.monday-handoff" | "message.weekday-digest" | "message.direct-question" | "message.close-reminder" | "message.close-chase" | "message.close-report" | "message.retro";
}>;

const isSprintMessageIntent = (intent: SprintIntent): intent is SprintMessageIntent =>
  intent.type === "message.monday-handoff" || intent.type === "message.weekday-digest" || intent.type === "message.direct-question"
  || intent.type === "message.close-reminder" || intent.type === "message.close-chase"
  || intent.type === "message.close-report" || intent.type === "message.retro";

export type SprintRuntimeMode = "disabled" | "shadow" | "active";

export interface SprintSnapshot {
  participants: SprintParticipant[];
  workItems: SprintWorkItem[];
  observedAt: string;
  participantSourceVersion: string;
  workItemSourceVersion: string;
}

const exactIso = (value: string, label: string): void => {
  if (!value || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be an exact ISO timestamp`);
  }
};

const exactDate = (value: string, label: string): void => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be an exact calendar date`);
  }
};

/**
 * Executes Sprint intents without provider effects while retaining immutable,
 * content-free evidence. Shadow mode proves orchestration and rendering, but
 * never publishes a message or changes a work item.
 */
export class ShadowSprintIntentDispatcher implements SprintIntentDispatcher {
  readonly runtime: CompiledSprintRuntime;

  constructor(runtime: CompiledSprintRuntime) {
    this.runtime = runtime;
  }

  async dispatch(args: Parameters<SprintIntentDispatcher["dispatch"]>[0]): Promise<SprintDispatchEvidence> {
    const intent = args.claimed.intent;
    const directDestination = intent.type === "message.direct-question"
      ? this.directDestination(args.state, intent.participant_id)
      : undefined;
    const rendered = isSprintMessageIntent(intent)
      ? renderSprintMessageIntent({ intent, state: args.state, templates: this.runtime.templates })
      : undefined;
    const delivery = isSprintMessageIntent(intent) ? {
      type: "message.delivered" as const,
      event_id: `shadow-delivery:${intent.intent_id}`,
      occurred_at: args.dispatchedAt,
      intent_id: intent.intent_id,
      purpose: intent.type.slice("message.".length) as Extract<SprintEvent, { type: "message.delivered" }>["purpose"],
      destination_binding: directDestination ?? ("channel_binding" in intent ? intent.channel_binding : ""),
      message_id: `shadow:${sha256(intent.intent_id).slice(0, 24)}`,
      thread_reference: intent.type === "message.close-reminder"
        ? `shadow-thread:${sha256([args.definitionId, args.state.sprint_id]).slice(0, 24)}`
        : "thread_reference" in intent ? intent.thread_reference : `shadow-thread:${sha256(intent.intent_id).slice(0, 24)}`,
      ...(intent.type === "message.direct-question" ? { participant_id: intent.participant_id } : {}),
    } : undefined;
    return {
      dispatcherId: "sprint-shadow",
      executionId: `shadow:${args.definitionId}:${intent.intent_id}`,
      outcomeDigest: sha256({
        mode: "shadow",
        definition_id: args.definitionId,
        intent,
        ...(rendered ? {
          template_path: rendered.templatePath,
          template_digest: rendered.templateDigest,
          content_digest: rendered.contentDigest,
        } : {}),
      }),
      ...(delivery ? {
        receiptIds: [delivery.message_id],
        events: sprintMessageLifecycleEvents({
          definitionId: args.definitionId,
          sprintId: args.state.sprint_id!,
          intent: intent as SprintMessageIntent,
          delivery,
        }),
      } : {}),
    };
  }

  private directDestination(state: SprintState, participantId: string): string {
    const principal = state.participants[participantId]?.communication_principal;
    if (!principal) throw new Error(`Sprint participant '${participantId}' lacks a canonical communication principal`);
    const binding = this.runtime.directDestinations[principal];
    if (!binding) throw new Error(`Sprint participant '${participantId}' lacks an exact compiled direct-message destination`);
    return binding;
  }
}

/** Provider-neutral binding from Sprint intents into the normal CompanyOS Tool boundary. */
export class CompiledSprintToolExecutionResolver implements SprintToolExecutionResolver {
  readonly runtime: CompiledSprintRuntime;

  constructor(runtime: CompiledSprintRuntime) {
    this.runtime = runtime;
  }

  async resolve(args: Parameters<SprintToolExecutionResolver["resolve"]>[0]) {
    const intent = args.intent;
    if (isSprintMessageIntent(intent)) {
      const channelBinding = intent.type === "message.direct-question"
        ? this.directBinding(args.state, intent.participant_id)
        : intent.channel_binding;
      if (intent.type !== "message.direct-question" && channelBinding !== this.runtime.policy.delivery.channel_binding) {
        throw new Error("Sprint message attempted to widen its reviewed shared-channel binding");
      }
      const rendered = renderSprintMessageIntent({ intent, state: args.state, templates: this.runtime.templates });
      return {
        agentId: this.runtime.agentId,
        grantId: "oregano:communications/publish",
        subjectPrincipal: this.runtime.servicePrincipal,
        input: {
          destination_binding: channelBinding,
          content: rendered.content,
          format: "provider-markdown",
          ...(["message.close-chase", "message.close-report", "message.retro"].includes(intent.type) ? { thread_reference: (intent as Extract<SprintIntent, { type: "message.close-chase" | "message.close-report" | "message.retro" }>).thread_reference } : {}),
        },
      };
    }
    if (intent.type === "work-item.readiness-update") {
      if (!this.runtime.workItem?.readinessField) {
        throw new Error("Sprint readiness update has no exact compiled work-item field binding");
      }
      return {
        agentId: this.runtime.agentId,
        grantId: "oregano:work-items/update",
        subjectPrincipal: this.runtime.servicePrincipal,
        input: {
          resource_binding: this.runtime.workItem.resourceBinding,
          work_item_id: intent.work_item_id,
          expected_version: intent.expected_version,
          changes: { [this.runtime.workItem.readinessField]: intent.target_status },
        },
      };
    }
    if (intent.type === "work-item.rollover" || intent.type === "work-item.rollover-proposal") {
      // A rollover is a frozen reversible proposal. The ordinary intent worker
      // must never turn it into an effect before a human confirmation is consumed.
      throw new Error("Sprint work-item rollover requires the separate confirmation path");
    }
    throw new Error(`Sprint intent '${intent.type}' has no hosted execution binding`);
  }

  private directBinding(state: SprintState, participantId: string): string {
    const principal = state.participants[participantId]?.communication_principal;
    if (!principal) throw new Error(`Sprint participant '${participantId}' lacks a canonical communication principal`);
    const binding = this.runtime.directDestinations[principal];
    if (!binding) throw new Error(`Sprint participant '${participantId}' lacks an exact compiled direct-message destination`);
    return binding;
  }
}

/** Freeze one R3 batch Tool input from a durable proposal without performing an effect. */
export function sprintRolloverToolRequest(args: {
  compiled: CompiledSprintRuntime;
  intent: Extract<SprintIntent, { type: "work-item.rollover-proposal" }>;
}) {
  if (!args.compiled.workItem) throw new Error("Sprint Rollover has no exact compiled work-item binding");
  if (args.intent.items.length < 1) throw new Error("Sprint Rollover proposal contains no eligible work items");
  return {
    agentId: args.compiled.agentId,
    grantId: "oregano:work-items/batch-update",
    subjectPrincipal: args.compiled.servicePrincipal,
    input: {
      resource_binding: args.compiled.workItem.resourceBinding,
      updates: args.intent.items.map((item) => ({
        work_item_id: item.work_item_id,
        expected_version: item.expected_version,
        changes: { [args.compiled.workItem!.rolloverField]: args.intent.target_sprint_id },
      })),
    },
  };
}

export interface HostedSprintRuntimeInspection {
  definitionId: string;
  agentId: string;
  mode: SprintRuntimeMode;
  scheduleActivation: "blocked" | "active";
  stateVersion: number;
  sprintId: string | null;
  phase: SprintState["phase"];
  participantCount: number;
  workItemCount: number;
  lastEventAt: string | null;
  artifactBindingsDigest: string;
}

/**
 * Hosted facade for the pure Sprint domain. It supplies no company values:
 * the compiled Artifact and a separately resolved snapshot are mandatory.
 */
export class HostedSprintRuntime {
  readonly compiled: CompiledSprintRuntime;
  readonly mode: SprintRuntimeMode;
  readonly service: SprintOrchestrationService;
  readonly store: SprintOrchestrationStore;
  readonly activeDispatcher?: SprintIntentDispatcher;

  constructor(args: {
    instanceId: string;
    compiled: CompiledSprintRuntime;
    mode: SprintRuntimeMode;
    store: SprintOrchestrationStore;
    timers: DurableTimerService;
    activeDispatcher?: SprintIntentDispatcher;
  }) {
    this.compiled = structuredClone(args.compiled);
    this.mode = args.mode;
    this.store = args.store;
    this.activeDispatcher = args.activeDispatcher;
    this.service = new SprintOrchestrationService({
      instanceId: args.instanceId,
      policy: this.compiled.policy,
      calendar: this.compiled.calendar,
      store: args.store,
      timers: args.timers,
      scheduleVersion: this.compiled.schedule.sourceDigest,
      weeklyTriggers: this.compiled.schedule.triggers,
    });
    if (this.mode === "active" && !this.activeDispatcher) {
      throw new Error("Active Sprint runtime requires an exact intent dispatcher");
    }
  }

  async inspect(): Promise<HostedSprintRuntimeInspection> {
    const stored = await this.store.getState({ instanceId: this.service.instanceId, definitionId: this.compiled.definitionId });
    const state = stored?.state;
    return {
      definitionId: this.compiled.definitionId,
      agentId: this.compiled.agentId,
      mode: this.mode,
      scheduleActivation: this.compiled.schedule.activation,
      stateVersion: stored?.stateVersion ?? 0,
      sprintId: state?.sprint_id ?? null,
      phase: state?.phase ?? "idle",
      participantCount: Object.keys(state?.participants ?? {}).length,
      workItemCount: Object.keys(state?.work_items ?? {}).length,
      lastEventAt: state?.last_event_at ?? null,
      artifactBindingsDigest: sha256({
        definition_id: this.compiled.definitionId,
        agent_id: this.compiled.agentId,
        service_principal: this.compiled.servicePrincipal,
        participant_identity_prefix: this.compiled.participantIdentityPrefix,
        schedule_digest: this.compiled.schedule.sourceDigest,
        direct_destinations: this.compiled.directDestinations,
        direct_assignments: this.compiled.directAssignments,
        work_item: this.compiled.workItem,
      }),
    };
  }

  async open(args: {
    sprintId: string;
    periodStart: string;
    periodEnd: string;
    openedAt: string;
    snapshot: SprintSnapshot;
    excludedParticipantIds?: string[];
    nextSprintId?: string;
  }) {
    if (this.mode === "disabled") throw new Error("Sprint runtime is disabled");
    exactIso(args.openedAt, "Sprint openedAt");
    exactIso(args.snapshot.observedAt, "Sprint snapshot observedAt");
    exactDate(args.periodStart, "Sprint periodStart");
    exactDate(args.periodEnd, "Sprint periodEnd");
    const requiredYears = new Set([args.periodStart.slice(0, 4), args.periodEnd.slice(0, 4)]);
    const missingYear = [...requiredYears].find((year) => !this.compiled.schedule.holidaysByYear[year]);
    if (this.compiled.schedule.missingYearPolicy === "block" && missingYear) {
      throw new Error(`Sprint calendar year '${missingYear}' is not configured`);
    }
    const snapshotEventAt = args.snapshot.observedAt < args.openedAt ? args.openedAt : args.snapshot.observedAt;
    const excluded = new Set(args.excludedParticipantIds ?? []);
    if (excluded.size !== (args.excludedParticipantIds?.length ?? 0)) throw new Error("Excluded Sprint participant ids must be unique");
    for (const participantId of excluded) {
      if (!args.snapshot.participants.some((candidate) => candidate.participant_id === participantId)) {
        throw new Error(`Excluded Sprint participant '${participantId}' is not present in the reviewed snapshot`);
      }
    }
    const participants = args.snapshot.participants.map((participant) => ({
      ...structuredClone(participant),
      approved_absence: participant.approved_absence || excluded.has(participant.participant_id),
    }));
    const prior = await this.store.getState({ instanceId: this.service.instanceId, definitionId: this.compiled.definitionId });
    const carryForward = prior?.state.phase === "closed" ? Object.fromEntries(Object.entries(prior.state.submissions).flatMap(([participantId, submissions]) => {
      const latest = submissions.filter((submission) => submission.complete && submission.next_week)
        .sort((left, right) => left.received_at.localeCompare(right.received_at)).at(-1);
      return latest?.next_week ? [[participantId, structuredClone(latest.next_week)]] : [];
    })) : {};
    const opened = await this.service.openSprint({
      event: {
        type: "sprint.opened",
        event_id: `host:${sha256([this.compiled.definitionId, args.sprintId, args.periodStart, args.periodEnd])}`,
        occurred_at: args.openedAt,
        sprint_id: args.sprintId,
        period_start: args.periodStart,
        period_end: args.periodEnd,
      },
      ...(args.nextSprintId ? { nextSprintId: args.nextSprintId } : {}),
      scheduleVersion: this.compiled.schedule.sourceDigest,
    });
    const participantEvent = await this.service.processEvent({
      type: "participants.observed",
      event_id: `snapshot:participants:${sha256([this.compiled.definitionId, args.sprintId, args.snapshot.participantSourceVersion])}`,
      occurred_at: snapshotEventAt,
      participants,
    });
    if (Object.keys(carryForward).length > 0) {
      await this.service.processEvent({
        type: "carry-forward.observed",
        event_id: `carry-forward:${sha256([this.compiled.definitionId, args.sprintId, carryForward])}`,
        occurred_at: snapshotEventAt,
        plans: carryForward,
      });
    }
    const workItemEvent = await this.service.processEvent({
      type: "work-items.observed",
      event_id: `snapshot:work-items:${sha256([this.compiled.definitionId, args.sprintId, args.snapshot.workItemSourceVersion])}`,
      occurred_at: snapshotEventAt,
      work_items: structuredClone(args.snapshot.workItems),
    });
    return {
      opened: opened.status,
      timers: opened.timers,
      participants: participantEvent.status,
      workItems: workItemEvent.status,
      stateVersion: workItemEvent.outcome.stateVersion,
    };
  }

  async ingestSlackSubmission(args: { messageId: string; occurredAt: string; principal: string; threadReference: string; text: string }) {
    if (this.mode === "disabled") return { accepted: false as const, reason: "runtime-disabled" as const };
    const stored = await this.store.getState({ instanceId: this.service.instanceId, definitionId: this.compiled.definitionId });
    if (!stored) return { accepted: false as const, reason: "no-open-sprint" as const };
    const event = normalizeSlackFridaySubmission({
      messageId: args.messageId,
      occurredAt: args.occurredAt,
      participantPrincipal: args.principal,
      threadReference: args.threadReference,
      text: args.text,
      state: stored.state,
      policy: this.compiled.policy,
    });
    const result = await this.service.processEvent(event);
    return { accepted: true as const, status: result.status, stateVersion: result.outcome.stateVersion };
  }

  /**
   * Refresh mutable work facts from a newly stabilized projection while
   * retaining the participant scope frozen when the Sprint was opened.
   */
  async refreshWorkItems(args: { snapshot: SprintSnapshot; refreshedAt: string }) {
    if (this.mode === "disabled") throw new Error("Sprint runtime is disabled");
    exactIso(args.refreshedAt, "Sprint refresh time");
    exactIso(args.snapshot.observedAt, "Sprint refresh snapshot observedAt");
    if (args.snapshot.observedAt > args.refreshedAt) throw new Error("Sprint refresh snapshot must not come from the future");
    const stored = await this.store.getState({ instanceId: this.service.instanceId, definitionId: this.compiled.definitionId });
    if (!stored?.state.sprint_id) return { refreshed: false as const, reason: "no-open-sprint" as const };
    const result = await this.service.processEvent({
      type: "work-items.observed",
      event_id: `refresh:work-items:${sha256([this.compiled.definitionId, stored.state.sprint_id, args.snapshot.workItemSourceVersion])}`,
      occurred_at: args.snapshot.observedAt,
      work_items: structuredClone(args.snapshot.workItems),
    });
    return { refreshed: true as const, status: result.status, stateVersion: result.outcome.stateVersion };
  }

  async processDueTimers(args: { now: string; owner: string; leaseToken: string; leaseExpiresAt: string; limit?: number }) {
    this.assertScheduledWorkerEnabled();
    return this.service.processDueTimers(args);
  }

  async dispatchIntents(args: { now: string; owner: string; leaseToken: string; leaseExpiresAt: string; limit?: number }) {
    this.assertScheduledWorkerEnabled();
    const providerDispatcher = this.mode === "shadow" ? new ShadowSprintIntentDispatcher(this.compiled) : this.activeDispatcher!;
    const dispatcher: SprintIntentDispatcher = {
      dispatch: async (dispatchArgs) => {
        const intent = dispatchArgs.claimed.intent;
        if (intent.type === "work-item.rollover-proposal" || intent.type === "work-item.rollover") {
          return {
            dispatcherId: "sprint-proposal",
            executionId: `proposal:${dispatchArgs.definitionId}:${intent.intent_id}`,
            outcomeDigest: sha256({
              mode: "proposal-only",
              definition_id: dispatchArgs.definitionId,
              intent,
            }),
          };
        }
        return providerDispatcher.dispatch(dispatchArgs);
      },
    };
    return this.service.dispatchIntents({ ...args, dispatcher });
  }

  private assertScheduledWorkerEnabled(): void {
    if (this.mode === "disabled") throw new Error("Sprint runtime is disabled");
    if (this.mode === "active" && this.compiled.schedule.activation !== "active") {
      throw new Error("Sprint schedule is blocked in the compiled Workspace manifest");
    }
  }
}

export function createCompanyOSSprintDispatcher(args: {
  compiled: CompiledSprintRuntime;
  runtime: { execute(request: import("./companyos-runtime.ts").ExecuteToolRequest): Promise<unknown> };
}): SprintIntentDispatcher {
  return new CompanyOSSprintIntentDispatcher({
    runtime: args.runtime,
    resolver: new CompiledSprintToolExecutionResolver(args.compiled),
  });
}
