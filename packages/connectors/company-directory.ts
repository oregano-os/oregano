import type { CapabilityCallContext, CapabilityResult, Connector } from "../capabilities/contracts.ts";
import { RecordIdentityDirectory } from "../records/identity-directory.ts";
import type { RosterMember } from "../state-store/roster.ts";

/** Reviewed roster facts, never operational role inference or approval authority. */
export class CompanyDirectoryConnector implements Connector {
  readonly id = "oregano/company-directory";
  readonly version = "1.0.0";
  readonly capabilities = ["directory.members.query"] as const;
  readonly #instanceId: string;
  readonly #readGroups: Set<string>;
  readonly #directory: RecordIdentityDirectory;

  constructor(args: { instanceId: string; roster: readonly RosterMember[]; readGroups: readonly string[] }) {
    if (!args.instanceId || args.readGroups.length === 0 || args.readGroups.length > 100
      || args.readGroups.some((group) => typeof group !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(group))) {
      throw new Error("Company directory requires an exact Instance and between one and 100 explicit read groups");
    }
    this.#instanceId = args.instanceId;
    this.#readGroups = new Set(args.readGroups);
    this.#directory = new RecordIdentityDirectory(args.roster);
  }

  async invoke(capability: string, input: unknown, context: CapabilityCallContext): Promise<CapabilityResult> {
    if (capability !== "directory.members.query") throw new Error(`Company directory does not implement '${capability}'`);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 0) throw new Error("Directory queries accept no authority or roster input");
    if (context.instanceId !== this.#instanceId || context.subject?.status !== "active"
      || !context.subject.principalId || !context.subject.groupIds.some((group) => this.#readGroups.has(group))) {
      throw new Error("Company directory access denied: an active authenticated subject in an allowed read group is required");
    }
    const members = this.#directory.members().map((member) => ({
      member_id: member.id ?? null, display_name: member.name, type: member.type ?? "human", status: member.status,
      group_ids: member.groups ?? [], principals: member.principals ?? [],
    }));
    return {
      output: { directory_digest: this.#directory.digest, members },
      evidence: { directory_digest: this.#directory.digest, member_count: members.length, access_decision: "allowed" },
    };
  }
}
