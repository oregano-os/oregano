import assert from "node:assert/strict";
import { test } from "node:test";
import { isWorkflowActionRequest } from "../../runner-vercel/src/lib/workflow-action-ingress.ts";
const request = (payload: unknown) => new Request("https://example.test/api/workflows/slack", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ payload: JSON.stringify(payload) }),
});
test("action-only ingress ignores ordinary messages and existing Tool controls", async () => {
  for (const payload of [null, { type: "event_callback", event: { type: "message" } }, { type: "block_actions", actions: [{ action_id: "companyos.approve" }] },
    { type: "block_actions", actions: [{ action_id: "companyos.workflow.approve" }, { action_id: "companyos.approve" }] }]) assert.equal(await isWorkflowActionRequest(request(payload)), false);
  assert.equal(await isWorkflowActionRequest(new Request("https://example.test", { method: "POST", body: "invalid" })), false);
});
test("action-only ingress preserves original bytes for the SDK signature verifier", async () => {
  for (const choice of ["approve", "reject"]) {
    const input = request({ type: "block_actions", actions: [{ action_id: `companyos.workflow.${choice}`, value: "a".repeat(64) }] });
    const expected = await input.clone().text();
    assert.equal(await isWorkflowActionRequest(input), true);
    assert.equal(await input.text(), expected);
  }
});
