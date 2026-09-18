import { timingSafeEqual } from "node:crypto";
import type { WorkflowEventKind } from "../../companyos-builder/workflow-types.ts";
import type { WorkflowTriggerEvent } from "../../state-store/workflow-engine.ts";

/** One normalized Monday board webhook delivery. The payload is identity evidence only; the record is reread separately. */
export interface MondayBoardEvent {
  kind: WorkflowEventKind;
  eventId: string;
  boardId: string;
  workItemId: string;
  groupId: string;
  /** Provider column of a change event; empty for creation and moves. The host maps it to the logical field. */
  columnId: string;
  actorId: string;
  occurredAt: string;
  providerType: string;
  subscriptionId: string;
}
export type MondayBoardWebhook = { challenge: string } | { event: MondayBoardEvent } | { ignored: string };

/** Provider payload type names, including the aliases Monday uses for the same subscription event. */
const EVENT_KINDS: Record<string, WorkflowEventKind> = {
  create_pulse: "item-created",
  create_item: "item-created",
  move_pulse_into_group: "item-moved",
  item_moved_to_any_group: "item-moved",
  item_moved_to_specific_group: "item-moved",
  update_column_value: "item-changed",
  change_column_value: "item-changed",
  change_status_column_value: "item-changed",
  change_specific_column_value: "item-changed",
};

const identifier = (name: string, value: unknown, pattern = /^[A-Za-z0-9_.-]{1,128}$/): string => {
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`Monday board event is missing '${name}'`);
  const text = String(value);
  if (!pattern.test(text)) throw new Error(`Monday board event '${name}' is invalid`);
  return text;
};

/** Parses the raw body without trusting it: a challenge, one supported event, or an explicit ignore reason. */
export function parseMondayBoardWebhook(rawBody: string): MondayBoardWebhook {
  let value: unknown;
  try { value = JSON.parse(rawBody); }
  catch { throw new Error("Monday board webhook body is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Monday board webhook body must be an object");
  const body = value as Record<string, unknown>;
  if (body.challenge !== undefined) return { challenge: identifier("challenge", body.challenge, /^[A-Za-z0-9_-]{1,255}$/) };
  const event = body.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Monday board webhook requires an event object");
  const raw = event as Record<string, unknown>;
  const type = typeof raw.type === "string" ? raw.type : "";
  const kind = EVENT_KINDS[type];
  if (!kind) return { ignored: `unsupported-event:${type.replace(/[^a-z_]/g, "") || "unknown"}` };
  if (raw.parentItemId !== undefined && raw.parentItemId !== null) return { ignored: "subitem-event" };
  const occurredAt = new Date(String(raw.triggerTime ?? ""));
  if (!Number.isFinite(occurredAt.getTime())) throw new Error("Monday board event 'triggerTime' is invalid");
  return { event: {
    kind,
    eventId: identifier("triggerUuid", raw.triggerUuid, /^[A-Za-z0-9-]{8,64}$/),
    boardId: identifier("boardId", raw.boardId, /^\d{1,20}$/),
    workItemId: identifier("pulseId", raw.pulseId ?? raw.itemId, /^\d{1,20}$/),
    groupId: identifier("groupId", raw.destGroupId ?? raw.groupId),
    columnId: kind === "item-changed" ? identifier("columnId", raw.columnId) : "",
    actorId: identifier("userId", raw.userId, /^-?\d{1,20}$/),
    occurredAt: occurredAt.toISOString(),
    providerType: type,
    subscriptionId: raw.subscriptionId === undefined || raw.subscriptionId === null ? "" : identifier("subscriptionId", raw.subscriptionId, /^\d{1,20}$/),
  } };
}

/** Board webhooks carry no provider signature; the registered URL carries one Instance credential instead. */
export function verifyMondayBoardWebhookToken(url: string, secret: string): boolean {
  if (!secret || secret.length < 32 || /[\r\n]/.test(secret)) return false;
  let supplied: string | null;
  try { supplied = new URL(url).searchParams.get("token"); }
  catch { return false; }
  if (!supplied) return false;
  const left = Buffer.from(supplied), right = Buffer.from(secret);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** `field` is the logical resource field the host resolved for a change event; empty otherwise. */
export function workflowEventFromMondayBoardEvent(event: MondayBoardEvent, resourceBinding: string, field = ""): WorkflowTriggerEvent {
  return { kind: event.kind, event_id: event.eventId, resource_binding: resourceBinding, work_item_id: event.workItemId,
    group_id: event.groupId, field, actor_id: event.actorId, occurred_at: event.occurredAt };
}
