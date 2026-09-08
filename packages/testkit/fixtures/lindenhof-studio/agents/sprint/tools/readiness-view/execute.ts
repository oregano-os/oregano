import { defineCompanyTool } from "@companyos/tool-sdk";

type Item = { work_item_id: string; provider_version: string; status: string; assignee_ids: string[]; fields: Record<string, unknown> };
type Input = { work_items: { record_id: string; values: Item }[]; required_fields: string[]; ready_status: string; planned_status: string };

export default defineCompanyTool({
  async execute(input: Input) {
    const ids = new Set<string>();
    const items = input.work_items.map((row) => {
      const item = row.values;
      if (!row.record_id || !item?.work_item_id || !item.provider_version || typeof item.status !== "string"
        || !Array.isArray(item.assignee_ids) || !item.fields || typeof item.fields !== "object" || Array.isArray(item.fields)) {
        throw new Error("Work item row is missing required values: " + row.record_id);
      }
      if (ids.has(item.work_item_id)) throw new Error("Duplicate work item: " + item.work_item_id);
      ids.add(item.work_item_id);
      return item;
    }).filter((item) => item.status === input.planned_status || item.status === input.ready_status)
      .sort((a, b) => a.work_item_id.localeCompare(b.work_item_id, "en"));
    const asked = new Set<string>();
    const questions: { participant_id: string; work_item_id: string; missing_fields: string[]; question: string }[] = [];
    const updates: { work_item_id: string; expected_version: string; changes: { status: string } }[] = [];
    let readyCount = 0;
    for (const item of items) {
      const missing = input.required_fields.filter((field) => {
        const value = item.fields[field];
        return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
      });
      if (item.assignee_ids.length !== 1) missing.push("assignee");
      const ready = missing.length === 0;
      if (ready) readyCount++;
      const owner = item.assignee_ids.length === 1 ? item.assignee_ids[0] : undefined;
      if (!ready && owner && !asked.has(owner)) {
        asked.add(owner);
        questions.push({ participant_id: owner, work_item_id: item.work_item_id, missing_fields: [...new Set(missing)].sort(), question: "Please complete item " + item.work_item_id + ": " + [...new Set(missing)].sort().map((field) => field.replace(/_/g, " ")).join(", ") + "." });
      }
      const target = ready ? input.ready_status : input.planned_status;
      if (item.status !== target) updates.push({ work_item_id: item.work_item_id, expected_version: item.provider_version, changes: { status: target } });
    }
    return { outcome: updates.length ? "some" : "none", summary: { candidate_count: items.length, ready_count: readyCount, missing_count: items.length - readyCount }, questions, updates };
  },
});
