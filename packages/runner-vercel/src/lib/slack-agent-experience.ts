import type { StateAdapter, Thread } from "chat";

export interface SlackAgentExperienceConfiguration {
  enabled: boolean;
  streamingEnabled: boolean;
  workingStatus: "Working";
}

const SLACK_ROOT_MESSAGE_ID = /^\d{10,}\.\d+$/u;
const SLACK_AGENT_SESSION_BRIDGE_TTL_MS = 2 * 60 * 60 * 1000;

function agentSessionConversationKey(sessionThreadId: string): string {
  return `slack:agent-session-conversation:${sessionThreadId}`;
}

export function resolveSlackAgentExperience(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SlackAgentExperienceConfiguration {
  return {
    enabled: environment.COMPANYOS_SLACK_AGENT_VIEW === "true",
    streamingEnabled: environment.COMPANYOS_SLACK_AGENT_VIEW === "true",
    workingStatus: "Working",
  };
}

/**
 * Stream only text whose provider-visible form cannot be changed by a later
 * CompanyOS trust check. Granted business Tool loops, required Knowledge
 * grounding, and Builder turns remain buffered until their final presentation
 * has been validated. An internal Agent-handoff control is not a business Tool.
 */
export function shouldStreamSlackAgentResponse(input: {
  configuration: SlackAgentExperienceConfiguration;
  agentId: string;
  knowledgeRouteKind: "auto" | "required-search";
  businessToolCount: number;
}): boolean {
  return input.configuration.streamingEnabled
    && input.agentId !== "builder"
    && input.knowledgeRouteKind === "auto"
    && input.businessToolCount === 0;
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
 * Preserve an exact, short-lived bridge for DMs that still execute under the
 * legacy channel-wide conversation id. Slack sends native stop events for the
 * per-message Agent Session id, so the event handler needs this durable mapping
 * to cancel the correct CompanyOS turn across serverless invocations.
 */
export async function rememberSlackAgentSessionConversation(
  state: Pick<StateAdapter, "set">,
  sessionThreadId: string,
  conversationThreadId: string,
  configuration: SlackAgentExperienceConfiguration,
): Promise<void> {
  if (!configuration.enabled || sessionThreadId === conversationThreadId) return;
  await state.set(
    agentSessionConversationKey(sessionThreadId),
    conversationThreadId,
    SLACK_AGENT_SESSION_BRIDGE_TTL_MS,
  );
}

/**
 * Chat SDK cancels native per-message sessions directly. This bridge handles
 * only pre-Agent-View DMs whose active turn is still keyed by the legacy
 * CompanyOS conversation id.
 */
export async function abortRememberedSlackAgentSessionConversation(
  chat: { abortTurn(threadId: string): Promise<void> },
  state: Pick<StateAdapter, "delete" | "get">,
  sessionThreadId: string,
  configuration: SlackAgentExperienceConfiguration,
): Promise<boolean> {
  if (!configuration.enabled) return false;
  const key = agentSessionConversationKey(sessionThreadId);
  const conversationThreadId = await state.get<string>(key);
  if (!conversationThreadId || conversationThreadId === sessionThreadId) return false;
  await chat.abortTurn(conversationThreadId);
  await state.delete(key);
  return true;
}

/**
 * Combine the platform stop signal with the configured model timeout. A Slack
 * stop therefore cancels upstream generation without weakening the existing
 * timeout boundary.
 */
export function resolveSlackTurnAbortSignal(
  platformSignal: AbortSignal,
  timeoutMs: number | undefined,
): AbortSignal {
  if (timeoutMs === undefined) return platformSignal;
  return AbortSignal.any([platformSignal, AbortSignal.timeout(timeoutMs)]);
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
