import assert from "node:assert/strict";
import { test } from "node:test";
import { renderWorkflowDecisionNotice, workflowDecisionId } from "../../runtime/workflow-engine/decision-notice.ts";
import { jsonDigest } from "../../runtime/canonical.ts";
const base = { runId: "run", workflowId: "fictional", stepId: "review", role: "subject", expiresAt: "2030-01-08T10:00:00Z", destinationBinding: "fictional-direct", bound: { changes: {}, comment_body: "<p>A readable brief</p>", expected_version: "v1" } };

test("message-only review displays the complete readable proposal while keeping the same bound request identity", () => {
  const explanation = "Add this comment to the card?\n\n**Brief**\nA readable brief";
  const notice = renderWorkflowDecisionNotice({ ...base, presentation: { reviewFormat: "message", explanation, approve: "Save", reject: "Keep" } }) as any;
  assert.equal(notice.content, explanation);
  assert.doesNotMatch(notice.content, /comment_body|expected_version|<p>|Exact proposed|changes|Decision expires/);
  assert.equal(notice.decision.request_id, workflowDecisionId(base.runId, base.stepId, jsonDigest(base.bound)));
  const changed = renderWorkflowDecisionNotice({ ...base, bound: { ...base.bound, expected_version: "v2" }, presentation: { reviewFormat: "message", explanation, approve: "Save", reject: "Keep" } }) as any;
  assert.notEqual(changed.decision.request_id, notice.decision.request_id);
  assert.throws(() => renderWorkflowDecisionNotice({ ...base, presentation: { reviewFormat: "message", explanation: " ", approve: "Save", reject: "Keep" } }));
});

test("historical presentation still includes its exact payload for deterministic receipt verification", () => {
  const notice = renderWorkflowDecisionNotice({ ...base, presentation: { explanation: "Review", approve: "Save", reject: "Keep" } }) as any;
  assert.match(notice.content, /Exact proposed changes/); assert.match(notice.content, /expected_version/);
  assert.match((renderWorkflowDecisionNotice(base) as any).content, /Complete bound payload/);
});
