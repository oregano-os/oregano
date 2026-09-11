import { ownsWorkflowDm, workflowDmRecipients } from "./slack-workflow-dm-routing.ts";

export interface SlackChannelOwnership {
  surface: string;
  accountId: string;
  channelId: string;
}

/** Shared-app selection only. Accepted requests still require the SDK verifier. */
export async function ignoreUnownedSlackConversation(request: Request,
  bindings: readonly SlackChannelOwnership[], dmRecipients = workflowDmRecipients()): Promise<boolean> {
  if (request.method !== "POST" || !request.headers.get("content-type")?.startsWith("application/json")) return false;
  const body = await request.clone().text();
  if (body.length > 100_000) return true;
  try {
    const payload = JSON.parse(body), event = payload?.event;
    if (payload?.type !== "event_callback" || !["message", "app_mention"].includes(event?.type)) return false;
    if (ownsWorkflowDm(payload, dmRecipients)) return false;
    return !bindings.some((binding) => binding.surface === "slack"
      && /^[CG][A-Z0-9]{4,31}$/.test(binding.channelId)
      && binding.accountId === payload.team_id && binding.channelId === event.channel);
  } catch { return true; }
}
