import type { CardElement, Chat, StateAdapter } from "chat";
import { sha256 } from "../../../../runtime/canonical.ts";
import type { BuilderJob } from "../../../../state-store/builder-jobs.ts";

export type BuilderCardPhase = "queued" | "preparing" | "coding" | "checking" | "testing" | "result" | "releasing" | "live";
const phases: BuilderCardPhase[] = ["queued", "preparing", "coding", "checking", "testing", "result", "releasing", "live"];
type Destination = Pick<BuilderJob, "jobId" | "instanceId" | "sourceConversationKey" | "sourceMessageId">;
export type BuilderCardPresenter = (job: Destination, card: CardElement, phase: BuilderCardPhase) => Promise<void>;

/** Preserve conversation history; retire consumed controls without replacing prior text. */
export function createBuilderCardPresenter(chat: Pick<Chat, "thread">, state: StateAdapter): BuilderCardPresenter {
  return async (job, card, phase) => {
    const key = `builder:card:${sha256([job.instanceId, job.jobId, job.sourceConversationKey])}`;
    const lock = await state.acquireLock(key, 60_000);
    if (!lock) throw new Error("Build request presentation is already being updated.");
    try {
      const existing = await state.get<{ messageId: string; rank: number; digest: string; card?: CardElement }>(key);
      const rank = phases.indexOf(phase), digest = sha256(card);
      if (existing && (existing.rank > rank || existing.digest === digest)) return;
      const thread = chat.thread(job.sourceConversationKey);
      const withoutActions = (value: CardElement): CardElement => ({ ...value, children: value.children.filter(child => child.type !== "actions") });
      if (existing?.card && ((existing.rank === rank && existing.card.title === card.title)
        || sha256(withoutActions(existing.card)) === sha256(withoutActions(card)))) {
        await thread.adapter.editMessage(thread.id, existing.messageId, card);
        await state.set(key, { messageId: existing.messageId, rank, digest, card });
        return;
      }
      if (existing?.card) {
        const archived = withoutActions(existing.card);
        await thread.adapter.editMessage(thread.id, existing.messageId, archived);
      }
      const messageId = (await thread.post(card)).id;
      await state.set(key, { messageId, rank, digest, card });
    } finally { await state.releaseLock(lock); }
  };
}
