import type { SprintDomainDeclaration, SprintState, SprintSubmissionState, SprintWorkItem } from "./contracts.ts";

export type ParticipantCloseState = "complete" | "needs-reformat" | "missing";

export interface ParticipantSprintReadModel {
  participant_id: string;
  display_name: string;
  included: boolean;
  committed_task_ids: string[];
  submission?: SprintSubmissionState;
  close_state: ParticipantCloseState;
  effort_hours: number | null;
}

export interface SprintCloseReadModel {
  sprint_id: string;
  effort_basis: SprintDomainDeclaration["effort"];
  participants: ParticipantSprintReadModel[];
  total_effort_hours: number | null;
  open_work_items: SprintWorkItem[];
}

const sameSet = (left: string[], right: string[]): boolean => {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
};

const sumComplete = (values: readonly (number | null | undefined)[] | null): number | null => {
  if (values === null || values.some((value) => value === null || value === undefined)) return null;
  return values.reduce<number>((sum, value) => sum + value!, 0);
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
    const selectedEffort = policy.effort === "unavailable"
      ? null
      : committed.map((item) => policy.effort === "actual-hours" ? item.actual_hours : item.planned_effort);
    const effortHours = sumComplete(selectedEffort);
    return {
      participant_id: participant.participant_id,
      display_name: participant.display_name,
      included,
      committed_task_ids: committed.map((item) => item.work_item_id).sort(),
      ...(timely ? { submission: structuredClone(timely) } : {}),
      close_state: closeState,
      effort_hours: effortHours,
    };
  });
  const openWorkItems = items.filter((item) => {
    if (item.group !== policy.work_items.master_group || policy.work_items.closed_statuses.includes(item.status)) return false;
    return policy.rollover.eligible === "all-open" || (policy.rollover.states ?? []).includes(item.status);
  });
  const includedEffort = participants.filter((participant) => participant.included).map((participant) => participant.effort_hours);
  return {
    sprint_id: state.sprint_id,
    effort_basis: policy.effort,
    participants,
    total_effort_hours: sumComplete(includedEffort),
    open_work_items: openWorkItems.map((item) => structuredClone(item)),
  };
}
