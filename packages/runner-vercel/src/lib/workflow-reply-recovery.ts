import type { Message } from "chat";
import type { WorkflowInboundResult } from "./workflow-conversations.ts";

export type RecoveredWorkflowMessage = Pick<Message, "id" | "text" | "author" | "metadata">;

/** Operator input is a locator. Only the maintained receiver may provide content and identity. */
export async function recoverWorkflowReply(
  reference: { threadId: string; messageId: string; authorId?: string },
  dependencies: {
    receive: (reference: { threadId: string; messageId: string; authorId?: string }) => Promise<WorkflowInboundResult>;
    dispatch: (message: RecoveredWorkflowMessage) => Promise<void>;
  },
) {
  const received = await dependencies.receive(reference);
  if (received.kind !== "conversation") return { kind: received.kind, dispatchCompleted: false,
    ...(received.kind === "decision" ? { runId: received.runId, decision: received.decision } : {}) };
  const { session } = received;
  const identity = /^slack:([A-Z0-9]{5,32}):([UW][A-Z0-9]{4,31})$/.exec(session.principal);
  const conversation = session.conversation;
  const channelRoot = reference.authorId !== undefined
    && reference.authorId === identity?.[2]
    && reference.threadId === `slack:${conversation.channelId}:${reference.messageId}`
    && /^[CDG][A-Z0-9]{4,31}$/.test(conversation.channelId)
    && Number(reference.messageId) > Number(conversation.threadId);
  if (!identity || identity[1] !== conversation.accountId
    || (reference.authorId !== undefined ? !channelRoot : reference.threadId !== `slack:${conversation.channelId}:${conversation.threadId}`)
    || !/^\d+\.\d+$/.test(reference.messageId) || reference.messageId === conversation.threadId) {
    throw new Error("Recovered workflow reply has inconsistent provider identity");
  }
  // The receiver has reread the original, unedited human message. This is not a
  // webhook or a caller-supplied statement; preserve its provider timestamp.
  // A channel-root author hint selected a candidate only; the receiver reread
  // that exact message and independently verified its actual human principal.
  const dateSent = new Date(Number(reference.messageId) * 1_000);
  if (!Number.isFinite(dateSent.getTime())) throw new Error("Recovered workflow reply timestamp is invalid");
  await dependencies.dispatch({ id: reference.messageId, text: session.text,
    author: { userId: identity[2]!, userName: session.member.name, fullName: session.member.name, isBot: false, isMe: false },
    metadata: { dateSent, edited: false } });
  return { kind: received.kind, runId: session.runId, dispatchCompleted: true };
}
