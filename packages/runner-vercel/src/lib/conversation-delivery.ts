import type { StateAdapter } from "chat";

/** Retry only preparation known to precede delivery; a ready claim remains durable. */
export async function prepareConversationDelivery(args: {
  state: Pick<StateAdapter, "get" | "set" | "setIfNotExists" | "delete">;
  routeKey: string; eventId: string; now: string; ttlMs: number; modelEvidence?: unknown;
  subscribe: () => Promise<unknown>;
}): Promise<boolean> {
  const { state, routeKey, ttlMs } = args;
  if (await state.get(`${routeKey}:complete`)) return false;
  const claimKey = `${routeKey}:delivery-claim`;
  if (!await state.setIfNotExists(claimKey, { eventId: args.eventId, claimedAt: args.now }, ttlMs)) return false;
  try {
    if (args.modelEvidence) await state.set(`${routeKey}:model`, args.modelEvidence, ttlMs);
    // The maintained Chat subscription records local state; it sends no message.
    await args.subscribe();
  } catch (error) {
    try { await state.delete(claimKey); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Conversation preparation failed and its claim could not be released", { cause: error });
    }
    throw error;
  }
  // Never release here after a provider post, business Tool or uncertain effect.
  return true;
}
