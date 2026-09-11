import { ownsWorkflowDm, workflowDmRecipients } from "./slack-workflow-dm-routing.ts";

/** Optional shared-app guards. Excluded conversations are handled by the workflow endpoint. */
export async function ignoreSlackChannelEvent(request: Request, mode?: string, excludedChannelIds?: string, dmRecipients = workflowDmRecipients(), ownedChannelIds?: string): Promise<boolean> {
  if (mode !== undefined && mode !== "process" && mode !== "ignore") throw new Error("SLACK_CHANNEL_MESSAGE_EVENTS must be process or ignore");
  const channels = excludedChannelIds === undefined ? [] : excludedChannelIds.split(",").map((value) => value.trim());
  if (channels.length > 100 || channels.some((id) => !/^[CG][A-Z0-9]{4,31}$/.test(id)) || new Set(channels).size !== channels.length) {
    throw new Error("SLACK_IGNORED_CHANNEL_IDS must contain unique exact channel IDs separated by commas");
  }
  const owned = ownedChannelIds === undefined ? undefined : ownedChannelIds.split(",").map(value => value.trim());
  if (owned && (owned.length > 100 || owned.some(id => !/^[CG][A-Z0-9]{4,31}$/.test(id)) || new Set(owned).size !== owned.length)) {
    throw new Error("SLACK_OWNED_CHANNEL_IDS must contain unique exact channel IDs separated by commas");
  }
  if (mode !== "ignore" && !channels.length && !dmRecipients.length && !owned) return false;
  if (request.method !== "POST") return false;
  const contentType = request.headers.get("content-type") ?? "";
  const json = contentType.startsWith("application/json"), form = contentType.startsWith("application/x-www-form-urlencoded");
  if (!json && !(owned && form)) return Boolean(owned);
  const body = await request.clone().text();
  if (body.length > 100_000) return Boolean(owned);
  try {
    const payload = JSON.parse(form ? new URLSearchParams(body).get("payload") ?? "null" : body), event = payload?.event;
    if (owned && payload?.type !== "url_verification") {
      const channel = event?.channel ?? payload?.channel?.id ?? payload?.container?.channel_id;
      if (typeof channel !== "string" || !owned.includes(channel)) return true;
    }
    if (ownsWorkflowDm(payload, dmRecipients)) return true;
    if (payload?.type === "event_callback" && ["message", "app_mention"].includes(event?.type)
      && channels.includes(event?.channel)) return true;
    // Legacy blanket ignore is superseded by exact ownership and SDK conversation
    // subscription/trigger routing. It must never discard an owned follow-up.
    return false;
  } catch { return Boolean(owned); }
}
