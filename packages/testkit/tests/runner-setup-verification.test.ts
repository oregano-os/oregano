import assert from "node:assert/strict";
import test from "node:test";
import { setupVerificationResponse } from "../../runner-vercel/src/lib/setup-verification.ts";

test("the Runner returns one exact nonce-bound setup response without model interpretation", () => {
  assert.equal(
    setupVerificationResponse("<@U123> Setup-Test oregano-0123456789ab"),
    "Setup-Test oregano-0123456789ab successful.",
  );
  assert.equal(setupVerificationResponse("Setup-Test another-value"), null);
  assert.equal(setupVerificationResponse("Please discuss oregano-0123456789ab"), null);
});
