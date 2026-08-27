import assert from "node:assert/strict";
import test from "node:test";
import {
  CORE_MODEL_RECIPE_REGISTRY,
  decodeModelRuntimeConfiguration,
  resolveModelExecutionSelection,
} from "../../runner/model-execution.ts";

const encoded = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");

test("Core registers native, named compatible, local, and generic provider recipes", () => {
  assert.deepEqual(CORE_MODEL_RECIPE_REGISTRY.list().map((entry) => entry.route), [
    "anthropic-direct",
    "deepseek",
    "google-direct",
    "groq",
    "litellm",
    "llama-server",
    "minimax",
    "mistral",
    "moonshot",
    "nvidia",
    "ollama",
    "openai-compatible",
    "openai-direct",
    "openrouter",
    "together",
    "vercel-ai-gateway",
    "zhipu",
  ]);
  assert.equal(CORE_MODEL_RECIPE_REGISTRY.resolve("anthropic-direct").credentialRefs[0], "ANTHROPIC_API_KEY");
  assert.equal(CORE_MODEL_RECIPE_REGISTRY.resolve("openai-compatible").baseUrlRef, "COMPANYOS_OPENAI_COMPATIBLE_BASE_URL");
  assert.equal(CORE_MODEL_RECIPE_REGISTRY.resolve("openrouter").defaultBaseUrl, "https://openrouter.ai/api/v1");
  assert.equal(CORE_MODEL_RECIPE_REGISTRY.resolve("ollama").credentialRequired, false);
  assert.equal(CORE_MODEL_RECIPE_REGISTRY.resolve("ollama").defaultBaseUrl, "http://localhost:11434/v1");
});

test("named compatible recipes accept provider-native model IDs without a static allowlist", () => {
  const openrouter = resolveModelExecutionSelection({
    binding: { route: "openrouter", model: "openrouter/example-provider/future-model-v9" },
    environment: { OPENROUTER_API_KEY: "test-openrouter" },
  });
  assert.equal(openrouter.provider, "openrouter");
  assert.equal(openrouter.credentialRef, "OPENROUTER_API_KEY");

  const inferredLocal = resolveModelExecutionSelection({
    profile: "utility",
    environment: { COMPANYOS_MODEL: "ollama/private-model:latest" },
  });
  assert.equal(inferredLocal.route, "ollama");
});

test("task bindings override profiles and defaults deterministically", () => {
  const configuration = decodeModelRuntimeConfiguration(encoded({
    version: 1,
    default: { route: "vercel-ai-gateway", model: "openai/gpt-5.4-nano" },
    profiles: { reasoning: { route: "anthropic-direct", model: "anthropic/claude-sonnet-4-6", maxOutputTokens: 8_000 } },
    tasks: { "knowledge.claim-extraction": { route: "openai-direct", model: "openai/gpt-5.4-mini", timeoutMs: 30_000, retries: 1 } },
  }));
  const task = resolveModelExecutionSelection({
    profile: "reasoning",
    task: "knowledge.claim-extraction",
    configuration,
    environment: { OPENAI_API_KEY: "test-openai", ANTHROPIC_API_KEY: "test-anthropic" },
  });
  assert.equal(task.route, "openai-direct");
  assert.equal(task.timeoutMs, 30_000);
  const profile = resolveModelExecutionSelection({ profile: "reasoning", task: "knowledge.conflict-judgment", configuration, environment: {} });
  assert.equal(profile.route, "anthropic-direct");
  assert.equal(profile.maxOutputTokens, 8_000);
  const fallback = resolveModelExecutionSelection({ profile: "utility", configuration, environment: {} });
  assert.equal(fallback.route, "vercel-ai-gateway");
});

test("explicit binding wins and key-aware defaults are stable Anthropic then OpenAI", () => {
  const explicit = resolveModelExecutionSelection({
    profile: "agent",
    binding: { route: "google-direct", model: "google/gemini-2.5-flash" },
    environment: { ANTHROPIC_API_KEY: "test-anthropic", GOOGLE_API_KEY: "test-google" },
  });
  assert.equal(explicit.route, "google-direct");
  assert.equal(explicit.credentialRef, "GOOGLE_API_KEY");

  const anthropic = resolveModelExecutionSelection({ profile: "utility", environment: { ANTHROPIC_API_KEY: "test-anthropic", OPENAI_API_KEY: "test-openai" } });
  assert.deepEqual([anthropic.route, anthropic.model], ["anthropic-direct", "anthropic/claude-haiku-4-5"]);
  const openai = resolveModelExecutionSelection({ profile: "reasoning", environment: { OPENAI_API_KEY: "test-openai" } });
  assert.deepEqual([openai.route, openai.model], ["openai-direct", "openai/gpt-5.4-mini"]);
});

test("recipe validation rejects mismatched models, unsupported capability, and unknown config", () => {
  assert.throws(
    () => resolveModelExecutionSelection({ binding: { route: "anthropic-direct", model: "openai/gpt-5.4-mini" }, environment: { ANTHROPIC_API_KEY: "test" } }),
    /not supported/,
  );
  assert.throws(
    () => resolveModelExecutionSelection({ profile: "embedding", binding: { route: "anthropic-direct", model: "anthropic/claude-haiku-4-5" }, requiredCapability: "embedding", environment: { ANTHROPIC_API_KEY: "test" } }),
    /does not support 'embedding'/,
  );
  assert.throws(() => decodeModelRuntimeConfiguration(encoded({ version: 1, surprise: true })), /unsupported shape/);
});
