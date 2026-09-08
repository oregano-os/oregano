import { defineCompanyTool } from "@companyos/tool-sdk";

type Member = { member_id: string | null; display_name: string; type: string; status: string; group_ids: string[]; principals: string[] };
type Input = {
  directory: { directory_digest: string; members: Member[] };
  roles: { record_id: string; values: { lifecycle_state: string; role: string; person_ids: string[] } }[];
  excluded_ids: string[];
  group_id: string;
  communication_prefix: string;
};

export default defineCompanyTool({
  execute(input: Input) {
    const ids = new Set<string>();
    const principals = new Set<string>();
    for (const member of input.directory.members) {
      if (member.member_id !== null) {
        if (ids.has(member.member_id)) throw new Error("Duplicate directory member identity");
        ids.add(member.member_id);
      }
      for (const principal of member.principals) {
        if (principals.has(principal)) throw new Error("Ambiguous directory principal");
        principals.add(principal);
      }
    }
    const members = input.directory.members.filter((member) => member.type === "human"
      && /^(active|aktiv)$/i.test(member.status) && member.group_ids.includes(input.group_id));
    const eligible = new Map<string, Member>();
    for (const member of members) {
      if (!member.member_id) throw new Error("Every participant requires a stable reviewed member ID");
      eligible.set(member.member_id, member);
    }
    const exclusions = new Set(input.excluded_ids);
    for (const id of exclusions) if (!eligible.has(id)) throw new Error(`Excluded member '${id}' is not an eligible participant`);
    const assigned = new Map<string, Set<string>>();
    const evidence = new Map<string, Set<string>>();
    const rowIds = new Set<string>();
    for (const row of input.roles) {
      if (rowIds.has(row.record_id)) throw new Error("Duplicate role record identity");
      rowIds.add(row.record_id);
      if (row.values.lifecycle_state !== "active") continue;
      if (!row.values.role.trim()) throw new Error("Active role records require a nonempty role");
      for (const id of row.values.person_ids) {
        if (!eligible.has(id)) continue;
        const roles = assigned.get(id) || new Set();
        roles.add(row.values.role);
        assigned.set(id, roles);
        const sources = evidence.get(id) || new Set();
        sources.add(row.record_id);
        evidence.set(id, sources);
      }
    }
    const rows = members.map((member) => {
      const id = member.member_id;
      if (!id) throw new Error("Every participant requires a stable reviewed member ID");
      const contacts = member.principals.filter((principal) => principal.startsWith(input.communication_prefix)
        && principal.length > input.communication_prefix.length);
      if (contacts.length !== 1) throw new Error(`Participant '${id}' requires exactly one configured communication principal`);
      const roles = [...(assigned.get(id) || [])].sort();
      if (!roles.length) throw new Error(`Participant '${id}' has no verified role projection mapping`);
      return { record_id: id, values: {
        participant_id: id, display_name: member.display_name, included: !exclusions.has(id),
        approved_absence: exclusions.has(id), communication_principal: contacts[0], roles,
        role_record_ids: [...(evidence.get(id) ?? [])].sort(),
      } };
    }).sort((a, b) => a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0);
    return { rows, directory_digest: input.directory.directory_digest };
  },
});
