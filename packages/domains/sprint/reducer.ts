import type { SprintEvent, SprintState } from "./contracts.ts";

export const initialSprintState = (): SprintState => ({
  sprint_id: null,
  period_start: null,
  period_end: null,
  phase: "idle",
  participants: {},
  work_items: {},
  submissions: {},
  deliveries: {},
  close_thread_reference: null,
  next_sprint_id: null,
  processed_event_ids: [],
  last_event_at: null,
});

export function reduceSprintEvent(current: SprintState, event: SprintEvent): SprintState {
  if (current.processed_event_ids.includes(event.event_id)) return structuredClone(current);
  let state = structuredClone(current);
  state.deliveries ??= {};
  state.close_thread_reference ??= null;
  state.next_sprint_id ??= null;
  if (event.type === "sprint.opened") {
    state = {
      ...initialSprintState(),
      sprint_id: event.sprint_id,
      period_start: event.period_start,
      period_end: event.period_end,
      phase: "open",
    };
  } else if (event.type === "participants.observed") {
    state.participants = Object.fromEntries(event.participants.map((participant) => [participant.participant_id, structuredClone(participant)]));
  } else if (event.type === "work-items.observed") {
    state.work_items = Object.fromEntries(event.work_items.map((item) => [item.work_item_id, structuredClone(item)]));
  } else if (event.type === "submission.received") {
    const submission = {
      submission_id: event.submission_id,
      participant_id: event.participant_id,
      received_at: event.occurred_at,
      task_ids: [...event.task_ids],
      complete: event.complete,
    };
    state.submissions[event.participant_id] = [...(state.submissions[event.participant_id] ?? []), submission]
      .sort((left, right) => left.received_at.localeCompare(right.received_at));
  } else if (event.type === "clock.reached") {
    if (event.next_sprint_id) state.next_sprint_id = event.next_sprint_id;
  } else if (event.type === "message.delivered") {
    state.deliveries[event.intent_id] = {
      intent_id: event.intent_id,
      purpose: event.purpose,
      destination_binding: event.destination_binding,
      message_id: event.message_id,
      thread_reference: event.thread_reference,
      delivered_at: event.occurred_at,
    };
    if (event.purpose === "close-reminder") state.close_thread_reference = event.thread_reference;
  } else if (event.type === "sprint.closed") {
    state.phase = "closed";
  }
  state.processed_event_ids.push(event.event_id);
  state.last_event_at = !state.last_event_at || event.occurred_at > state.last_event_at
    ? event.occurred_at
    : state.last_event_at;
  return state;
}
