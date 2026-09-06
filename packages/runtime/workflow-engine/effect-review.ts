import { batchItemIds, capabilityEffectReview, matchingBatchReview, type CapabilityEffectReview } from "../../capabilities/effect-review.ts";
import { jsonDigest } from "../canonical.ts";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const bounded = (value: unknown): string | undefined => typeof value === "string" && value.length <= 255 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;

/** Read stored receipts only. This never reconciles, retries, approves or exposes raw errors. */
export function workflowEffectReview(effect: Record<string, unknown> | undefined, input: unknown) {
  if (!effect) return { status: "unclaimed", capabilities: [], retryAuthorized: false as const };
  const evidence = object(effect.evidence), partial = object(evidence.partial_evidence);
  const records = Array.isArray(partial.capability_effects) ? partial.capability_effects : [];
  const capabilities = records.slice(0, 100).map((value) => {
    const record = object(value), capability = bounded(record.capability);
    const ids = capability === "work-item.batch-update" ? batchItemIds(input) : undefined;
    let review: CapabilityEffectReview | undefined = ids ? matchingBatchReview(record.effect_review, ids) : capabilityEffectReview(record.effect_review);
    if (!review && ids) review = { version: 1, items: ids.map((item_id) => ({ item_id, status: "unknown" })) };
    return { capability: capability ?? "unidentified", connector: bounded(record.connector) ?? "unidentified",
      connectorVersion: bounded(record.connector_version) ?? "unidentified", evidenceDigest: jsonDigest(value),
      ...(review ? { items: review.items } : {}) };
  });
  return { status: bounded(effect.status) ?? "unknown", inputDigest: bounded(effect.input_hash ?? effect.inputHash) ?? null,
    evidenceDigest: jsonDigest(effect.evidence ?? null), capabilities,
    ...(records.length > 100 ? { additionalCapabilityReceipts: records.length - 100 } : {}), retryAuthorized: false as const };
}
