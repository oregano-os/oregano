import assert from "node:assert/strict";
import { test } from "node:test";
import { collectionReviewDelivery, hasDeliveredCollectionReview } from "../../runner-vercel/src/lib/workflow-conversation-presentation.ts";
import type { WorkflowRun } from "../../state-store/workflow-engine.ts";

test("suppression requires the exact pending recipient receipt in the existing conversation", () => {
  const run = { state: { status: "waiting", cursor: "review", decisions: { review: { status: "pending", deliveries: { member: { message_id: "notice", thread_reference: "parent" } } } } } } as unknown as WorkflowRun;
  const receipt = collectionReviewDelivery(run, "member", "parent");
  assert.deepEqual(receipt, { messageId: "notice", threadReference: "parent" });
  assert.equal(collectionReviewDelivery(run, "other", "parent"), undefined);
  assert.equal(collectionReviewDelivery(run, "member", "another-parent"), undefined);
  for (const status of ["running", "done", "cancelled"] as const) assert.equal(collectionReviewDelivery({ ...run, state: { ...run.state, status } }, "member", "parent"), undefined);
  assert.equal(collectionReviewDelivery({ ...run, state: { ...run.state, blocked: { code: "step-failed", stepId: "review", errorDigest: "error" } } }, "member", "parent"), undefined);
  const output = { collected: true, authorized: false, reviewDelivery: receipt };
  assert.equal(hasDeliveredCollectionReview([{ toolName: "companyos_collect_facts", output }]), true);
  assert.equal(hasDeliveredCollectionReview([{ toolName: "other", output }]), false);
  assert.equal(hasDeliveredCollectionReview([{ toolName: "companyos_collect_facts", output: { ...output, reviewDelivery: undefined } }]), false);
  assert.equal(hasDeliveredCollectionReview([{ toolName: "companyos_collect_facts", output: { collected: true, message: "Review sent" } }]), false);
});
