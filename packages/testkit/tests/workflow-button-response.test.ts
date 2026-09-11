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
        assert.match(text, decision === "approved" ? /"title":"Approved"/ : /rejection was saved/);
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

test("validated action shows localized processing before durable acceptance", async () => {
  const cards: string[] = [], phases: string[] = [];
  await recordWorkflowButtonResponse({
    decide: async (validated) => { await validated("de-DE"); assert.match(cards[0]!, /verarbeitet/); return { runId: "run", decision: "approved" }; },
    replace: async (card) => { cards.push(JSON.stringify(card)); },
    observe: (phase) => { phases.push(phase); },
  });
  assert.match(cards[1]!, /Freigegeben/);
  assert.deepEqual(phases, ["validated", "processing", "recorded", "resolved"]);
  assert.ok(cards.every((card) => !card.includes('"actions"')));
});
test("failed processing notice cannot veto the decision", async () => {
  let edits = 0;
  const result = await recordWorkflowButtonResponse({
    decide: async (validated) => { await validated(); return { runId: "run", decision: "rejected" }; },
    replace: async () => { if (++edits === 1) throw new Error("transport"); },
  });
  assert.equal(result.decision, "rejected"); assert.equal(edits, 2);
});
test("failed persistence replaces processing with uncertainty, never success", async () => {
  const cards: string[] = [];
  await assert.rejects(recordWorkflowButtonResponse({
    decide: async (validated) => { await validated(); throw new Error("storage unavailable"); },
    replace: async (card) => { cards.push(JSON.stringify(card)); },
  }), /storage unavailable/);
  assert.equal(cards.length, 2); assert.match(cards[1]!, /could not be confirmed/);
  assert.ok(cards.every((card) => !card.includes("decision recorded")));
});

test("presentation failure still advances, while continuation failure preserves acceptance", async () => {
  const calls: string[] = [];
  const result = await recordWorkflowButtonResponse({
    decide: async () => { calls.push("record"); return { runId: "run", decision: "approved" }; },
    replace: async () => { calls.push("replace"); throw new Error("display unavailable"); },
    continueRun: async (id) => { assert.equal(id, "run"); calls.push("continue"); throw new Error("worker unavailable"); },
  });
  assert.deepEqual(calls, ["record", "replace", "continue", "replace"]);
  assert.equal(result.decision, "approved"); assert.equal(result.presentation, "failed"); assert.equal(result.continuation, "failed");
});

for (const language of ["en", "de-DE"]) test(`approved feedback has no empty text element or long paragraph (${language})`, async () => {
  await recordWorkflowButtonResponse({ language,
    decide: async () => ({ runId: "run", decision: "approved" }),
    replace: async (card) => { assert.deepEqual(card.children, []); assert.equal(card.title, language === "en" ? "Approved" : "Freigegeben"); },
  });
});
test("continuation failure is visible while the recorded approval stays accepted", async () => {
  const cards: string[] = [];
  const result = await recordWorkflowButtonResponse({
    decide: async () => ({ runId: "run", decision: "approved" }),
    replace: async (card) => { cards.push(JSON.stringify(card)); },
    continueRun: async () => { throw new Error("private infrastructure details"); },
  });
  assert.equal(result.decision, "approved"); assert.equal(result.continuation, "failed");
  assert.match(cards.at(-1)!, /couldn't continue/);
  assert.doesNotMatch(cards.at(-1)!, /private infrastructure|saved the changes|button/);
});
test("a delivered continuation explanation clears an earlier presentation failure", async () => {
  let edits = 0;
  const result = await recordWorkflowButtonResponse({
    decide: async () => ({ runId: "run", decision: "approved" }),
    replace: async () => { if (++edits === 1) throw new Error("first edit failed"); },
    continueRun: async () => { throw new Error("worker unavailable"); },
  });
  assert.equal(result.presentation, "updated"); assert.equal(result.error, undefined);
  assert.equal(result.continuation, "failed"); assert.equal(result.decision, "approved");
});
