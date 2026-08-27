export const KNOWLEDGE_MODEL_PRICING_VERSION = "2026-08-27" as const;

export interface KnowledgeModelTokenPrice {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

const PRICES: Readonly<Record<string, KnowledgeModelTokenPrice>> = Object.freeze({
  "anthropic-direct:anthropic/claude-haiku-4-5-20251001": Object.freeze({
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 5,
  }),
  "anthropic-direct:anthropic/claude-sonnet-4-6": Object.freeze({
    inputUsdPerMillionTokens: 3,
    outputUsdPerMillionTokens: 15,
  }),
  "anthropic-direct:anthropic/claude-opus-4-7": Object.freeze({
    inputUsdPerMillionTokens: 5,
    outputUsdPerMillionTokens: 25,
  }),
});

export function resolveKnowledgeModelTokenPrice(
  route: string,
  model: string,
): KnowledgeModelTokenPrice | undefined {
  const value = PRICES[`${route}:${model}`];
  return value ? structuredClone(value) : undefined;
}

export function rateKnowledgeModelTokens(input: {
  route: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): { costUsd: number; pricingVersion: typeof KNOWLEDGE_MODEL_PRICING_VERSION } | undefined {
  const price = resolveKnowledgeModelTokenPrice(input.route, input.model);
  if (!price) return undefined;
  if (!Number.isInteger(input.inputTokens) || input.inputTokens < 0
    || !Number.isInteger(input.outputTokens) || input.outputTokens < 0) {
    throw new Error("Knowledge model token usage is invalid for pricing.");
  }
  const costUsd = (
    input.inputTokens * price.inputUsdPerMillionTokens
    + input.outputTokens * price.outputUsdPerMillionTokens
  ) / 1_000_000;
  return { costUsd, pricingVersion: KNOWLEDGE_MODEL_PRICING_VERSION };
}

export function estimateKnowledgeModelCost(input: {
  route: string;
  model: string;
  inputCharacters: number;
  maximumOutputTokens: number;
}): { estimatedCostUsd: number; pricingVersion: typeof KNOWLEDGE_MODEL_PRICING_VERSION } | undefined {
  const estimatedInputTokens = Math.max(1, Math.ceil(input.inputCharacters / 3));
  const rated = rateKnowledgeModelTokens({
    route: input.route,
    model: input.model,
    inputTokens: estimatedInputTokens,
    outputTokens: input.maximumOutputTokens,
  });
  return rated ? { estimatedCostUsd: rated.costUsd, pricingVersion: rated.pricingVersion } : undefined;
}
