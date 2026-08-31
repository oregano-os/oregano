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
  if (args.event.type !== "clock.reached" || !state.sprint_id || !state.period_end || state.phase === "closed") return { state, intents, evidence };

  const schedule = sprintCloseSchedule({ policy: args.policy, periodEnd: state.period_end, calendar: args.calendar });
  const instant = args.event.instant;
  const close = buildSprintCloseReadModel({ state, policy: args.policy, reportAt: schedule.report_at });
  if (instant >= schedule.report_at) {
    state.phase = "reporting";
    const participantStates = Object.fromEntries(close.participants.filter((participant) => participant.included).map((participant) => [participant.participant_id, participant.close_state]));
    intents.push({
      type: "message.close-report",
      intent_id: intentId("close-report", state.sprint_id, schedule.report_at),
      channel_binding: args.policy.delivery.channel_binding,
      due_at: schedule.report_at,
      participant_states: participantStates,
    });
    if (args.event.next_sprint_id) {
      for (const item of close.open_work_items) intents.push({
        type: "work-item.rollover",
        intent_id: intentId("rollover", state.sprint_id, args.event.next_sprint_id, item.work_item_id),
        work_item_id: item.work_item_id,
        target_sprint_id: args.event.next_sprint_id,
      });
    }
    evidence.push({ rule: "friday-close-report", outcome: "report-and-rollover-intents", facts: { report_at: schedule.report_at, included_participants: close.participants.filter((participant) => participant.included).length, open_work_items: close.open_work_items.length } });
    return { state, intents, evidence };
  }

  if (instant >= schedule.reminder_at) {
    const deadline = instant >= schedule.complete_by;
    state.phase = "reminding";
    for (const participant of close.participants.filter((item) => item.included && item.close_state !== "complete")) {
      intents.push({
        type: "message.reminder",
        intent_id: intentId("reminder", state.sprint_id, participant.participant_id, deadline ? schedule.complete_by : schedule.reminder_at),
        participant_id: participant.participant_id,
        channel_binding: args.policy.delivery.channel_binding,
        due_at: deadline ? schedule.complete_by : schedule.reminder_at,
        reason: deadline ? "deadline" : "initial",
      });
    }
    evidence.push({ rule: deadline ? "completion-deadline" : "initial-reminder", outcome: "reminder-intents", facts: { recipient_count: intents.length } });
  }
  return { state, intents, evidence };
}
