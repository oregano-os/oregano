import { defineCompanyTool } from "@companyos/tool-sdk";

type Item = { work_item_id: string; provider_version: string; status: string; assignee_ids: string[] };
type Input = { work_items: { record_id: string; values: Item }[]; planned_status: string };

export default defineCompanyTool({
  async execute(input: Input) {
    const seen = new Set<string>();
    const groups = new Map<string, string[]>();
    const items = input.work_items.map((row) => {
      const item = row.values;
      if (!row.record_id || !item?.work_item_id || !item.provider_version || typeof item.status !== "string" || !Array.isArray(item.assignee_ids)) {
        throw new Error("Work item row is missing required values: " + row.record_id);
      }
      if (seen.has(item.work_item_id)) throw new Error("Duplicate work item: " + item.work_item_id);
      seen.add(item.work_item_id);
      return item;
    }).sort((a, b) => a.work_item_id.localeCompare(b.work_item_id, "en"));
    for (const item of items) {
      if (item.assignee_ids.length !== 1) continue;
      const owner = item.assignee_ids[0];
      const group = groups.get(owner) ?? [];
      group.push(item.work_item_id);
      groups.set(owner, group);
    }
    const updates = items.filter((item) => item.status !== input.planned_status)
      .map((item) => ({ work_item_id: item.work_item_id, expected_version: item.provider_version, changes: { status: input.planned_status } }));
    const nudges = [...groups].sort(([a], [b]) => a.localeCompare(b, "en")).map(([participant_id, work_item_ids]) => ({ participant_id, work_item_ids, items_text: work_item_ids.join(", ") }));
    return { outcome: updates.length ? "some" : "none", candidate_ids: items.map((item) => item.work_item_id), nudges, updates };
  },
});
