import type { WorkflowSlackChannelKind } from "../../../connectors/slack/workflow-transport.ts";

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
  if (payload?.type === "block_actions") {
    const team = payload.team?.id, user = payload.user?.id;
    return typeof team === "string" && typeof user === "string"
      && [payload.channel?.id, payload.container?.channel_id].some(channel => typeof channel === "string" && /^D[A-Z0-9]{4,31}$/.test(channel))
      && recipients.includes(`${team}:${user}`);
  }
  return payload?.type === "event_callback" && ["message", "app_mention"].includes(payload.event?.type)
    && /^D[A-Z0-9]{4,31}$/.test(payload.event?.channel ?? "")
    && recipients.includes(`${payload.team_id}:${payload.event?.user}`);
}

/** Fail before publishing a question into a DM that this endpoint cannot receive. */
export function requireWorkflowReplyRoute(kind: WorkflowSlackChannelKind, principal: string | undefined,
  workflowOnly = process.env.COMPANYOS_WORKFLOW_ONLY === "true", recipients = workflowDmRecipients()): void {
  if (kind !== "direct-message" || !workflowOnly) return;
  if (!principal?.startsWith("slack:") || !recipients.includes(principal.slice("slack:".length))) {
    throw new Error("Workflow direct-message replies are not routed to this Instance. Configure and verify an exclusive account:user route on both shared-app destinations before sending a question, or use the qualified test channel.");
  }
}
