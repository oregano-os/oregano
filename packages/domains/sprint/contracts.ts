import type { JsonValue } from "../../capabilities/contracts.ts";

export type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

export interface SprintDomainDeclaration {
  schema_version: 1;
  id: string;
  participants: {
    projection: string;
    absence_policy: "exclude-approved" | "include-all";
  };
  work_items: {
    projection: string;
    master_group: string;
    ready_status: string;
    closed_statuses: string[];
  };
  calendar: {
    timezone: string;
    business_calendar_ref: string;
    holiday_shift: "previous-business-day" | "next-business-day" | "none";
  };
  close: {
    weekday: Weekday;
    reminder_time: string;
    complete_by: string;
    report_at: string;
  };
  submission: {
    task_line_rule: "one-per-committed-task";
    after_report: "provider-only" | "next-report" | "reject";
  };
  effort: "actual-hours" | "planned-effort" | "unavailable";
  rollover: {
    eligible: "all-open" | "selected-states";
    states?: string[];
  };
  delivery: {
    shared_thread: boolean;
    channel_binding: string;
    direct_binding?: string;
  };
  model_task_profile?: string;
}

export interface SprintParticipant {
  participant_id: string;
  display_name: string;
  roles: string[];
  communication_principal?: string;
  approved_absence: boolean;
}

export interface SprintWorkItem {
  work_item_id: string;
  title: string;
  assignee_ids: string[];
  group: string;
  status: string;
  planned_effort?: number;
  actual_hours?: number;
  url?: string;
  provider_version: string;
  fields: Record<string, JsonValue>;
}

export type SprintEvent =
  | { type: "sprint.opened"; event_id: string; occurred_at: string; sprint_id: string; period_start: string; period_end: string }
  | { type: "participants.observed"; event_id: string; occurred_at: string; participants: SprintParticipant[] }
  | { type: "work-items.observed"; event_id: string; occurred_at: string; work_items: SprintWorkItem[] }
  | { type: "submission.received"; event_id: string; occurred_at: string; participant_id: string; submission_id: string; task_ids: string[]; complete: boolean }
  | { type: "clock.reached"; event_id: string; occurred_at: string; instant: string; next_sprint_id?: string }
  | { type: "sprint.closed"; event_id: string; occurred_at: string; sprint_id: string };

export interface SprintSubmissionState {
  submission_id: string;
  participant_id: string;
  received_at: string;
  task_ids: string[];
  complete: boolean;
}

export interface SprintState {
  sprint_id: string | null;
  period_start: string | null;
  period_end: string | null;
  phase: "idle" | "open" | "reminding" | "reporting" | "closed";
  participants: Record<string, SprintParticipant>;
  work_items: Record<string, SprintWorkItem>;
  submissions: Record<string, SprintSubmissionState[]>;
  processed_event_ids: string[];
  last_event_at: string | null;
}

export type SprintIntent =
  | { type: "message.reminder"; intent_id: string; participant_id: string; destination_principal: string; destination_binding: string; due_at: string; reason: "initial" | "deadline" }
  | { type: "message.close-report"; intent_id: string; channel_binding: string; due_at: string; participant_states: Record<string, "complete" | "needs-reformat" | "missing"> }
  | { type: "work-item.rollover"; intent_id: string; work_item_id: string; target_sprint_id: string; expected_version: string }
  | { type: "records.reconcile"; intent_id: string; projection_id: string; due_at: string };

export interface SprintDecision {
  state: SprintState;
  intents: SprintIntent[];
  evidence: Array<{ rule: string; outcome: string; facts: Record<string, JsonValue> }>;
}
