import assert from "node:assert/strict";
import test from "node:test";
import { recordWorkflowButtonResponse } from "../../runner-vercel/src/lib/workflow-button-response.ts";

for (const decision of ["approved", "rejected"] as const) {
  test(`recorded ${decision} replaces controls without claiming executed effects`, async () => {
    const calls: string[] = [];
    const result = await recordWorkflowButtonResponse({
      decide: async () => { calls.push("persist"); return { runId: "synthetic-run", decision }; },
      replace: async (card) => {
        calls.push("replace");
        const text = JSON.stringify(card);
        assert.ok(!text.includes('"actions"') && !text.includes('"button"'));
        assert.match(text, decision === "approved" ? /not confirmation/ : /rejection was saved/);
      },
    });
    assert.deepEqual(calls, ["persist", "replace"]);
    assert.equal(result.presentation, "updated");
  });
}
test("refused or stale decisions never replace the original card", async () => {
  await assert.rejects(recordWorkflowButtonResponse({
    decide: async () => { throw new Error("unauthorized or stale"); },
    replace: async () => assert.fail("must not edit"),
  }), /unauthorized or stale/);
});
test("card delivery failure preserves the recorded result and can be retried", async () => {
  const recorded = { runId: "synthetic-run", decision: "rejected" as const };
  const failed = await recordWorkflowButtonResponse({ decide: async () => recorded, replace: async () => { throw new Error("transport"); } });
  assert.equal(failed.decision, "rejected");
  assert.equal(failed.presentation, "failed");
  const retry = await recordWorkflowButtonResponse({ decide: async () => recorded, replace: async () => undefined });
  assert.equal(retry.presentation, "updated");
});
