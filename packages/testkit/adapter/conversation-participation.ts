import type { ConversationMessage } from "../../runtime/conversation-participation.ts";

/** Shared admission fixtures for every communication adapter; not model-quality assertions. */
export const participationCases: { title: string; shared: boolean; mentioned: boolean; ambient: boolean }[] = [
  { title: "direct conversation", shared: false, mentioned: false, ambient: false },
  { title: "explicit group mention", shared: true, mentioned: true, ambient: false },
  { title: "unmentioned group follow-up or human discussion", shared: true, mentioned: false, ambient: true },
];

export function participationMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return { id: "message-2", conversationId: "synthetic-chat:room:thread", senderId: "person:alice", senderName: "Alice",
    sentAt: "2026-09-11T10:00:00Z", text: "And how does that work?", shared: true, mentioned: false, ...overrides };
}
