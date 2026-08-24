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
