import type { JsonValue } from "../../capabilities/contracts.ts";

export type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

export interface SprintDomainDeclaration {
  schema_version: 1;
  id: string;
  participants: {
    projection: string;
    absence_policy: "exclude-approved" | "include-all";
    roster_group?: string;
  };
  work_items: {
    projection: string;
    master_group: string;
    ready_status: string;
    closed_statuses: string[];
    planning_group?: string;
    planned_status?: string;
    required_fields?: string[];
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
    chase_time?: string;
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
  weekly?: {
    monday_handoff_trigger: string;
    weekday_digest_trigger: string;
    readiness_weekday: Weekday;
  };
  model_task_profile?: string;
  rendering?: {
    reminder: string;
    chase: string;
    close_report: string;
    retro: string;
    monday_handoff?: string;
    weekday_digest?: string;
    direct_question?: string;
  };
}

export interface SprintNextWeekTask {
  title: string;
  url?: string;
  work_item_id?: string;
}

export interface SprintNextWeekPlan {
  goal: string;
  measurable_outcome: string;
  tasks: SprintNextWeekTask[];
}

export interface SprintSubmissionSourceReference {
  projection_id: string;
  record_id: string;
  source_version_id: string;
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
  | { type: "submission.received"; event_id: string; occurred_at: string; participant_id: string; submission_id: string; task_ids: string[]; complete: boolean; next_week?: SprintNextWeekPlan; source_record?: SprintSubmissionSourceReference }
  | { type: "carry-forward.observed"; event_id: string; occurred_at: string; plans: Record<string, SprintNextWeekPlan> }
  | { type: "clock.reached"; event_id: string; occurred_at: string; instant: string; trigger_id?: string; next_sprint_id?: string }
  | { type: "message.delivered"; event_id: string; occurred_at: string; intent_id: string; purpose: "monday-handoff" | "weekday-digest" | "direct-question" | "close-reminder" | "close-chase" | "close-report" | "retro"; destination_binding: string; message_id: string; thread_reference: string; participant_id?: string }
  | { type: "sprint.closed"; event_id: string; occurred_at: string; sprint_id: string };

export interface SprintMessageDelivery {
  intent_id: string;
  purpose: "monday-handoff" | "weekday-digest" | "direct-question" | "close-reminder" | "close-chase" | "close-report" | "retro";
  destination_binding: string;
  message_id: string;
  thread_reference: string;
  delivered_at: string;
  participant_id?: string;
}

export interface SprintSubmissionState {
  submission_id: string;
  participant_id: string;
  received_at: string;
  task_ids: string[];
  complete: boolean;
  next_week?: SprintNextWeekPlan;
}

export interface SprintWorkItemChange {
  work_item_id: string;
  title: string;
  previous_version?: string;
  provider_version: string;
  changed_fields: string[];
}

export interface SprintState {
  sprint_id: string | null;
  period_start: string | null;
  period_end: string | null;
  phase: "idle" | "open" | "reminding" | "reporting" | "closed";
  participants: Record<string, SprintParticipant>;
  work_items: Record<string, SprintWorkItem>;
  submissions: Record<string, SprintSubmissionState[]>;
  carry_forward?: Record<string, SprintNextWeekPlan>;
  work_item_changes?: SprintWorkItemChange[];
  deliveries: Record<string, SprintMessageDelivery>;
  close_thread_reference: string | null;
  next_sprint_id: string | null;
  processed_event_ids: string[];
  last_event_at: string | null;
}

export type SprintIntent =
  | { type: "message.monday-handoff"; intent_id: string; channel_binding: string; due_at: string; committed_work_item_ids: string[]; carry_forward_participant_ids: string[]; disagreements: string[] }
  | { type: "message.weekday-digest"; intent_id: string; channel_binding: string; due_at: string; changed_work_item_ids: string[]; readiness?: Record<string, string[]> }
  | { type: "message.direct-question"; intent_id: string; participant_id: string; due_at: string; work_item_id: string; missing_fields: string[] }
  | { type: "message.close-reminder"; intent_id: string; channel_binding: string; due_at: string; deadline_at?: string }
  | { type: "message.close-chase"; intent_id: string; channel_binding: string; thread_reference: string; due_at: string; deadline_at?: string; participant_states: Record<string, "needs-reformat" | "missing"> }
  | { type: "message.close-report"; intent_id: string; channel_binding: string; thread_reference: string; due_at: string; participant_states: Record<string, "complete" | "needs-reformat" | "missing"> }
  | { type: "message.retro"; intent_id: string; channel_binding: string; thread_reference: string; due_at: string; participant_states: Record<string, "complete" | "needs-reformat" | "missing">; open_work_item_ids: string[]; total_effort_hours: number | null }
  | { type: "work-item.readiness-update"; intent_id: string; work_item_id: string; expected_version: string; target_status: string; reason: "ready" | "invalidated" }
  | { type: "work-item.rollover"; intent_id: string; work_item_id: string; target_sprint_id: string; expected_version: string }
  | { type: "work-item.rollover-proposal"; intent_id: string; target_sprint_id: string; items: Array<{ work_item_id: string; expected_version: string }> }
  | { type: "records.reconcile"; intent_id: string; projection_id: string; due_at: string };

export interface SprintDecision {
  state: SprintState;
  intents: SprintIntent[];
  evidence: Array<{ rule: string; outcome: string; facts: Record<string, JsonValue> }>;
}
