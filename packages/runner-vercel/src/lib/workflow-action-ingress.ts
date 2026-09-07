/** Narrow fan-out destination: ordinary chat and other controls never reach a bot. */
export async function isWorkflowActionRequest(request: Request): Promise<boolean> {
  if (request.method !== "POST" || !request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return false;
  const body = await request.clone().text();
  if (body.length > 100_000) return false;
  try {
    const payload = JSON.parse(new URLSearchParams(body).get("payload") ?? "null");
    return payload?.type === "block_actions" && Array.isArray(payload.actions) && payload.actions.length === 1
      && ["companyos.workflow.approve", "companyos.workflow.reject"].includes(payload.actions[0]?.action_id);
  } catch { return false; }
}

/** Opt-in thread events keep direct messages, mentions and ordinary channel chat out of a test lane. */
export async function isWorkflowThreadRequest(request: Request): Promise<boolean> {
  if (request.method !== "POST" || !request.headers.get("content-type")?.startsWith("application/json")) return false;
  const body = await request.clone().text();
  if (body.length > 100_000) return false;
  try {
    const payload = JSON.parse(body), event = payload?.event;
    return payload.type === "event_callback" && event?.type === "message" && !event.subtype && !event.bot_id && !event.app_id
      && typeof event.channel === "string" && /^[CG][A-Z0-9]{4,31}$/.test(event.channel)
      && typeof event.thread_ts === "string" && /^\d+\.\d+$/.test(event.thread_ts) && event.ts !== event.thread_ts
      && typeof event.user === "string" && /^[UW][A-Z0-9]{4,31}$/.test(event.user)
      && typeof event.text === "string" && !event.text.includes("<@");
  } catch { return false; }
}
