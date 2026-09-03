import { recordDigest } from "../../records/identity.ts";
import type { SprintDecision, SprintDomainDeclaration, SprintEvent, SprintIntent, SprintState } from "./contracts.ts";
import { sprintCloseSchedule, type BusinessCalendar } from "./business-time.ts";
import { buildSprintCloseReadModel } from "./read-models.ts";
import { reduceSprintEvent } from "./reducer.ts";

const intentId = (kind: string, ...parts: string[]): string => recordDigest([kind, ...parts]);

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
  if (!state.sprint_id || !state.period_end || state.phase === "closed") return { state, intents, evidence };

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
      for (const item of close.open_work_items) intents.push({
        type: "work-item.rollover",
        intent_id: intentId("rollover", state.sprint_id, state.next_sprint_id, item.work_item_id),
        work_item_id: item.work_item_id,
        target_sprint_id: state.next_sprint_id,
        expected_version: item.provider_version,
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
    });
    evidence.push({ rule: "initial-reminder", outcome: "shared-thread-root-intent", facts: { participant_count: Object.keys(participantStates).length } });
  }
  return { state, intents, evidence };
}
