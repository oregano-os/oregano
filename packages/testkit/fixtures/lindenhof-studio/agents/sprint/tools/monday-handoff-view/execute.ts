import { defineCompanyTool } from "@companyos/tool-sdk";

type Row<T> = { record_id: string; values: T };
type Participant = { participant_id: string; display_name: string; included: boolean };
type Item = { work_item_id: string; title: string; assignee_ids: string[]; url: string };
type Input = { participants: Row<Participant>[]; work_items: Row<Item>[]; empty_message?: string };
type GroupedItem = { work_item_id: string; title: string; url: string; shared: boolean };

const label = (value: string) => value.replace(/[\r\n]+/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\\`*_\[\]()]/g, "\\$&");
const byName = (a: Participant, b: Participant) => a.display_name.localeCompare(b.display_name, "en") || a.participant_id.localeCompare(b.participant_id, "en");

export default defineCompanyTool({
  async execute(input: Input) {
    const participantIds = new Set<string>();
    const participants = input.participants.map((row) => {
      const participant = row.values;
      if (!row.record_id || !participant?.participant_id || !participant.display_name || typeof participant.included !== "boolean") {
        throw new Error("Participant row is missing required values: " + row.record_id);
      }
      if (participantIds.has(participant.participant_id)) throw new Error("Duplicate participant: " + participant.participant_id);
      participantIds.add(participant.participant_id);
      return participant;
    }).filter((participant) => participant.included).sort(byName);
    const includedIds = new Set(participants.map((participant) => participant.participant_id));
    const itemIds = new Set<string>();
    const items = input.work_items.map((row) => {
      const item = row.values;
      if (!row.record_id || !item?.work_item_id || !item.title || !Array.isArray(item.assignee_ids)
        || typeof item.url !== "string" || !/^https:\/\/[^\s<>()]+$/.test(item.url)) {
        throw new Error("Work item row has missing or invalid values: " + row.record_id);
      }
      if (itemIds.has(item.work_item_id)) throw new Error("Duplicate work item: " + item.work_item_id);
      itemIds.add(item.work_item_id);
      return item;
    }).sort((a, b) => a.title.localeCompare(b.title, "en") || a.work_item_id.localeCompare(b.work_item_id, "en"));
    const grouped = (item: Item): GroupedItem => ({ work_item_id: item.work_item_id, title: item.title, url: item.url,
      shared: new Set(item.assignee_ids.filter((id) => includedIds.has(id))).size > 1 });
    const groups = participants.map((participant) => ({ participant_id: participant.participant_id, display_name: participant.display_name,
      work_items: items.filter((item) => item.assignee_ids.includes(participant.participant_id)).map(grouped) }));
    const unassigned = items.filter((item) => !item.assignee_ids.some((id) => includedIds.has(id))).map(grouped);
    const renderItems = (group: GroupedItem[]) => group.length
      ? group.map((item) => "- [" + label(item.title) + "](" + item.url + ")" + (item.shared ? " — shared" : "")).join("\n")
      : label(input.empty_message ?? "No current Sprint items");
    const sections = groups.map((group) => "### " + label(group.display_name) + "\n\n" + renderItems(group.work_items));
    if (unassigned.length) sections.push("### Unassigned\n\n" + renderItems(unassigned));
    return { groups, unassigned_work_items: unassigned, work_items_by_contributor: sections.join("\n\n") || label(input.empty_message ?? "No current Sprint items"),
      participant_count: groups.length, unique_work_item_count: items.length, unassigned_count: unassigned.length };
  },
});
