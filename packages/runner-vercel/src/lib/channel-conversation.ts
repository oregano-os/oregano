import { allowsChannelConversation, type CompiledAgentRouting } from "../../../runtime/agent-resolver.ts";

/** Called on verified inbound identities, before any conversation side effect. */
export function allowsConversationAtThread(routing: CompiledAgentRouting, threadId: string, requesterPrincipal?: string): boolean {
  const [surface, channelId] = threadId.split(":");
  const [principalSurface, accountId, subjectId] = (requesterPrincipal ?? "").split(":");
  if (!surface || !channelId || surface !== principalSurface || !accountId || !subjectId) return false;
  return allowsChannelConversation(routing, { surface, accountId, channelId });
}
