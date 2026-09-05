import { recordDigest } from "../../records/identity.ts";
import type { SprintDecision, SprintDomainDeclaration, SprintEvent, SprintIntent, SprintState } from "./contracts.ts";
import { sprintCloseSchedule, type BusinessCalendar } from "./business-time.ts";
import { buildSprintCloseReadModel, buildSprintMondayHandoffReadModel, buildSprintWeekdayDigestReadModel } from "./read-models.ts";
import { reduceSprintEvent } from "./reducer.ts";

const intentId = (kind: string, ...parts: string[]): string => recordDigest([kind, ...parts]);

const localWeekday = (instant: string, timeZone: string): SprintDomainDeclaration["close"]["weekday"] =>
  new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(new Date(instant)).toLocaleLowerCase("en-US") as SprintDomainDeclaration["close"]["weekday"];

export function decideSprintEvent(args: {
  state: SprintState;
  event: SprintEvent;
  policy: SprintDomainDeclaration;
  calendar: BusinessCalendar;
}): SprintDecision {
  if (args.state.processed_event_ids.includes(args.event.event_id)) {
    return { state: structuredClone(args.state), intents: [], evidence: [{ rule: "event-idempotency", outcome: "duplicate-suppressed", facts: { event_id: args.event.event_id } }] };
  }
  const state = reduceSprintEvent(args.state, args.event);
  const intents: SprintIntent[] = [];
  const evidence: SprintDecision["evidence"] = [{ rule: "event-idempotency", outcome: "accepted", facts: { event_id: args.event.event_id } }];
  if (!state.sprint_id || !state.period_end) return { state, intents, evidence };

  if (args.event.type === "clock.reached" && args.policy.weekly && args.event.trigger_id) {
    if (args.event.trigger_id === args.policy.weekly.monday_handoff_trigger) {
      const handoff = buildSprintMondayHandoffReadModel({ state, policy: args.policy });
      intents.push({
        type: "message.monday-handoff",
        intent_id: intentId("monday-handoff", state.sprint_id, args.event.instant),
        channel_binding: args.policy.delivery.channel_binding,
        due_at: args.event.instant,
        committed_work_item_ids: handoff.committed_work_item_ids,
        carry_forward_participant_ids: handoff.carry_forward_participant_ids,
        disagreements: handoff.disagreements,
      });
      evidence.push({ rule: "weekly-monday-handoff", outcome: "shared-channel-intent", facts: { committed_count: handoff.committed_work_item_ids.length, disagreement_count: handoff.disagreements.length } });
      return { state, intents, evidence };
    }
    if (args.event.trigger_id === args.policy.weekly.weekday_digest_trigger) {
      const includeReadiness = Boolean(args.policy.weekly.readiness_weekday)
        && localWeekday(args.event.instant, args.policy.calendar.timezone) === args.policy.weekly.readiness_weekday;
      const digest = buildSprintWeekdayDigestReadModel({ state, policy: args.policy, includeReadiness });
      intents.push({
        type: "message.weekday-digest",
        intent_id: intentId("weekday-digest", state.sprint_id, args.event.instant),
        channel_binding: args.policy.delivery.channel_binding,
        due_at: args.event.instant,
        changed_work_item_ids: digest.changed_work_item_ids,
        ...(digest.readiness ? { readiness: digest.readiness.missing_fields } : {}),
      });
      if (digest.readiness && args.policy.delivery.direct_binding) {
        const asked = new Set<string>();
        for (const [workItemId, missingFields] of Object.entries(digest.readiness.missing_fields).sort(([left], [right]) => left.localeCompare(right))) {
          const item = state.work_items[workItemId];
          const participantId = item?.assignee_ids.length === 1 ? item.assignee_ids[0] : undefined;
          if (!participantId || asked.has(participantId) || !state.participants[participantId]?.communication_principal) continue;
          asked.add(participantId);
          intents.push({
            type: "message.direct-question",
            intent_id: intentId("direct-question", state.sprint_id, args.event.instant, participantId, workItemId),
            participant_id: participantId,
            due_at: args.event.instant,
            work_item_id: workItemId,
            missing_fields: missingFields,
          });
        }
      }
      if (digest.readiness) {
        const ready = new Set(digest.readiness.ready_work_item_ids);
        for (const item of Object.values(state.work_items).sort((left, right) => left.work_item_id.localeCompare(right.work_item_id))) {
          const shouldMarkReady = ready.has(item.work_item_id) && item.status !== args.policy.work_items.ready_status;
          const shouldInvalidate = Object.hasOwn(digest.readiness.missing_fields, item.work_item_id)
            && item.status === args.policy.work_items.ready_status
            && Boolean(args.policy.work_items.planned_status);
          if (!shouldMarkReady && !shouldInvalidate) continue;
          const targetStatus = shouldMarkReady ? args.policy.work_items.ready_status : args.policy.work_items.planned_status!;
          intents.push({
            type: "work-item.readiness-update",
            intent_id: intentId("readiness-update", state.sprint_id, args.event.instant, item.work_item_id, item.provider_version, targetStatus),
            work_item_id: item.work_item_id,
            expected_version: item.provider_version,
            target_status: targetStatus,
            reason: shouldMarkReady ? "ready" : "invalidated",
          });
        }
      }
      evidence.push({ rule: "weekly-digest", outcome: includeReadiness ? "digest-and-focused-readiness-questions" : "digest", facts: { changed_count: digest.changed_work_item_ids.length, question_count: intents.filter((intent) => intent.type === "message.direct-question").length } });
      return { state, intents, evidence };
    }
  }

  if (state.phase === "closed") return { state, intents, evidence };

  const schedule = sprintCloseSchedule({ policy: args.policy, periodEnd: state.period_end, calendar: args.calendar });
  const close = buildSprintCloseReadModel({ state, policy: args.policy, reportAt: schedule.report_at });
  const participantStates = Object.fromEntries(close.participants
    .filter((participant) => participant.included)
    .map((participant) => [participant.participant_id, participant.close_state]));
  if (args.event.type === "message.delivered" && args.event.purpose === "close-report") {
    intents.push({
      type: "message.retro",
      intent_id: intentId("retro", state.sprint_id, schedule.report_at),
      channel_binding: args.policy.delivery.channel_binding,
      thread_reference: args.event.thread_reference,
      due_at: schedule.report_at,
      participant_states: participantStates,
      open_work_item_ids: close.open_work_items.map((item) => item.work_item_id).sort(),
      total_effort_hours: close.total_effort_hours,
    });
    evidence.push({ rule: "friday-close-order", outcome: "retro-after-process-check", facts: { close_report_intent_id: args.event.intent_id } });
    return { state, intents, evidence };
  }
  if (args.event.type === "message.delivered" && args.event.purpose === "retro") {
    if (state.next_sprint_id) {
      intents.push({
        type: "work-item.rollover-proposal",
        intent_id: intentId("rollover-proposal", state.sprint_id, state.next_sprint_id, ...close.open_work_items.map((item) => `${item.work_item_id}@${item.provider_version}`).sort()),
        target_sprint_id: state.next_sprint_id,
        items: close.open_work_items.map((item) => ({ work_item_id: item.work_item_id, expected_version: item.provider_version }))
          .sort((left, right) => left.work_item_id.localeCompare(right.work_item_id)),
      });
    }
    evidence.push({ rule: "friday-close-order", outcome: "rollover-proposals-after-retro", facts: { retro_intent_id: args.event.intent_id, open_work_items: close.open_work_items.length } });
    return { state, intents, evidence };
  }
  if (args.event.type !== "clock.reached") return { state, intents, evidence };

  const instant = args.event.instant;
  if (instant >= schedule.report_at) {
    if (!state.close_thread_reference) throw new Error("Sprint close report requires the delivered shared Close thread");
    state.phase = "reporting";
    intents.push({
      type: "message.close-report",
      intent_id: intentId("close-report", state.sprint_id, schedule.report_at),
      channel_binding: args.policy.delivery.channel_binding,
      thread_reference: state.close_thread_reference,
      due_at: schedule.report_at,
      participant_states: participantStates,
    });
    evidence.push({ rule: "friday-close-report", outcome: "process-check-intent", facts: { report_at: schedule.report_at, included_participants: close.participants.filter((participant) => participant.included).length, open_work_items: close.open_work_items.length } });
    return { state, intents, evidence };
  }

  if (instant >= schedule.chase_at) {
    if (!state.close_thread_reference) throw new Error("Sprint close chase requires the delivered shared Close thread");
    state.phase = "reminding";
    const incomplete = Object.fromEntries(Object.entries(participantStates)
      .filter(([, value]) => value !== "complete")
      .map(([participantId, value]) => [participantId, value as "needs-reformat" | "missing"]));
    if (Object.keys(incomplete).length > 0) {
      intents.push({
        type: "message.close-chase",
        intent_id: intentId("close-chase", state.sprint_id, schedule.chase_at),
        channel_binding: args.policy.delivery.channel_binding,
        thread_reference: state.close_thread_reference,
        due_at: schedule.chase_at,
        deadline_at: schedule.complete_by,
        participant_states: incomplete,
      });
    }
    evidence.push({ rule: "completion-chase", outcome: "shared-thread-chase-intent", facts: { recipient_count: Object.keys(incomplete).length } });
    return { state, intents, evidence };
  }
  if (instant >= schedule.reminder_at) {
    state.phase = "reminding";
    intents.push({
      type: "message.close-reminder",
      intent_id: intentId("close-reminder", state.sprint_id, schedule.reminder_at),
      channel_binding: args.policy.delivery.channel_binding,
      due_at: schedule.reminder_at,
      deadline_at: schedule.complete_by,
    });
    evidence.push({ rule: "initial-reminder", outcome: "shared-thread-root-intent", facts: { participant_count: Object.keys(participantStates).length } });
  }
  return { state, intents, evidence };
}
