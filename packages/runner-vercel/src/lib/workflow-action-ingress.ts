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
