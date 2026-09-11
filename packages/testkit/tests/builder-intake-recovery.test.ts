import test from "node:test";
import assert from "node:assert/strict";
import { canStartBuilderDevelopment, parseBuilderTurnIntent, resolveBuilderTurnIntent, type BuilderIntakeInput } from "../../runtime/builder/turn-intent.ts";

const input: BuilderIntakeInput = { messageId: "confirmation", currentMessage: "Yes, equivalent questions too. Start the build now.", currentBuild: null,
  recentConversation: [{ role: "user", content: "Build a four-bullet capability answer." }, { role: "assistant", content: "Should equivalent questions also use this answer? No build has been submitted." }] };

test("technical failure remains distinguishable from a legitimate question and exposes no development", async () => {
  const unavailable = await resolveBuilderTurnIntent({ input, classify: async () => { throw new Error("provider unavailable"); } });
  assert.equal(unavailable.intent.kind, "unavailable"); assert.equal(unavailable.attempts, 2);
  assert.deepEqual(unavailable.failures, ["execution-failed", "execution-failed"]);
  assert.equal(canStartBuilderDevelopment(unavailable.intent, input.messageId), false);
  const question = await resolveBuilderTurnIntent({ input: { ...input, currentMessage: "Is this correct?" }, classify: async () => ({ kind: "question", requestQuote: "" }) });
  assert.equal(question.intent.kind, "question"); assert.equal(question.attempts, 1); assert.deepEqual(question.failures, []);
});

test("clarification context reaches the classifier and a transient failure recovers before admission", async () => {
  let attempts = 0;
  const result = await resolveBuilderTurnIntent({ input, classify: async seen => {
    assert.deepEqual(seen, input);
    if (++attempts === 1) throw new Error("temporary transport failure");
    return { kind: "new-build", requestQuote: "Start the build now." };
  } });
  assert.equal(canStartBuilderDevelopment(result.intent, input.messageId), true);
  assert.equal(canStartBuilderDevelopment(result.intent, "another-message"), false);
  assert.equal(result.attempts, 2);
});

test("invalid structured output and old permission never grant build authority", async () => {
  for (const value of [null, {}, { kind: "new-build", requestQuote: "Build a four-bullet capability answer." }, { kind: "unavailable" }]) {
    const result = await resolveBuilderTurnIntent({ input, classify: async () => value });
    assert.equal(result.intent.kind, "unavailable"); assert.equal(result.attempts, 2);
    assert.equal(canStartBuilderDevelopment(result.intent, input.messageId), false);
  }
  assert.equal(parseBuilderTurnIntent({ kind: "question" }, "now", "Is this screenshot correct?").kind, "question");
});

test("a stopped conversation is not retried or converted into a normal question", async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(resolveBuilderTurnIntent({ input, signal: controller.signal, classify: async () => {
    calls++; controller.abort(); throw new Error("aborted");
  } }), { name: "AbortError" });
  assert.equal(calls, 1);
});
