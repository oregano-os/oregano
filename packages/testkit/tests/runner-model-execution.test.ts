import assert from "node:assert/strict";
import test from "node:test";
import { normalizeModelExecution } from "../../runner/model-execution.ts";
import { modelExecutionEvidence, resolveModelExecution } from "../../runner-vercel/src/lib/model-execution.ts";

test("Gateway and direct Anthropic execution are distinct normalized routes", () => {
  assert.deepEqual(normalizeModelExecution("vercel-ai-gateway", "openai/gpt-5.4-nano"), {
    route: "vercel-ai-gateway",
    provider: "vercel-ai-gateway",
    model: "openai/gpt-5.4-nano",
    transport: "ai-gateway",
    credentialRef: null,
    baseUrlRef: null,
    recipeVersion: "1.0.0",
  });
  assert.deepEqual(normalizeModelExecution("anthropic-direct", "anthropic/claude-sonnet-4-5"), {
    route: "anthropic-direct",
    provider: "anthropic",
    model: "anthropic/claude-sonnet-4-5",
    transport: "anthropic-messages",
    credentialRef: "ANTHROPIC_API_KEY",
    baseUrlRef: null,
    recipeVersion: "1.0.0",
  });
  assert.throws(() => normalizeModelExecution("anthropic-direct", "openai/gpt-5.4-nano"), /not supported/);
});

test("direct Anthropic requires its runtime secret while Gateway does not", () => {
  const gateway = resolveModelExecution({ COMPANYOS_MODEL_ROUTE: "vercel-ai-gateway", COMPANYOS_MODEL: "openai/gpt-5.4-nano" });
  assert.equal(gateway.model, "openai/gpt-5.4-nano");
  assert.throws(
    () => resolveModelExecution({ COMPANYOS_MODEL_ROUTE: "anthropic-direct", COMPANYOS_MODEL: "anthropic/claude-sonnet-4-5" }),
    /ANTHROPIC_API_KEY/,
  );
  const direct = resolveModelExecution({
    COMPANYOS_MODEL_ROUTE: "anthropic-direct",
    COMPANYOS_MODEL: "anthropic/claude-sonnet-4-5",
    ANTHROPIC_API_KEY: "synthetic-test-value",
  });
  assert.equal(direct.selection.provider, "anthropic");
  assert.notEqual(typeof direct.model, "string");
});

test("model execution evidence is non-secret and route-bound", () => {
  const selection = normalizeModelExecution("anthropic-direct", "anthropic/claude-sonnet-4-5");
  const evidence = modelExecutionEvidence(selection, {
    response: { id: "msg_synthetic", modelId: "claude-sonnet-4-5" },
    usage: { inputTokens: 12, outputTokens: 4 },
  });
  assert.equal(evidence.route, "anthropic-direct");
  assert.equal(evidence.responseId, "msg_synthetic");
  assert.equal(evidence.inputTokens, 12);
  assert.doesNotMatch(JSON.stringify(evidence), /synthetic-test-value/);
});
