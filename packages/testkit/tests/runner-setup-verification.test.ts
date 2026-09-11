import assert from "node:assert/strict";
import test from "node:test";
import { setupVerificationPrompt, setupVerificationResponse } from "../../runner-vercel/src/lib/setup-verification.ts";

test("the Runner recognizes one exact nonce-bound setup response and creates a model proof prompt", () => {
  const expected = "Setup-Test oregano-0123456789ab successful.";
  assert.equal(
    setupVerificationResponse("<@U123> Setup-Test oregano-0123456789ab"),
    expected,
  );
  assert.match(setupVerificationPrompt(expected), /exactly this single line/);
  assert.match(setupVerificationPrompt(expected), new RegExp(expected.replaceAll(".", "\\.")));
  assert.equal(setupVerificationResponse("Setup-Test another-value"), null);
  assert.equal(setupVerificationResponse("Please discuss oregano-0123456789ab"), null);
});


test("natural setup proof binds the exact delivered exchange and rejects stale or different identities", async () => {
  const { setupExchangeKey, matchesSetupExchange } = await import('../../runner-vercel/src/lib/setup-verification.ts');
  const expected = { artifact_hash: 'a'.repeat(64), core_commit: 'b'.repeat(40), workspace_commit: 'c'.repeat(40), principal: 'slack:T12345678:U12345678', model_route: 'vercel-ai-gateway', model: 'openai/gpt-5.4-nano', since: '2026-01-01T00:00:00Z' };
  const receipt = { ...expected, version: 1, message_id: '1234.5678', conversation_key: 'conversation:slack:example:oregano', response_id: 'response-example', delivered_at: new Date().toISOString() };
  assert.match(setupExchangeKey(expected.artifact_hash, expected.principal), /^setup-exchange:/);
  assert.equal(matchesSetupExchange(receipt, expected), true);
  for (const patch of [{ principal: 'slack:T12345678:U87654321' }, { artifact_hash: 'd'.repeat(64) }, { model: 'another/model' }, { response_id: '' }, { delivered_at: '2025-12-01T00:00:00Z' }]) {
    assert.equal(matchesSetupExchange({ ...receipt, ...patch }, expected), false);
  }
  assert.throws(() => setupExchangeKey('invalid', expected.principal));
});
