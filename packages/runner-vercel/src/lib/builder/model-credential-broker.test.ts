import assert from "node:assert/strict";
import test from "node:test";
import {
  createVercelModelCredentialBinding,
  modelCredentialBindingEvidence,
} from "./model-credential-broker.ts";

test("Claude credential binding keeps the real credential outside the agent environment", () => {
  const secret = "anthropic-qualification-secret";
  const binding = createVercelModelCredentialBinding("claude-code", secret);
  assert.equal(binding.host, "api.anthropic.com");
  assert.equal(binding.agentEnvironment.ANTHROPIC_API_KEY, "companyos-builder-broker-placeholder");
  assert.equal(JSON.stringify(binding.agentEnvironment).includes(secret), false);
  assert.equal(JSON.stringify(modelCredentialBindingEvidence(binding)).includes(secret), false);
  assert.equal(JSON.stringify(binding.networkPolicy).includes(secret), true);
});

test("Codex credential binding keeps the real credential outside the agent environment", () => {
  const secret = "openai-qualification-secret";
  const binding = createVercelModelCredentialBinding("codex", secret);
  assert.equal(binding.host, "api.openai.com");
  assert.equal(binding.agentEnvironment.CODEX_API_KEY, "companyos-builder-broker-placeholder");
  assert.equal(binding.agentEnvironment.DEFAULT_AUTH_REQUEST, '{"methodId":"api-key"}');
  assert.equal(JSON.stringify(binding.agentEnvironment).includes(secret), false);
  assert.equal(JSON.stringify(modelCredentialBindingEvidence(binding)).includes(secret), false);
  assert.equal(JSON.stringify(binding.networkPolicy).includes(secret), true);
});

test("credential binding fails closed for missing or header-shaped credentials", () => {
  assert.throws(() => createVercelModelCredentialBinding("codex", ""), /required/);
  assert.throws(() => createVercelModelCredentialBinding("claude-code", "secret\nheader"), /invalid header/);
});
