import type { Message, Thread } from "chat";
import { ConversationParticipation, type ConversationMessage } from "../../../runtime/conversation-participation.ts";

/** Slack supplies facts only. Participation and output behavior belong to Core. */
export function slackConversationMessage(thread: Pick<Thread, "id" | "isDM">,
  message: Pick<Message, "id" | "text" | "author" | "metadata"> & Partial<Pick<Message, "isMention">>,
  sender: { id: string; name: string }): ConversationMessage {
  return {
    id: message.id, conversationId: thread.id, senderId: sender.id, senderName: sender.name,
    sentAt: message.metadata.dateSent.toISOString(), text: message.text,
    shared: !thread.isDM, mentioned: message.isMention === true,
    ...(thread.id.split(":")[2] && thread.id.split(":")[2] !== message.id ? { replyToId: thread.id.split(":")[2] } : {}),
  };
}

export function slackParticipation(thread: Pick<Thread, "id" | "isDM">,
  message: Parameters<typeof slackConversationMessage>[1], sender: { id: string; name: string }): ConversationParticipation {
  return new ConversationParticipation(slackConversationMessage(thread, message, sender));
}
