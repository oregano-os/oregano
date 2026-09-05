import { defineCompanyTool } from "@companyos/tool-sdk";

type Row<T> = { record_id: string; values: T };
type ParticipantValues = { participant_id: string; display_name: string; included: boolean };
type WorkItemValues = { work_item_id: string; assignee_ids: string[]; status: string; provider_version: string };
type SubmissionValues = { participant_id: string; content_participant_id: string; accepted_at: string; task_ids: string[]; well_formed: boolean };
type Input = {
  participants: Row<ParticipantValues>[];
  work_items: Row<WorkItemValues>[];
  submissions: Row<SubmissionValues>[];
  closed_statuses: string[];
  cutoff: string;
  thread_reference: string;
};

const requireFields = (kind: string, row: Row<Record<string, unknown>>, fields: string[]): void => {
  const missing = fields.filter((field) => row.values?.[field] === undefined || row.values?.[field] === null);
  if (missing.length > 0) throw new Error(kind + " row '" + row.record_id + "' is missing required values: " + missing.join(", "));
};

const sameSet = (left: string[], right: string[]): boolean => {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
};

// Keep provider sub-millisecond precision while normalizing timezone offsets.
const instant = (value: string): bigint => {
  const parts = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  const milliseconds = Date.parse(value);
  if (!parts || !Number.isFinite(milliseconds)) throw new Error("A timestamp must be a valid ISO instant");
  return BigInt(milliseconds) * 1_000_000n + BigInt((parts[2] ?? "").padEnd(9, "0").slice(3));
};

export default defineCompanyTool({
  async execute(input: Input) {
    if (!input.thread_reference) throw new Error("thread_reference is required and must come from the workflow, not from submissions");
    for (const row of input.participants) requireFields("participant", row, ["participant_id", "display_name", "included"]);
    for (const row of input.work_items) requireFields("work item", row, ["work_item_id", "assignee_ids", "status", "provider_version"]);
    for (const row of input.submissions) requireFields("submission", row, ["participant_id", "content_participant_id", "accepted_at", "task_ids", "well_formed"]);

    const cutoff = instant(input.cutoff);
    const label = (value: string) => value.replace(/[\r\n]+/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/@/g, "＠");
    const participantIds = input.participants.map((row) => row.values.participant_id);
    const itemIds = input.work_items.map((row) => row.values.work_item_id);
    if (new Set(participantIds).size !== participantIds.length) throw new Error("Duplicate participant identity");
    if (new Set(itemIds).size !== itemIds.length) throw new Error("Duplicate work item identity");
    const names = new Map(input.participants.map((row) => [row.values.participant_id, label(row.values.display_name)]));
    const closed = new Set(input.closed_statuses);
    const items = input.work_items.map((row) => row.values);
    const submissions = input.submissions.map((row) => {
      const accepted = instant(row.values.accepted_at);
      return { ...row.values, accepted, record_id: row.record_id };
    });
    const states: Record<string, "complete" | "needs-reformat" | "missing"> = {};
    for (const participant of input.participants.map((row) => row.values).filter((p) => p.included)) {
      const id = participant.participant_id;
      const committed = items.filter((item) => item.assignee_ids.includes(id)).map((item) => item.work_item_id);
      const latest = submissions
        .filter((s) => s.participant_id === id && s.accepted <= cutoff)
        .sort((a, b) => a.accepted < b.accepted ? -1 : a.accepted > b.accepted ? 1 : a.record_id.localeCompare(b.record_id))
        .at(-1);
      if (!latest) states[id] = "missing";
      else if (!latest.well_formed || latest.content_participant_id !== id || !sameSet(latest.task_ids, committed)) states[id] = "needs-reformat";
      else states[id] = "complete";
    }
    const incomplete = Object.entries(states).filter(([, state]) => state !== "complete").map(([id]) => id).sort();
    const open_work_items = items
      .filter((item) => !closed.has(item.status))
      .map(({ work_item_id, provider_version }) => ({ work_item_id, provider_version }))
      .sort((a, b) => a.work_item_id.localeCompare(b.work_item_id));
    return {
      outcome: incomplete.length > 0 ? "incomplete" : "complete",
      cutoff: input.cutoff,
      thread_reference: input.thread_reference,
      states,
      incomplete,
      open_work_items,
      report_text: Object.entries(states).sort(([a], [b]) => a.localeCompare(b)).map(([id, state]) =>
        "- " + names.get(id) + ": " + (state === "complete" ? "complete" : state === "needs-reformat" ? "please correct the format or task list" : "not posted")).join("\n") || "No included participants for this close.",
      chase_text: incomplete.map((id) => names.get(id)).join(", ") || "Everyone has posted a complete update.",
      open_items_text: open_work_items.map((item) => "- " + label(item.work_item_id)).join("\n") || "No open work items.",
    };
  },
});
