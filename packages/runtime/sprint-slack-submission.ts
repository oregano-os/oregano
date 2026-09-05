import type { JsonValue } from "../capabilities/contracts.ts";
import type { SprintDomainDeclaration, SprintEvent, SprintState } from "../domains/sprint/contracts.ts";
import type { RecordProjectionRow } from "../records/contracts.ts";
import { createDerivedRecord, type DerivedRecordEnvelope } from "../records/derived-record.ts";

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

const firstUrl = (value: string): { url?: string; source?: string } => {
  const slack = /<(https?:\/\/[^>|]+)(?:\|[^>]*)?>/.exec(value);
  if (slack?.[1]) return { url: slack[1], source: slack[0] };
  const plain = /https?:\/\/[^\s>]+/.exec(value)?.[0];
  return plain ? { url: plain.replace(/[)>.,;]+$/, ""), source: plain } : {};
};

const taskLines = (text: string, state: SprintState) => text.split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => /^(?:[•*-]|\d+[.)])\s+/.test(line))
  .map((line) => line.replace(/^(?:[•*-]|\d+[.)])\s+/, "").trim())
  .map((line) => {
    const link = firstUrl(line);
    const url = link.url;
    const title = (link.source ? line.replace(link.source, "") : line).replace(/(?:—|-)?\s*:link:\s*$/i, "").replace(/\s+(?:—|-)\s*$/, "").trim();
    const workItem = url ? Object.values(state.work_items).find((candidate) => candidate.url === url) : undefined;
    return { title: title || workItem?.title || "Referenced work item", ...(url ? { url } : {}), ...(workItem ? { work_item_id: workItem.work_item_id } : {}) };
  })
  .slice(0, 1_000);

export function isFridaySprintUpdate(text: string): boolean {
  return /^\s*MY FRIDAY SPRINT UPDATE\b/im.test(text);
}

const submissionEvent = (args: {
  messageId: string;
  occurredAt: string;
  participantPrincipal: string;
  text: string;
  state: SprintState;
  policy: SprintDomainDeclaration;
}): Extract<SprintEvent, { type: "submission.received" }> => {
  if (!isFridaySprintUpdate(args.text)) throw new Error("Slack message is not a Friday Sprint update");
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
};

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
  if (!args.state.close_thread_reference || args.threadReference !== args.state.close_thread_reference) {
    throw new Error("Slack Friday submission is not in the active shared Close thread");
  }
  return submissionEvent(args);
}

const projectionText = (row: RecordProjectionRow, name: string, required = true): string => {
  const value = row.values[name];
  if (typeof value !== "string" || (required && value.length === 0)) throw new Error(`Communication projection row is missing '${name}'`);
  return value;
};

export interface DerivedSprintSubmission {
  record: DerivedRecordEnvelope<Record<string, JsonValue>>;
  event: Extract<SprintEvent, { type: "submission.received" }>;
}

/**
 * Historical interpretation is intentionally separate from live Slack ingress:
 * a mirrored message may be analysed outside the live Close thread, but it
 * still needs an exact roster principal and receives no routing or effect
 * authority from its content.
 */
export function deriveHistoricalSprintSubmission(args: {
  row: RecordProjectionRow;
  expectedProjectionId: string;
  participantPrincipal: string;
  state: SprintState;
  policy: SprintDomainDeclaration;
}): DerivedSprintSubmission {
  if (args.row.projection_id !== args.expectedProjectionId) throw new Error("Historical Sprint submission came from an unexpected projection");
  if (args.row.record_type !== "communication-message") throw new Error("Historical Sprint submission requires one communication-message record");
  const messageId = projectionText(args.row, "message_id");
  const occurredAt = projectionText(args.row, "occurred_at");
  const text = projectionText(args.row, "text", false);
  const threadId = projectionText(args.row, "thread_id");
  const event = submissionEvent({
    messageId,
    occurredAt,
    participantPrincipal: args.participantPrincipal,
    text,
    state: args.state,
    policy: args.policy,
  });
  const referencedIds = new Set([
    ...event.task_ids,
    ...(event.next_week?.tasks.flatMap((task) => task.work_item_id ? [task.work_item_id] : []) ?? []),
  ]);
  const references = [...referencedIds].sort().map((recordId) => ({
    relation: "mentions-work-item",
    record_type: "work-item",
    record_id: recordId,
    ...(args.state.work_items[recordId]?.provider_version ? { source_version_id: args.state.work_items[recordId]!.provider_version } : {}),
  }));
  const payload: Record<string, JsonValue> = {
    participant_id: event.participant_id,
    submission_id: event.submission_id,
    task_ids: event.task_ids,
    complete: event.complete,
    message_thread_id: threadId,
    ...(event.next_week ? { next_week: event.next_week as unknown as JsonValue } : {}),
  };
  return {
    event: {
      ...event,
      source_record: {
        projection_id: args.row.projection_id,
        record_id: args.row.record_id,
        source_version_id: args.row.source_version_id,
      },
    },
    record: createDerivedRecord({
      domain: "sprint",
      type: "submission",
      record_id: `sprint-submission:${messageId}`,
      occurred_at: occurredAt,
      subject_id: event.participant_id,
      source: {
        projection_id: args.row.projection_id,
        record_id: args.row.record_id,
        source_version_id: args.row.source_version_id,
      },
      references,
      payload,
    }),
  };
}
