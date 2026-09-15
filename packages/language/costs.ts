import type { LanguageAttemptReceipt } from "./attempts.ts";

/** Operator-supplied dated prices; no model registry or implicit live pricing lookup. */
export interface LanguagePrice {
  route: string; model: string; currency: string; source: string;
  valid_from: string; valid_until: string | null;
  input_per_million: number; output_per_million: number;
  cache_read_per_million: number; cache_write_per_million: number;
}
export interface LanguageBilledCost { attempt_id: string; amount: number; currency: string; receipt_ref: string }
export interface LanguageCost {
  attempt_id: string; run_id: string; step_id: string;
  basis: "billed" | "estimated" | "unknown";
  amount: number | null; currency: string | null; source: string | null;
}
const quantity = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const tokens = (v: unknown): v is number => quantity(v) && Number.isSafeInteger(v);
const instant = (v: string) => /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));

/** Failed attempts retain their cost; reasoning tokens are already included in output tokens. */
export function languageCostReport(attempts: readonly LanguageAttemptReceipt[], prices: readonly LanguagePrice[] = [], billed: readonly LanguageBilledCost[] = []) {
  const ids = new Set(attempts.map(x => x.attempt_id));
  if (ids.size !== attempts.length) throw new Error("Duplicate language attempts would double-count costs");
  const billedById = new Map<string, LanguageBilledCost>();
  for (const item of billed) {
    if (!ids.has(item.attempt_id) || billedById.has(item.attempt_id) || !quantity(item.amount) || !/^[A-Z]{3}$/.test(item.currency) || !item.receipt_ref) throw new Error("Invalid or duplicate billed language cost");
    billedById.set(item.attempt_id, item);
  }
  for (const price of prices) {
    if (!price.route || !price.model || !price.source || !/^[A-Z]{3}$/.test(price.currency) || !instant(price.valid_from)
      || (price.valid_until !== null && (!instant(price.valid_until) || Date.parse(price.valid_until) <= Date.parse(price.valid_from)))
      || ![price.input_per_million, price.output_per_million, price.cache_read_per_million, price.cache_write_per_million].every(quantity)) throw new Error("Invalid dated language price");
  }
  const costs: LanguageCost[] = attempts.map(attempt => {
    const base = { attempt_id: attempt.attempt_id, run_id: attempt.run_id, step_id: attempt.step_id };
    const bill = billedById.get(attempt.attempt_id);
    if (bill) return { ...base, basis: "billed", amount: bill.amount, currency: bill.currency, source: bill.receipt_ref };
    const unknown: LanguageCost = { ...base, basis: "unknown", amount: null, currency: null, source: null };
    const usage = attempt.evidence.model_execution as Record<string, unknown> | undefined;
    if (!usage || !attempt.dispatched_at) return unknown;
    const date = Date.parse(attempt.dispatched_at);
    const matching = prices.filter(price => price.route === usage.route && price.model === usage.model && Date.parse(price.valid_from) <= date && (price.valid_until === null || date < Date.parse(price.valid_until)));
    if (matching.length > 1) throw new Error("Ambiguous language price for one attempt");
    const price = matching[0];
    if (!price || !tokens(usage.inputTokens) || !tokens(usage.outputTokens) || !tokens(usage.cacheReadTokens) || !tokens(usage.cacheWriteTokens)) return unknown;
    const uncached = usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens;
    if (uncached < 0 || (usage.uncachedInputTokens !== null && usage.uncachedInputTokens !== undefined && usage.uncachedInputTokens !== uncached)) throw new Error("Language usage token components do not reconcile");
    const amount = (uncached * price.input_per_million + usage.outputTokens * price.output_per_million + usage.cacheReadTokens * price.cache_read_per_million + usage.cacheWriteTokens * price.cache_write_per_million) / 1_000_000;
    if (!Number.isFinite(amount)) throw new Error("Language cost exceeds finite numeric bounds");
    return { ...base, basis: "estimated", amount, currency: price.currency, source: price.source };
  });
  const totals: Record<string, { billed: number; estimated: number }> = {};
  for (const cost of costs) if (cost.currency && cost.amount !== null && cost.basis !== "unknown") {
    const subtotal = totals[cost.currency] ??= { billed: 0, estimated: 0 };
    subtotal[cost.basis] += cost.amount;
  }
  return { attempts: costs, totals, unknown_attempts: costs.filter(cost => cost.basis === "unknown").length,
    complete: costs.every(cost => cost.basis !== "unknown"), infrastructure: "not-attributed" as const };
}
