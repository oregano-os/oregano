import { createHash } from "node:crypto";
import { ownsWorkflowDm, workflowDmRecipients } from "./slack-workflow-dm-routing.ts";

export type WorkflowSlackIngressReason = "workflow-action" | "workflow-message" | "not-post" | "unsupported-content-type"
  | "payload-too-large" | "invalid-payload" | "other-action" | "conversations-disabled" | "other-event"
  | "unowned-conversation" | "bot-or-subtype" | "not-channel-message" | "invalid-message" | "mention";
export interface WorkflowSlackIngressInspection {
  kind: "action" | "message" | "ignored";
  reason: WorkflowSlackIngressReason;
  messageRef?: string;
}

/** Correlation only; a hash is neither an authenticated identity nor a delivery receipt. */
export function slackMessageReference(channel: unknown, timestamp: unknown): string | undefined {
  if (typeof channel !== "string" || !/^[CDG][A-Z0-9]{4,31}$/.test(channel)
    || typeof timestamp !== "string" || !/^\d{1,20}\.\d{1,20}$/.test(timestamp)) return undefined;
  return createHash("sha256").update(`${channel}:${timestamp}`).digest("hex");
}

/** Selection is not authentication. Preserve original request bytes for the SDK verifier. */
export async function inspectWorkflowSlackRequest(request: Request, workflowOnly: boolean, dmRecipients = workflowDmRecipients()): Promise<WorkflowSlackIngressInspection> {
  const ignored = (reason: WorkflowSlackIngressReason, messageRef?: string): WorkflowSlackIngressInspection => ({ kind: "ignored", reason, ...(messageRef ? { messageRef } : {}) });
  if (request.method !== "POST") return ignored("not-post");
  const contentType = request.headers.get("content-type") ?? "";
  const form = contentType.startsWith("application/x-www-form-urlencoded"), json = contentType.startsWith("application/json");
  if (!form && !json) return ignored("unsupported-content-type");
  if (json && !workflowOnly) return ignored("conversations-disabled");
  const body = await request.clone().text();
  if (body.length > 100_000) return ignored("payload-too-large");
  try {
    const payload = JSON.parse(form ? new URLSearchParams(body).get("payload") ?? "null" : body);
    if (form) {
      if (payload?.type !== "block_actions" || !Array.isArray(payload.actions) || payload.actions.length !== 1
        || !["companyos.workflow.approve", "companyos.workflow.reject"].includes(payload.actions[0]?.action_id)) return ignored("other-action");
      return { kind: "action", reason: "workflow-action" };
    }
    const event = payload?.event;
    const messageRef = slackMessageReference(event?.channel, event?.ts);
    if (payload?.type !== "event_callback" || !["message", "app_mention"].includes(event?.type)) return ignored("other-event", messageRef);
    if (event.subtype || event.bot_id || event.app_id) return ignored("bot-or-subtype", messageRef);
    if (typeof event.channel !== "string" || (!/^[CG][A-Z0-9]{4,31}$/.test(event.channel) && !ownsWorkflowDm(payload, dmRecipients))) return ignored("not-channel-message", messageRef);
    if (typeof event.ts !== "string" || !/^\d+\.\d+$/.test(event.ts)
      || (event.thread_ts !== undefined && (typeof event.thread_ts !== "string" || !/^\d+\.\d+$/.test(event.thread_ts)))
      || typeof event.user !== "string" || !/^[UW][A-Z0-9]{4,31}$/.test(event.user)
      || typeof event.text !== "string") return ignored("invalid-message", messageRef);
    return { kind: "message", reason: "workflow-message", ...(messageRef ? { messageRef } : {}) };
  } catch { return ignored("invalid-payload"); }
}

export async function isWorkflowActionRequest(request: Request): Promise<boolean> {
  return (await inspectWorkflowSlackRequest(request, false)).kind === "action";
}
export async function isWorkflowThreadRequest(request: Request): Promise<boolean> {
  return (await inspectWorkflowSlackRequest(request, true)).kind === "message";
}
