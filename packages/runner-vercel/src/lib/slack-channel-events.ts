/** Optional shared-app guard. An exact channel exclusion covers mentions too. */
export async function ignoreSlackChannelEvent(request: Request, mode?: string, excludedChannelIds?: string): Promise<boolean> {
  if (mode !== undefined && mode !== "process" && mode !== "ignore") throw new Error("SLACK_CHANNEL_MESSAGE_EVENTS must be process or ignore");
  const channels = excludedChannelIds === undefined ? [] : excludedChannelIds.split(",").map((value) => value.trim());
  if (channels.length > 100 || channels.some((id) => !/^[CG][A-Z0-9]{4,31}$/.test(id)) || new Set(channels).size !== channels.length) {
    throw new Error("SLACK_IGNORED_CHANNEL_IDS must contain unique exact channel IDs separated by commas");
  }
  if (mode !== "ignore" && !channels.length) return false;
  if (request.method !== "POST" || !request.headers.get("content-type")?.startsWith("application/json")) return false;
  const body = await request.clone().text();
  if (body.length > 100_000) return false;
  try {
    const payload = JSON.parse(body), event = payload?.event;
    if (payload?.type === "event_callback" && ["message", "app_mention"].includes(event?.type)
      && channels.includes(event?.channel)) return true;
    return mode === "ignore" && payload?.type === "event_callback" && event?.type === "message"
      && (event.channel_type === "channel" || event.channel_type === "group" || /^[CG][A-Z0-9]+$/.test(event.channel ?? ""));
  } catch { return false; }
}
