import type { ConversationTranscriptMessage } from "../../../runtime/shared-conversation.ts";
import type { RosterMember } from "../../../state-store/roster.ts";

type SlackMessage = { ts?: string; user?: string; bot_id?: string; username?: string; subtype?: string; text?: string; thread_ts?: string };
export interface SlackHistoryClient {
  conversations: {
    history(args: { channel: string; latest: string; inclusive: boolean; limit: number }): Promise<{ ok?: boolean; messages?: SlackMessage[] }>;
    replies(args: { channel: string; ts: string; latest: string; inclusive: boolean; limit: number }): Promise<{ ok?: boolean; messages?: SlackMessage[] }>;
  };
}

const TS = /^\d+\.\d+$/;
export const RECENT_MESSAGE_LIMIT = 10;

/**
 * Reads the messages immediately before one verified message at the same place:
 * the thread root plus earlier replies inside a thread, otherwise the main
 * channel or DM. Provider text is untrusted context for interpretation only.
 */
export async function slackRecentMessages(args: {
  client: SlackHistoryClient; accountId: string; channelId: string; threadId: string; messageId: string; roster: readonly RosterMember[];
}): Promise<ConversationTranscriptMessage[]> {
  if (!TS.test(args.threadId) || !TS.test(args.messageId)) throw new Error("Recent messages require exact Slack message identities");
  const inThread = args.threadId !== args.messageId;
  const response = inThread
    ? await args.client.conversations.replies({ channel: args.channelId, ts: args.threadId, latest: args.messageId, inclusive: false, limit: 200 })
    : await args.client.conversations.history({ channel: args.channelId, latest: args.messageId, inclusive: false, limit: RECENT_MESSAGE_LIMIT });
  if (response.ok === false || !Array.isArray(response.messages)) throw new Error("Slack returned no readable conversation history");
  const before = response.messages.filter(message => typeof message.ts === "string" && TS.test(message.ts) && Number(message.ts) < Number(args.messageId)
    && (!inThread || message.ts === args.threadId || message.thread_ts === args.threadId));
  before.sort((a, b) => Number(a.ts) - Number(b.ts));
  const selected = inThread
    ? [...before.filter(message => message.ts === args.threadId), ...before.filter(message => message.ts !== args.threadId).slice(-RECENT_MESSAGE_LIMIT)]
    : before.slice(-RECENT_MESSAGE_LIMIT);
  return selected.map(message => {
    const principal = message.user ? `slack:${args.accountId}:${message.user}` : undefined;
    const member = principal ? args.roster.find(entry => entry.principals?.includes(principal) || (entry.teamId === args.accountId && entry.userId === message.user)) : undefined;
    const app = !!message.bot_id || message.subtype === "bot_message";
    return { messageId: message.ts!, sentAt: new Date(Number(message.ts) * 1000).toISOString(),
      sender: app ? (message.username || "App") : member?.name ?? "Unknown person", kind: app ? "app" as const : member ? "human" as const : "other" as const,
      text: (message.text ?? "").slice(0, 1500) };
  });
}
