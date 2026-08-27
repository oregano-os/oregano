import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateKnowledgeModelCost,
  KNOWLEDGE_MODEL_PRICING_VERSION,
  rateKnowledgeModelTokens,
} from "../../knowledge/model-pricing.ts";

test("maintained Anthropic Knowledge models produce versioned token costs", () => {
  assert.deepEqual(rateKnowledgeModelTokens({
    route: "anthropic-direct",
    model: "anthropic/claude-haiku-4-5-20251001",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  }), { costUsd: 6, pricingVersion: KNOWLEDGE_MODEL_PRICING_VERSION });
  assert.deepEqual(rateKnowledgeModelTokens({
    route: "anthropic-direct",
    model: "anthropic/claude-sonnet-4-6",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  }), { costUsd: 18, pricingVersion: KNOWLEDGE_MODEL_PRICING_VERSION });
  assert.deepEqual(rateKnowledgeModelTokens({
    route: "anthropic-direct",
    model: "anthropic/claude-opus-4-7",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  }), { costUsd: 30, pricingVersion: KNOWLEDGE_MODEL_PRICING_VERSION });
});

test("unknown provider prices remain explicitly unrated", () => {
  assert.equal(rateKnowledgeModelTokens({
    route: "openai-compatible",
    model: "compatible/company-model",
    inputTokens: 1_000,
    outputTokens: 100,
  }), undefined);
  assert.equal(estimateKnowledgeModelCost({
    route: "openai-compatible",
    model: "compatible/company-model",
    inputCharacters: 4_000,
    maximumOutputTokens: 100,
  }), undefined);
});
