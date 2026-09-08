import { defineCompanyTool } from "@companyos/tool-sdk";

type Input = {
  open_work_items: { work_item_id: string; provider_version: string }[];
  target_sprint_id: string;
};

export default defineCompanyTool({
  async execute(input: Input) {
    if (!input.target_sprint_id) throw new Error("A target Sprint is required.");
    const seen = new Set<string>();
    const updates = input.open_work_items.map((item) => {
      if (!item.work_item_id || !item.provider_version) throw new Error("Every open item requires an identity and provider version.");
      if (seen.has(item.work_item_id)) throw new Error("Duplicate work item: " + item.work_item_id);
      seen.add(item.work_item_id);
      return { work_item_id: item.work_item_id, expected_version: item.provider_version, changes: { sprint: input.target_sprint_id } };
    }).sort((a, b) => a.work_item_id.localeCompare(b.work_item_id, "en"));
    return { outcome: updates.length ? "some" : "none", updates };
  },
});
