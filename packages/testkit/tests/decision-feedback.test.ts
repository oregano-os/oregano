import assert from "node:assert/strict";
import test from "node:test";
import { decisionFeedback } from "../../runtime/decision-feedback.ts";
test("system feedback selects the language family and safely falls back for older artifacts", () => {
  assert.match(decisionFeedback("processing", "de-AT").title, /verarbeitet/);
  for (const language of [undefined, "en-GB", "fr", "not a language"]) assert.equal(decisionFeedback("processing", language).title, "Processing your decision…");
  assert.doesNotMatch(decisionFeedback("processing", "de").content, /gespeichert wurde/);
});
