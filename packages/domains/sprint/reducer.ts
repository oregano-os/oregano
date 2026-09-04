import type { SprintEvent, SprintState } from "./contracts.ts";

export const initialSprintState = (): SprintState => ({
  sprint_id: null,
  period_start: null,
  period_end: null,
  phase: "idle",
  participants: {},
  work_items: {},
  submissions: {},
  carry_forward: {},
  work_item_changes: [],
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
  state.carry_forward ??= {};
  state.work_item_changes ??= [];
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
    const changes = event.work_items.flatMap((item) => {
      const previous = state.work_items[item.work_item_id];
      if (!previous) return [{
        work_item_id: item.work_item_id,
        title: item.title,
        provider_version: item.provider_version,
        changed_fields: ["created"],
      }];
      if (previous.provider_version === item.provider_version) return [];
      const changedFields = ["title", "assignee_ids", "group", "status", "planned_effort", "actual_hours", "url", "fields"]
        .filter((field) => JSON.stringify(previous[field as keyof typeof previous]) !== JSON.stringify(item[field as keyof typeof item]));
      return [{
        work_item_id: item.work_item_id,
        title: item.title,
        previous_version: previous.provider_version,
        provider_version: item.provider_version,
        changed_fields: changedFields.length > 0 ? changedFields : ["provider_version"],
      }];
    });
    state.work_items = Object.fromEntries(event.work_items.map((item) => [item.work_item_id, structuredClone(item)]));
    state.work_item_changes = changes;
  } else if (event.type === "submission.received") {
    const submission = {
      submission_id: event.submission_id,
      participant_id: event.participant_id,
      received_at: event.occurred_at,
      task_ids: [...event.task_ids],
      complete: event.complete,
      ...(event.next_week ? { next_week: structuredClone(event.next_week) } : {}),
    };
    state.submissions[event.participant_id] = [...(state.submissions[event.participant_id] ?? []), submission]
      .sort((left, right) => left.received_at.localeCompare(right.received_at));
  } else if (event.type === "carry-forward.observed") {
    state.carry_forward = structuredClone(event.plans);
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
      ...(event.participant_id ? { participant_id: event.participant_id } : {}),
    };
    if (event.purpose === "close-reminder") state.close_thread_reference = event.thread_reference;
    if (event.purpose === "weekday-digest") state.work_item_changes = [];
  } else if (event.type === "sprint.closed") {
    state.phase = "closed";
  }
  state.processed_event_ids.push(event.event_id);
  state.last_event_at = !state.last_event_at || event.occurred_at > state.last_event_at
    ? event.occurred_at
    : state.last_event_at;
  return state;
}
