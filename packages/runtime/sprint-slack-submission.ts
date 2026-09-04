import type { SprintDomainDeclaration, SprintEvent, SprintState } from "../domains/sprint/contracts.ts";

const section = (text: string, start: RegExp, end?: RegExp): string => {
  const match = start.exec(text);
  if (!match) return "";
  const tail = text.slice(match.index + match[0].length);
  if (!end) return tail;
  const next = end.exec(tail);
  return next ? tail.slice(0, next.index) : tail;
};

const occurrences = (text: string, value: string): number => {
  if (!value) return 0;
  let count = 0;
  let cursor = 0;
  while ((cursor = text.indexOf(value, cursor)) !== -1) {
    count += 1;
    cursor += value.length;
  }
  return count;
};

const labelledValue = (text: string, label: RegExp): string => {
  const match = text.split(/\r?\n/).map((line) => line.trim()).find((line) => label.test(line));
  return match ? match.replace(label, "").trim() : "";
};

const taskLines = (text: string, state: SprintState) => text.split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => /^(?:[•*-]|\d+[.)])\s+/.test(line))
  .map((line) => line.replace(/^(?:[•*-]|\d+[.)])\s+/, "").trim())
  .map((line) => {
    const url = line.match(/https?:\/\/\S+/)?.[0]?.replace(/[)>.,;]+$/, "");
    const title = line.replace(/https?:\/\/\S+/, "").replace(/(?:—|-)?\s*:link:\s*$/i, "").replace(/\s+(?:—|-)\s*$/, "").trim();
    const workItem = url ? Object.values(state.work_items).find((candidate) => candidate.url === url) : undefined;
    return { title: title || workItem?.title || "Referenced work item", ...(url ? { url } : {}), ...(workItem ? { work_item_id: workItem.work_item_id } : {}) };
  })
  .slice(0, 1_000);

export function isFridaySprintUpdate(text: string): boolean {
  return /^\s*MY FRIDAY SPRINT UPDATE\b/im.test(text);
}

/**
 * Normalize a Slack Friday update only after Slack authentication and
 * deterministic Agent routing. Message content identifies the Sprint action;
 * it never grants access or chooses the Agent.
 */
export function normalizeSlackFridaySubmission(args: {
  messageId: string;
  occurredAt: string;
  participantPrincipal: string;
  threadReference: string;
  text: string;
  state: SprintState;
  policy: SprintDomainDeclaration;
}): Extract<SprintEvent, { type: "submission.received" }> {
  if (!isFridaySprintUpdate(args.text)) throw new Error("Slack message is not a Friday Sprint update");
  if (!args.state.close_thread_reference || args.threadReference !== args.state.close_thread_reference) {
    throw new Error("Slack Friday submission is not in the active shared Close thread");
  }
  const participant = Object.values(args.state.participants).find(
    (candidate) => candidate.communication_principal === args.participantPrincipal,
  );
  if (!participant || participant.approved_absence) throw new Error("Slack Friday submission sender is not an included Sprint participant");
  const thisWeek = section(args.text, /^\s*THIS WEEK\s*$/im, /^\s*(?:\:thought_balloon\:|BIGGEST BLOCKER|NEXT WEEK)\b/im);
  const nextWeek = section(args.text, /^\s*NEXT WEEK\s*$/im);
  const committed = Object.values(args.state.work_items)
    .filter((item) => item.group === args.policy.work_items.master_group && item.assignee_ids.includes(participant.participant_id))
    .sort((left, right) => left.work_item_id.localeCompare(right.work_item_id));
  const taskIds = committed
    .filter((item) => item.url && occurrences(thisWeek, item.url) === 1)
    .map((item) => item.work_item_id);
  const structurallyComplete = Boolean(
    thisWeek
    && nextWeek
    && /(?:\:thought_balloon\:|Biggest blocker\s*\/\s*learning)/i.test(args.text)
    && /(?:\:dart\:|Sprint goal)/i.test(nextWeek)
    && /(?:\:bar_chart\:|Measurable outcome)/i.test(nextWeek)
    && committed.every((item) => Boolean(item.url) && occurrences(thisWeek, item.url!) === 1),
  );
  const goal = labelledValue(nextWeek, /^(?:\:dart\:\s*)?Sprint goal\s*(?:\([^)]*\))?\s*:\s*/i);
  const measurableOutcome = labelledValue(nextWeek, /^(?:\:bar_chart\:\s*)?Measurable outcome\s*(?:\([^)]*\))?\s*:\s*/i);
  const tasks = taskLines(section(nextWeek, /^\s*Tasks\s*(?:\([^)]*\))?\s*:\s*$/im), args.state);
  const nextWeekPlan = goal && measurableOutcome && tasks.length > 0
    ? { goal, measurable_outcome: measurableOutcome, tasks }
    : undefined;
  return {
    type: "submission.received",
    event_id: `slack:${args.messageId}`,
    occurred_at: args.occurredAt,
    participant_id: participant.participant_id,
    submission_id: args.messageId,
    task_ids: taskIds,
    complete: structurallyComplete,
    ...(nextWeekPlan ? { next_week: nextWeekPlan } : {}),
  };
}
