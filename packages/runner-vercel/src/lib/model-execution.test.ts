import assert from "node:assert/strict";
import test from "node:test";
import { resolveModelExecution } from "./model-execution.ts";

test("direct provider recipes construct language models without invoking the network", () => {
  const openai = resolveModelExecution({
    profile: "reasoning",
    binding: { route: "openai-direct", model: "openai/gpt-5.4-mini" },
    environment: { OPENAI_API_KEY: "synthetic-openai-key" },
  });
  assert.equal(openai.selection.provider, "openai");
  assert.notEqual(typeof openai.model, "string");

  const google = resolveModelExecution({
    profile: "utility",
    binding: { route: "google-direct", model: "google/gemini-2.5-flash" },
    environment: { GOOGLE_API_KEY: "synthetic-google-key" },
  });
  assert.equal(google.selection.credentialRef, "GOOGLE_API_KEY");
  assert.notEqual(typeof google.model, "string");
});

test("an explicit direct route fails instead of silently switching provider", () => {
  assert.throws(
    () => resolveModelExecution({
      binding: { route: "openai-direct", model: "openai/gpt-5.4-mini" },
      environment: { ANTHROPIC_API_KEY: "synthetic-anthropic-key" },
    }),
    /OPENAI_API_KEY/,
  );
});

test("the OpenAI-compatible recipe requires its explicit key and base URL", () => {
  assert.throws(
    () => resolveModelExecution({
      binding: { route: "openai-compatible", model: "compatible/openrouter/model" },
      environment: { OPENAI_COMPATIBLE_API_KEY: "synthetic-compatible-key" },
    }),
    /COMPANYOS_OPENAI_COMPATIBLE_BASE_URL/,
  );
  const compatible = resolveModelExecution({
    binding: { route: "openai-compatible", model: "compatible/openrouter/model" },
    environment: {
      OPENAI_COMPATIBLE_API_KEY: "synthetic-compatible-key",
      COMPANYOS_OPENAI_COMPATIBLE_BASE_URL: "https://models.example.test/v1",
    },
  });
  assert.equal(compatible.selection.transport, "openai-compatible");
  assert.notEqual(typeof compatible.model, "string");
});

test("named compatible recipes use their default endpoints and explicit credentials", () => {
  const openrouter = resolveModelExecution({
    binding: { route: "openrouter", model: "openrouter/anthropic/claude-sonnet-4.6" },
    environment: { OPENROUTER_API_KEY: "synthetic-openrouter-key" },
  });
  assert.equal(openrouter.selection.provider, "openrouter");
  assert.notEqual(typeof openrouter.model, "string");

  assert.throws(
    () => resolveModelExecution({
      binding: { route: "groq", model: "groq/llama-3.3-70b-versatile" },
      environment: {},
    }),
    /GROQ_API_KEY/,
  );
});

test("local compatible recipes do not require synthetic API keys", () => {
  const ollama = resolveModelExecution({
    binding: { route: "ollama", model: "ollama/qwen2.5-coder:14b" },
    environment: {},
  });
  assert.equal(ollama.selection.credentialRef, "OLLAMA_API_KEY");
  assert.notEqual(typeof ollama.model, "string");

  const llamaServer = resolveModelExecution({
    binding: { route: "llama-server", model: "llama-server/company-model" },
    environment: { LLAMA_SERVER_BASE_URL: "http://models.example.test/v1" },
  });
  assert.equal(llamaServer.selection.provider, "llama-server");
  assert.notEqual(typeof llamaServer.model, "string");
});
