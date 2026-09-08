/** Routing ownership only. Neither this declaration nor event selection authenticates a person. */
export function workflowDmRecipients(value = process.env.SLACK_WORKFLOW_DM_RECIPIENTS): readonly string[] {
  if (value === undefined) return [];
  const recipients = value.split(",").map((entry) => entry.trim());
  if (recipients.length > 100 || recipients.some((entry) => !/^T[A-Z0-9]{4,31}:[UW][A-Z0-9]{4,31}$/.test(entry))
    || new Set(recipients).size !== recipients.length) {
    throw new Error("SLACK_WORKFLOW_DM_RECIPIENTS must contain unique exact account:user pairs");
  }
  return recipients;
}

export function ownsWorkflowDm(payload: any, recipients: readonly string[]): boolean {
  return payload?.type === "event_callback" && ["message", "app_mention"].includes(payload.event?.type)
    && /^D[A-Z0-9]{4,31}$/.test(payload.event?.channel ?? "")
    && recipients.includes(`${payload.team_id}:${payload.event?.user}`);
}

