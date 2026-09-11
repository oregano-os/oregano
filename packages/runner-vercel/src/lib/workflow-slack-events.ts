import type { WorkflowSlackChannelKind } from "../../../connectors/slack/workflow-transport.ts";

/** Provider metadata is checked before asking a person to reply. It is not delivery proof. */
export function requireWorkflowSlackReplyEvents(metadata: unknown, kind: WorkflowSlackChannelKind): void {
  const connector = metadata as { type?: unknown; triggers?: { enabled?: unknown }; events?: unknown } | null;
  const required = { "direct-message": "message.im", "private-channel": "message.groups", "public-channel": "message.channels" }[kind];
  if (connector?.type !== "slack" || connector.triggers?.enabled !== true || !Array.isArray(connector.events) || !connector.events.includes(required)) {
    throw new Error(`Workflow conversation cannot receive replies: enable ${required} and trigger forwarding on the bound Slack connector. Review shared-app production routing before changing subscriptions.`);
  }
}
