import type { Thread } from "chat";

export interface SlackAgentExperienceConfiguration {
  enabled: boolean;
  workingStatus: "Working";
}

export function resolveSlackAgentExperience(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SlackAgentExperienceConfiguration {
  return {
    enabled: environment.COMPANYOS_SLACK_AGENT_VIEW === "true",
    workingStatus: "Working",
  };
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
