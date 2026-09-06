/** Optional, content-free Connector evidence. Absence never proves no dispatch. */
export interface CapabilityItemOutcome {
  item_id: string;
  status: "verified" | "unknown" | "not-attempted";
  provider_version?: string;
}
export interface CapabilityEffectReview {
  version: 1;
  items: CapabilityItemOutcome[];
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 255 && !/[\u0000-\u001f\u007f]/.test(value);

/** Strict allowlist: never pass arbitrary provider payloads or errors to an operator report. */
export function capabilityEffectReview(value: unknown): CapabilityEffectReview | undefined {
  const review = object(value);
  if (review?.version !== 1 || !Array.isArray(review.items) || review.items.length < 1 || review.items.length > 1000) return undefined;
  const items: CapabilityItemOutcome[] = [];
  for (const raw of review.items) {
    const item = object(raw);
    if (!item || !text(item.item_id) || !["verified", "unknown", "not-attempted"].includes(String(item.status))
      || (item.provider_version !== undefined && !text(item.provider_version))) return undefined;
    items.push({ item_id: item.item_id, status: item.status as CapabilityItemOutcome["status"],
      ...(item.provider_version === undefined ? {} : { provider_version: item.provider_version as string }) });
  }
  if (new Set(items.map((item) => item.item_id)).size !== items.length) return undefined;
  return { version: 1, items };
}

export function batchItemIds(input: unknown): string[] | undefined {
  const updates = object(input)?.updates;
  if (!Array.isArray(updates) || updates.length < 1 || updates.length > 1000) return undefined;
  const ids = updates.map((entry) => object(entry)?.work_item_id);
  return ids.every(text) && new Set(ids).size === ids.length ? ids : undefined;
}

export function matchingBatchReview(value: unknown, ids: string[]): CapabilityEffectReview | undefined {
  const review = capabilityEffectReview(value);
  if (!review || review.items.length !== ids.length || review.items.some((item, i) => item.item_id !== ids[i])) return undefined;
  return review;
}
