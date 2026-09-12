import assert from "node:assert/strict";
import { test } from "node:test";
import { hasSubmittedCollection, hasDeliveredCollectionReview } from "../../runner-vercel/src/lib/workflow-conversation-presentation.ts";

test("only a successful collection result ends the collecting turn, including a correction without a review", () => {
  assert.equal(hasSubmittedCollection([{ toolName: "companyos_collect_facts", output: { collected: true, authorized: false } }]), true);
  assert.equal(hasDeliveredCollectionReview([{ toolName: "companyos_collect_facts", output: { collected: true, authorized: false } }]), false);
  for (const output of [undefined, "collected", { collected: false, authorized: false }, { collected: true }, { collected: true, authorized: true }]) {
    assert.equal(hasSubmittedCollection([{ toolName: "companyos_collect_facts", output }]), false);
  }
  assert.equal(hasSubmittedCollection([{ toolName: "other_tool", output: { collected: true, authorized: false } }]), false);
});
