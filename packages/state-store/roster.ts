// Roster check (Spec §6.1, plain lookup — no OAuth). Canonical principals are
// surface-qualified. Slack uses slack:<team-id>:<user-id>; other surfaces
// declare an explicit identities.<surface>.principal. Runner-neutral: operates
// on the roster markdown string; loading the file is the runtime's job.

import YAML from "yaml";

export interface RosterMember {
  role: string;
  name: string;
  teamId?: string;
  userId?: string;
  mayApprove: string[];
  /** "aktiv"/"active" unless the roster says otherwise (identity spec §5). */
  status: string;
  /** "agent" for bot identities — agents never approve (identity spec §2). */
  type?: string;
  /** Canonical identities across all configured surfaces. */
  principals?: string[];
  /** Stable authorization groups. Group membership is Core-derived, never Tool input. */
  groups?: string[];
}

export function slackPrincipal(teamId: string, userId: string): string {
  return `slack:${teamId}:${userId}`;
}

/** Parse roster.md frontmatter without coupling identity to one Runner surface. */
export function parseRoster(markdown: string): RosterMember[] {
  const fm = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return [];
  const data = YAML.parse(fm[1]);
  if (!Array.isArray(data?.members)) return [];
  return data.members.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const member = entry as Record<string, unknown>;
    if (typeof member.role !== "string" || typeof member.name !== "string") return [];
    const identities = member.identities && typeof member.identities === "object" && !Array.isArray(member.identities)
      ? member.identities as Record<string, unknown>
      : {};
    const slack = identities.slack && typeof identities.slack === "object" && !Array.isArray(identities.slack)
      ? identities.slack as Record<string, unknown>
      : {};
    const teamId = typeof slack.team_id === "string" ? slack.team_id : undefined;
    const userId = typeof slack.user_id === "string" ? slack.user_id : undefined;
    const principals = new Set<string>();
    for (const identity of Object.values(identities)) {
      if (!identity || typeof identity !== "object" || Array.isArray(identity)) continue;
      const principal = (identity as Record<string, unknown>).principal;
      if (typeof principal === "string" && principal.length > 0) principals.add(principal);
    }
    if (teamId && userId) principals.add(slackPrincipal(teamId, userId));
    return [{
      role: member.role,
      name: member.name,
      teamId,
      userId,
      mayApprove: Array.isArray(member.may_approve)
        ? member.may_approve.filter((value): value is string => typeof value === "string")
        : [],
      status: typeof member.status === "string" ? member.status : "active",
      type: typeof member.type === "string" ? member.type : undefined,
      principals: [...principals].sort(),
      groups: Array.isArray(member.groups)
        ? [...new Set(member.groups.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))].sort()
        : [],
    }];
  });
}

export function findByPrincipal(
  roster: RosterMember[],
  teamId: string,
  userId: string,
): RosterMember | undefined {
  return roster.find((m) => m.teamId === teamId && m.userId === userId);
}

export function findByCanonicalPrincipal(roster: RosterMember[], principal: string): RosterMember | undefined {
  return roster.find((member) =>
    member.principals?.includes(principal) ||
    (member.teamId !== undefined && member.userId !== undefined && slackPrincipal(member.teamId, member.userId) === principal));
}

export function authorizePrincipalApproval(
  roster: RosterMember[],
  principal: string,
  level: string,
): AuthorizeResult {
  const member = findByCanonicalPrincipal(roster, principal);
  if (!member) return { ok: false, principal, reason: `${principal} is not in the roster (handbook/roster.md).` };
  if (member.type === "agent") {
    return { ok: false, member, principal, reason: `${member.name} is an agent identity — agents never approve.` };
  }
  if (!/^(aktiv|active)$/i.test(member.status)) {
    return { ok: false, member, principal, reason: `${member.name} (${member.role}) is ${member.status} — inactive members cannot approve.` };
  }
  if (!member.mayApprove.includes(level)) {
    return {
      ok: false,
      member,
      principal,
      reason: `The roster member ${member.name} (${member.role}) may approve ${member.mayApprove.join(", ") || "nothing"} — not ${level}.`,
    };
  }
  return { ok: true, member, principal, reason: "authorized" };
}

export interface AuthorizeResult {
  ok: boolean;
  member?: RosterMember;
  principal: string;
  reason: string;
}

/** The Core-owned authorization decision defined by the approval contract. */
export function authorizeApproval(
  roster: RosterMember[],
  teamId: string,
  userId: string,
  level: string,
): AuthorizeResult {
  const principal = slackPrincipal(teamId, userId);
  return authorizePrincipalApproval(roster, principal, level);
}
