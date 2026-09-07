/** Optional staging guard for a shared app. Mentions, DMs and controls retain their existing path. */
export async function ignoreSlackChannelEvent(request: Request, mode?: string): Promise<boolean> {
  if (mode === undefined || mode === "process") return false;
  if (mode !== "ignore") throw new Error("SLACK_CHANNEL_MESSAGE_EVENTS must be process or ignore");
  if (request.method !== "POST" || !request.headers.get("content-type")?.startsWith("application/json")) return false;
  const body = await request.clone().text();
  if (body.length > 100_000) return false;
  try {
    const payload = JSON.parse(body), event = payload?.event;
    return payload?.type === "event_callback" && event?.type === "message"
      && (event.channel_type === "channel" || event.channel_type === "group" || /^[CG][A-Z0-9]+$/.test(event.channel ?? ""));
  } catch { return false; }
}
