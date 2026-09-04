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

export interface SprintMondayHandoffReadModel {
  sprint_id: string;
  committed_work_item_ids: string[];
  carry_forward_participant_ids: string[];
  disagreements: string[];
}

export interface SprintReadinessReadModel {
  ready_work_item_ids: string[];
  missing_fields: Record<string, string[]>;
}

export interface SprintWeekdayDigestReadModel {
  changed_work_item_ids: string[];
  readiness?: SprintReadinessReadModel;
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

export function buildSprintMondayHandoffReadModel(args: {
  state: SprintState;
  policy: SprintDomainDeclaration;
}): SprintMondayHandoffReadModel {
  if (!args.state.sprint_id) throw new Error("Sprint Monday handoff requires an open Sprint identity");
  const committed = Object.values(args.state.work_items)
    .filter((item) => item.group === args.policy.work_items.master_group)
    .map((item) => item.work_item_id)
    .sort();
  const carryForward = Object.entries(args.state.carry_forward ?? {})
    .filter(([participantId]) => Boolean(args.state.participants[participantId]))
    .sort(([left], [right]) => left.localeCompare(right));
  const proposed = new Set(carryForward.flatMap(([, plan]) => plan.tasks.flatMap((task) => task.work_item_id ? [task.work_item_id] : [])));
  const committedSet = new Set(committed);
  const disagreements = [
    ...[...proposed].filter((id) => !committedSet.has(id)).map((id) => `proposed-not-committed:${id}`),
    ...committed.filter((id) => !proposed.has(id)).map((id) => `committed-not-proposed:${id}`),
  ].sort();
  return {
    sprint_id: args.state.sprint_id,
    committed_work_item_ids: committed,
    carry_forward_participant_ids: carryForward.map(([participantId]) => participantId),
    disagreements,
  };
}

export function buildSprintReadinessReadModel(args: {
  state: SprintState;
  policy: SprintDomainDeclaration;
}): SprintReadinessReadModel {
  const required = args.policy.work_items.required_fields ?? [];
  const candidates = Object.values(args.state.work_items)
    .filter((item) => !args.policy.work_items.planning_group || item.group === args.policy.work_items.planning_group)
    .filter((item) => !args.policy.work_items.planned_status
      || item.status === args.policy.work_items.planned_status
      || item.status === args.policy.work_items.ready_status)
    .sort((left, right) => left.work_item_id.localeCompare(right.work_item_id));
  const missingFields: Record<string, string[]> = {};
  const ready: string[] = [];
  for (const item of candidates) {
    const missing = required.filter((field) => {
      const value = item.fields[field];
      return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
    });
    if (item.assignee_ids.length !== 1) missing.push("assignee");
    if (missing.length === 0) ready.push(item.work_item_id);
    else missingFields[item.work_item_id] = [...new Set(missing)].sort();
  }
  return { ready_work_item_ids: ready, missing_fields: missingFields };
}

export function buildSprintWeekdayDigestReadModel(args: {
  state: SprintState;
  policy: SprintDomainDeclaration;
  includeReadiness: boolean;
}): SprintWeekdayDigestReadModel {
  return {
    changed_work_item_ids: (args.state.work_item_changes ?? []).map((change) => change.work_item_id).sort(),
    ...(args.includeReadiness ? { readiness: buildSprintReadinessReadModel(args) } : {}),
  };
}
