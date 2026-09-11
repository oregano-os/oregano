import test from "node:test";
import assert from "node:assert/strict";
import { ConversationParticipation, conversationContext } from "../../runtime/conversation-participation.ts";
import { participationCases, participationMessage } from "../adapter/conversation-participation.ts";

for (const scenario of participationCases) test(`participation contract: ${scenario.title}`, () => {
  const turn = new ConversationParticipation(participationMessage(scenario));
  assert.equal(turn.ambient, scenario.ambient);
  if (scenario.ambient) {
    assert.throws(() => turn.assertResponding());
    assert.deepEqual(turn.finish("Provisional text must never leak"), { participation: "context-only", reason: "no-visible-participation" });
  } else {
    turn.assertResponding();
    assert.equal(turn.finish("Answer").text, "Answer");
  }
  assert.throws(() => turn.finish("Duplicate"));
});

test("silence is terminal and cannot authorize work or a later visible reply", () => {
  const turn = new ConversationParticipation(participationMessage());
  turn.choose("context-only");
  assert.throws(() => turn.choose("respond"));
  assert.throws(() => turn.choose("context-only", "Acknowledged"));
  assert.throws(() => turn.assertResponding());
  assert.equal(turn.finish("NO_REPLY or any accidental model text").text, undefined);
});

test("a follow-up can answer in the same turn, without opening a second model pass", () => {
  const turn = new ConversationParticipation(participationMessage());
  turn.choose("respond", "Here is the explanation.");
  assert.equal(turn.complete, true);
  assert.throws(() => turn.assertResponding(), /Choose to respond/);
  assert.equal(turn.finish("Ignored continuation").text, "Here is the explanation.");
});

test("retained context preserves authors and age and cannot replace the current requester", () => {
  const message = participationMessage();
  const context = JSON.parse(conversationContext(message, [
    { role: "assistant", content: "Which wording do you want?", sent_at: "2026-09-09T10:00:00Z" },
    { role: "user", content: "Bob, let's discuss that tomorrow.", principal: "person:carol", sent_at: "2026-09-10T10:00:00Z" },
    { role: "user", content: "Duplicate", message_id: message.id },
  ]));
  assert.equal(context.currentMessage.senderId, "person:alice");
  assert.equal(context.previousMessages.length, 2);
  assert.equal(context.previousMessages[1].principal, "person:carol");
  assert.equal(context.previousMessages[0].sent_at, "2026-09-09T10:00:00Z");
  assert.match(context.note, /not renewed permission/);
  const bounded = JSON.parse(conversationContext(message, Array.from({ length: 100 }, () => ({ role: "user", content: "x".repeat(5000) }))));
  assert.equal(bounded.previousMessages.reduce((n: number, e: { content: string }) => n + e.content.length, 0), 12000);
});
