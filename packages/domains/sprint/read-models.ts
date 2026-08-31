import type { SprintDomainDeclaration, SprintState, SprintSubmissionState, SprintWorkItem } from "./contracts.ts";

export type ParticipantCloseState = "complete" | "needs-reformat" | "missing";

export interface ParticipantSprintReadModel {
  participant_id: string;
  display_name: string;
  included: boolean;
  committed_task_ids: string[];
  submission?: SprintSubmissionState;
  close_state: ParticipantCloseState;
  actual_hours: number;
}

export interface SprintCloseReadModel {
  sprint_id: string;
  participants: ParticipantSprintReadModel[];
  total_actual_hours: number;
  open_work_items: SprintWorkItem[];
}

const sameSet = (left: string[], right: string[]): boolean => {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
};

export function buildSprintCloseReadModel(args: {
  state: SprintState;
  policy: SprintDomainDeclaration;
  reportAt: string;
}): SprintCloseReadModel {
  const { state, policy, reportAt } = args;
  if (!state.sprint_id) throw new Error("Sprint close read model requires an open Sprint identity");
  const items = Object.values(state.work_items);
  const participants = Object.values(state.participants).sort((a, b) => a.display_name.localeCompare(b.display_name)).map((participant): ParticipantSprintReadModel => {
    const included = !(policy.participants.absence_policy === "exclude-approved" && participant.approved_absence);
    const committed = items.filter((item) => item.group === policy.work_items.master_group && item.assignee_ids.includes(participant.participant_id));
    const timely = (state.submissions[participant.participant_id] ?? [])
      .filter((submission) => submission.received_at <= reportAt)
      .sort((left, right) => left.received_at.localeCompare(right.received_at))
      .at(-1);
    const closeState: ParticipantCloseState = !included || (timely?.complete && sameSet(timely.task_ids, committed.map((item) => item.work_item_id)))
      ? "complete"
      : timely ? "needs-reformat" : "missing";
    return {
      participant_id: participant.participant_id,
      display_name: participant.display_name,
      included,
      committed_task_ids: committed.map((item) => item.work_item_id).sort(),
      ...(timely ? { submission: structuredClone(timely) } : {}),
      close_state: closeState,
      actual_hours: committed.reduce((sum, item) => sum + (item.actual_hours ?? 0), 0),
    };
  });
  const openWorkItems = items.filter((item) => {
    if (item.group !== policy.work_items.master_group || policy.work_items.closed_statuses.includes(item.status)) return false;
    return policy.rollover.eligible === "all-open" || (policy.rollover.states ?? []).includes(item.status);
  });
  return {
    sprint_id: state.sprint_id,
    participants,
    total_actual_hours: participants.filter((participant) => participant.included).reduce((sum, participant) => sum + participant.actual_hours, 0),
    open_work_items: openWorkItems.map((item) => structuredClone(item)),
  };
}
