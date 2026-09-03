import type { JsonValue } from "../capabilities/contracts.ts";
import type { CompiledSprintRuntime } from "../companyos-builder/types.ts";
import type { SprintParticipant, SprintWorkItem } from "../domains/sprint/contracts.ts";
import type { RecordProjectionRow } from "../records/contracts.ts";
import type { RosterMember } from "../state-store/roster.ts";
import type { SprintSnapshot } from "./sprint-host.ts";

const text = (value: unknown, label: string, maximum = 255): string => {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) throw new Error(`${label} is invalid`);
  return value;
};

const optionalText = (value: unknown, label: string, maximum = 255): string => {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > maximum) throw new Error(`${label} is invalid`);
  return value;
};

const stringArray = (value: unknown, label: string, maximum = 10_000): string[] => {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${label} must be a bounded string list`);
  }
  return [...new Set(value as string[])];
};

const active = (member: RosterMember): boolean => /^(?:active|aktiv)$/i.test(member.status);
const slackPrincipal = (member: RosterMember): string | undefined => member.principals?.find((principal) => principal.startsWith("slack:"));

function providerSubjectMap(roster: RosterMember[], principalPrefix: string): Map<string, string> {
  const resolved = new Map<string, string>();
  for (const member of roster) {
    if (!member.id) continue;
    for (const principal of member.principals ?? []) {
      if (!principal.startsWith(principalPrefix)) continue;
      const subject = principal.slice(principalPrefix.length);
      if (!subject) continue;
      const existing = resolved.get(subject);
      if (existing && existing !== member.id) throw new Error(`Provider subject '${subject}' maps to more than one roster member`);
      resolved.set(subject, member.id);
    }
  }
  return resolved;
}

function participants(args: {
  roster: RosterMember[];
  compiled: CompiledSprintRuntime;
  rows: RecordProjectionRow[];
}): { participants: SprintParticipant[]; providerSubjects: Map<string, string> } {
  const rosterGroup = args.compiled.policy.participants.roster_group;
  if (!rosterGroup) throw new Error("Hosted Sprint participant resolution requires a reviewed roster group");
  const members = args.roster.filter((member) => active(member)
    && !["agent", "service"].includes(member.type ?? "human")
    && member.groups?.includes(rosterGroup));
  const byId = new Map(members.flatMap((member) => member.id ? [[member.id, member] as const] : []));
  if (byId.size !== members.length) throw new Error("Every Sprint participant requires a unique Workspace roster id");
  const subjects = providerSubjectMap(members, args.compiled.participantIdentityPrefix);
  const roles = new Map<string, Set<string>>();
  for (const row of args.rows) {
    const values = row.values as Record<string, JsonValue>;
    const role = typeof values.role === "string" && values.role ? values.role : undefined;
    const canonicalId = typeof values.participant_id === "string" ? values.participant_id : undefined;
    const personIds = canonicalId ? [canonicalId] : Array.isArray(values.person_ids)
      ? values.person_ids.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    for (const providerId of personIds) {
      const memberId = byId.has(providerId) ? providerId : subjects.get(providerId);
      if (!memberId || !role) continue;
      const assigned = roles.get(memberId) ?? new Set<string>();
      assigned.add(role);
      roles.set(memberId, assigned);
    }
  }
  return {
    participants: members.map((member) => {
      const principal = slackPrincipal(member);
      if (!member.id || !principal) throw new Error(`Sprint roster member '${member.name}' lacks a stable id or Slack principal`);
      if (!args.compiled.directDestinations[principal]) throw new Error(`Sprint roster member '${member.id}' has no exact direct-message destination binding`);
      const projectedRoles = [...(roles.get(member.id) ?? [])].sort();
      if (projectedRoles.length === 0) throw new Error(`Sprint roster member '${member.id}' has no verified role projection mapping`);
      return {
        participant_id: member.id,
        display_name: member.name,
        roles: projectedRoles,
        communication_principal: principal,
        approved_absence: false,
      };
    }).sort((left, right) => left.participant_id.localeCompare(right.participant_id)),
    providerSubjects: subjects,
  };
}

function optionalNumber(value: JsonValue | undefined, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`);
  return value;
}

function workItems(rows: RecordProjectionRow[], providerSubjects: Map<string, string>): SprintWorkItem[] {
  return rows.map((row) => {
    const values = row.values as Record<string, JsonValue>;
    const providerAssignees = stringArray(values.assignee_ids ?? [], `Sprint work item '${row.record_id}' assignee_ids`);
    const plannedEffort = optionalNumber(values.planned_effort, `Sprint work item '${row.record_id}' planned_effort`);
    const actualHours = optionalNumber(values.actual_hours, `Sprint work item '${row.record_id}' actual_hours`);
    return {
      work_item_id: text(values.work_item_id, `Sprint work item '${row.record_id}' work_item_id`),
      title: text(values.title, `Sprint work item '${row.record_id}' title`, 2_000),
      assignee_ids: providerAssignees.map((id) => providerSubjects.get(id) ?? `provider:${id}`),
      group: text(values.group, `Sprint work item '${row.record_id}' group`),
      status: optionalText(values.status, `Sprint work item '${row.record_id}' status`),
      ...(plannedEffort === undefined ? {} : { planned_effort: plannedEffort }),
      ...(actualHours === undefined ? {} : { actual_hours: actualHours }),
      ...(typeof values.url === "string" && values.url ? { url: values.url } : {}),
      provider_version: text(values.provider_version ?? row.source_version_id, `Sprint work item '${row.record_id}' provider_version`),
      fields: structuredClone(values),
    };
  }).sort((left, right) => left.work_item_id.localeCompare(right.work_item_id));
}

/**
 * Convert canonical Company Records projections plus reviewed roster identities
 * into the provider-neutral snapshot consumed by the Sprint domain. It never
 * matches people by display name.
 */
export function normalizeSprintSnapshot(args: {
  roster: RosterMember[];
  compiled: CompiledSprintRuntime;
  participantRows: RecordProjectionRow[];
  workItemRows: RecordProjectionRow[];
  observedAt: string;
  participantSourceVersion: string;
  workItemSourceVersion: string;
}): SprintSnapshot {
  const participantSnapshot = participants({ roster: args.roster, compiled: args.compiled, rows: args.participantRows });
  return {
    participants: participantSnapshot.participants,
    workItems: workItems(args.workItemRows, participantSnapshot.providerSubjects),
    observedAt: args.observedAt,
    participantSourceVersion: args.participantSourceVersion,
    workItemSourceVersion: args.workItemSourceVersion,
  };
}
