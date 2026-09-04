import type { Thread } from "chat";

export interface SlackAgentExperienceConfiguration {
  enabled: boolean;
  workingStatus: "Working";
}

const SLACK_ROOT_MESSAGE_ID = /^\d{10,}\.\d+$/u;

export function resolveSlackAgentExperience(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SlackAgentExperienceConfiguration {
  return {
    enabled: environment.COMPANYOS_SLACK_AGENT_VIEW === "true",
    workingStatus: "Working",
  };
}

/**
 * Agent View assigns one session to each Slack root message. A DM that was
 * subscribed before Agent View was enabled can still arrive under the legacy
 * channel-wide thread id (`slack:<channel>:`). Use the accepted inbound root
 * message for the Agent Session presentation and reply while the durable
 * legacy conversation and its Agent assignment remain unchanged.
 */
export function resolveSlackAgentSessionThreadId(
  threadId: string,
  messageId: string,
  configuration: SlackAgentExperienceConfiguration,
): string {
  if (!configuration.enabled) return threadId;
  const parts = threadId.split(":");
  if (parts.length !== 3 || parts[0] !== "slack" || !parts[1]?.startsWith("D") || parts[2]) return threadId;
  if (!SLACK_ROOT_MESSAGE_ID.test(messageId)) return threadId;
  return `slack:${parts[1]}:${messageId}`;
}

/**
 * Provider presentation is deliberately best effort. CompanyOS authorization,
 * Agent resolution, model execution, and the resulting response must not fail
 * merely because Slack cannot display an optional status indicator.
 */
export async function showSlackAgentWorking(
  thread: Pick<Thread, "startTyping">,
  configuration: SlackAgentExperienceConfiguration,
): Promise<void> {
  if (!configuration.enabled) return;
  try {
    await thread.startTyping(configuration.workingStatus);
  } catch {
    // The Slack adapter logs provider failures. Keep the accepted turn running.
  }
}
