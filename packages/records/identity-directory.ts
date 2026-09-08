import type { RosterMember } from "../state-store/roster.ts";
import { sha256 } from "../runtime/canonical.ts";

const principalPattern = /^[a-z][a-z0-9-]*:[^:\s]+:[^\s]+$/;
const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Read-only identity evidence, never an authorization or approval decision. */
export class RecordIdentityDirectory {
  readonly digest: string;
  readonly #principals = new Map<string, string>();
  readonly #members: RosterMember[];

  constructor(roster: readonly RosterMember[]) {
    if (roster.length > 1_000) throw new Error("Record identity directory exceeds the 1000-member bound");
    const ids = new Set<string>();
    const owners = new Map<string, string>();
    this.#members = roster.map((member, index) => {
      const owner = member.id ?? `unidentified-row-${index}`;
      if (member.id !== undefined && (!stableIdPattern.test(member.id) || ids.has(member.id))) throw new Error("Record identity directory requires distinct stable roster IDs");
      if (member.id) ids.add(member.id);
      const principals = [...new Set(member.principals ?? [])].sort();
      for (const principal of principals) {
        if (!principalPattern.test(principal) || principal.length > 512) throw new Error("Record identity directory requires fully qualified principals");
        if (owners.has(principal)) throw new Error("Record identity directory contains an ambiguous principal");
        owners.set(principal, owner);
        if (member.id && (member.type ?? "human") === "human") this.#principals.set(principal, member.id);
      }
      return { ...structuredClone(member), principals, groups: [...new Set(member.groups ?? [])].sort(), mayApprove: [...new Set(member.mayApprove)].sort() };
    }).sort((a, b) => {
      const left = a.id ?? sha256(a); const right = b.id ?? sha256(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    this.digest = sha256(this.#members);
  }

  members(): RosterMember[] { return structuredClone(this.#members); }

  resolve(principal: string): string {
    if (!principalPattern.test(principal) || principal.length > 512) throw new Error("Record identity resolution requires a fully qualified provider principal");
    // Stable roster IDs cannot contain ':', so unresolved values cannot collide.
    return this.#principals.get(principal) ?? `unresolved:${principal}`;
  }
}
