import { sha256 } from "../canonical.ts";
import type { RosterMember } from "../../state-store/roster.ts";
import type { ReleaseAuthorization, ReleaseSelector, WorkspaceReleasePolicy } from "./contracts.ts";

function record(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(result, key))) throw new Error(`${label} requires exactly ${keys.join(", ")}.`);
  return result;
}
function ids(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some((id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))) throw new Error(`${label} must be a bounded list of stable ids.`);
  return [...new Set(value)].sort();
}

/** Consumes accepted Workspace governance, never candidate content or model input. */
export function compileWorkspaceReleasePolicy(governance: unknown, roster: readonly RosterMember[]): WorkspaceReleasePolicy | undefined {
  const document = governance as { builder?: { release?: unknown }; review_mode?: string; roles?: { workspace_stewards?: string[] } } | undefined;
  if (document?.builder?.release === undefined) return undefined;
  const input = record(document.builder.release, ["version", "acceptance", "deployers"], "builder.release");
  if (input.version !== 1) throw new Error("builder.release.version must be 1.");
  if (!["steward", "independent-review"].includes(document.review_mode ?? "")) throw new Error("Release policy requires the current Workspace review mode.");
  const selector = (value: unknown, label: string): ReleaseSelector => {
    const raw = record(value, ["members", "groups"], label);
    const members = ids(raw.members, `${label}.members`); const groups = ids(raw.groups, `${label}.groups`);
    if (members.some((id) => !roster.some((member) => member.id === id)) || groups.some((id) => !roster.some((member) => member.groups?.includes(id)))) throw new Error(`${label} contains an unknown roster member or group.`);
    return { members, groups };
  };
  const accepted = record(input.acceptance, ["content", "behavior", "security"], "builder.release.acceptance");
  const rule = (changeClass: "content" | "behavior" | "security") => {
    const value = record(accepted[changeClass], ["mode", "eligible", "independent"], `acceptance.${changeClass}`);
    if (!["requester", "steward"].includes(String(value.mode)) || typeof value.independent !== "boolean") throw new Error(`Invalid acceptance rule for ${changeClass}.`);
    if (value.mode === "requester" && value.independent) throw new Error("Requester acceptance cannot also require a different acceptor.");
    const eligible = selector(value.eligible, `acceptance.${changeClass}.eligible`);
    if (changeClass === "security") {
      if (value.mode !== "steward" || (document.review_mode === "independent-review" && !value.independent)) throw new Error("Security acceptance must preserve Workspace Steward and independent-review requirements.");
      const stewards = document.roles?.workspace_stewards ?? [];
      const selected = roster.filter((member) => (!!member.id && eligible.members.includes(member.id)) || member.groups?.some((group) => eligible.groups.includes(group)));
      if (selected.some((member) => !stewards.includes(member.role) && (!member.id || !stewards.includes(member.id)))) throw new Error("Security acceptors must be assigned Workspace Stewards.");
    }
    return { mode: value.mode as "requester" | "steward", eligible, independent: value.independent };
  };
  return { version: 1, acceptance: { content: rule("content"), behavior: rule("behavior"), security: rule("security") }, deployers: selector(input.deployers, "builder.release.deployers") };
}

export function releaseAuthorization(policy: WorkspaceReleasePolicy, roster: readonly RosterMember[]): ReleaseAuthorization {
  // Include authority-relevant membership, including inactive identities and all
  // surface principals. A name-only change does not invalidate acceptance.
  const membership = roster.map(({ id, role, status, type, groups, principals, teamId, userId }) => ({ id, role, status, type, groups: [...(groups ?? [])].sort(), principals: [...(principals ?? [])].sort(), teamId, userId }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { policy, roster, policyDigest: sha256({ policy, membership }) };
}
