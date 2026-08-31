import type { Chat } from "chat";
import type { BuilderTerminalNotifier } from "../../../../runtime/builder/notifications.ts";
import { builderTerminalActionCard } from "./action-cards.ts";

export function createBuilderChatNotifier(chat: Pick<Chat, "thread">): BuilderTerminalNotifier {
  return {
    async deliver(job) {
      const thread = chat.thread(job.sourceConversationKey);
      const card = builderTerminalActionCard(job);
      if (job.sourceMessageId) {
        await thread.adapter.editMessage(thread.id, job.sourceMessageId, card);
        return;
      }
      await thread.post(card);
    },
  };
}
