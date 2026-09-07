import assert from "node:assert/strict";
import test from "node:test";
import { retainSlackDecisionReview } from "../../runner-vercel/src/lib/slack-decision-review.ts";
import { recordWorkflowButtonResponse } from "../../runner-vercel/src/lib/workflow-button-response.ts";

const original = { message: { blocks: [
  { type: "header", text: { type: "plain_text", text: "Review this change" } },
  { type: "section", text: { type: "mrkdwn", text: "<https://example.test/item|Test card>\nObjective: Reduce duplicate work." } },
  { type: "section", text: { type: "mrkdwn", text: 'Exact proposal: {"impact":"Save 1–2 hours"}' } },
  { type: "actions", elements: [{ type: "button", value: "synthetic-request" }] },
] } };

for (const decision of ["approved", "rejected"] as const) {
  test(`${decision} keeps the complete original review throughout processing`, async () => {
    const before = structuredClone(original), cards: ReturnType<typeof retainSlackDecisionReview>[] = [];
    await recordWorkflowButtonResponse({
      decide: async (validated) => { await validated("en"); return { runId: "synthetic", decision }; },
      replace: async (feedback) => { cards.push(retainSlackDecisionReview(original, feedback)); },
    });
    assert.equal(cards.length, 2);
    for (const card of cards) {
      assert.equal(card.title, "Review this change");
      assert.deepEqual(card.children.slice(0, 2).map((child) => (child as { content: string }).content), original.message.blocks.slice(1, 3).map((block) => block.text!.text));
      assert.ok(!JSON.stringify(card).includes('"button"'));
    }
    assert.match(JSON.stringify(cards[1]), /decision recorded/);
    assert.deepEqual(original, before);
  });
}
test("uncertain persistence retains the same proposal without success", async () => {
  const cards: string[] = [];
  await assert.rejects(recordWorkflowButtonResponse({
    decide: async (validated) => { await validated(); throw new Error("storage failure"); },
    replace: async (feedback) => { cards.push(JSON.stringify(retainSlackDecisionReview(original, feedback))); },
  }), /storage failure/);
  assert.match(cards[1]!, /Save 1–2 hours/);
  assert.match(cards[1]!, /could not be confirmed/);
  assert.doesNotMatch(cards[1]!, /decision recorded/);
});
test("missing or unsupported review is never replaced with a partial receipt", () => {
  for (const raw of [{}, { message: { blocks: [{ type: "image" }] } }]) {
    assert.throws(() => retainSlackDecisionReview(raw, { type: "card", title: "Approved", children: [] }));
  }
});
