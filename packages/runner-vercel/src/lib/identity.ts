import type { RosterMember } from "../../../state-store/roster.ts";

export function findActiveHumanRosterMember(
  roster: readonly RosterMember[],
  author: { userId: string; isBot: boolean | "unknown"; isMe: boolean; isSystem?: boolean },
): RosterMember | undefined {
  if (author.isBot === true || author.isMe || author.isSystem) return undefined;
  return roster.find((member) =>
    member.userId === author.userId &&
    member.type !== "agent" &&
    /^(active|aktiv)$/i.test(member.status));
}
