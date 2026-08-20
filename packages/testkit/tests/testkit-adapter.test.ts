// The testkit adapter is runner no. 2 (DECISIONS #12) — if it degrades, every
// other test degrades with it. These tests keep the fakes honest and double as
// the usage example: this is how a module test drives the outside world.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BoardFake } from "../adapter/board-fake.ts";
import { ScriptedAdapter, TestClock, testContext } from "../adapter/index.ts";

test("the clock is fast-forwardable — 48h without waiting 48h", () => {
  const clock = new TestClock("2026-08-03T08:00:00.000Z");
  const start = clock.now();
  clock.advanceHours(48);
  assert.equal(clock.now().getTime() - start.getTime(), 48 * 3_600_000);
});

test("messages land in the outbox instead of Slack", async () => {
  const { transport } = testContext();
  await transport.post({ channelId: "CBOARD001" }, "movement: card moved");
  await transport.post({ channelId: "CBOARD001", threadId: "t1" }, "nudge 1");
  assert.deepEqual(transport.texts(), ["movement: card moved", "nudge 1"]);
  assert.equal(transport.inThread("t1").length, 1);
});

test("a posted message can be edited (approval cards get closed)", async () => {
  const { transport } = testContext();
  const posted = await transport.post({ channelId: "C1" }, "before");
  await transport.update(posted, "after");
  assert.deepEqual(transport.texts(), ["after"]);
});

test("approvals are recorded WITH their presentation, and never decided here", async () => {
  const { transport, approvals } = testContext();
  const posted = await approvals.present(
    { channelId: "CBOARD001", threadId: "t9" },
    {
      requestId: "req_1",
      headline: "Write status back to card 42",
      level: "R3",
      eligible: ["slack:TFIXTURE1:UFOUNDER1"],
      choices: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }],
      facts: { card: "42", outcome: "set" },
    },
  );
  const entry = transport.approvals()[0];
  assert.equal(entry.kind, "approval");
  assert.equal(entry.presentation?.level, "R3");
  assert.equal(entry.outcome, undefined, "presenting must not decide anything");

  await approvals.close(posted, "approved", "slack:TFIXTURE1:UFOUNDER1");
  assert.equal(transport.approvals()[0].outcome, "approved");
  assert.equal(transport.approvals()[0].closedBy, "slack:TFIXTURE1:UFOUNDER1");
});

test("mentions are surface-native, derived from the principal", () => {
  const { transport } = testContext();
  assert.equal(transport.mention("slack:TFIXTURE1:UFOUNDER1"), "<@UFOUNDER1>");
});

test("the scripted model answers deterministically and records what it saw", async () => {
  const { adapter } = testContext({ script: ["What is the desired outcome?", "Noted."] });
  const first = await adapter.converse({
    threadKey: "card-42",
    instructions: "one question per message",
    input: "card moved to doing",
  });
  assert.equal(first.text, "What is the desired outcome?");
  const second = await adapter.converse({
    threadKey: "card-42",
    instructions: "one question per message",
    input: "Ship the permit pack",
  });
  assert.equal(second.text, "Noted.");
  assert.equal(adapter.requests.length, 2);
  assert.equal(adapter.requests[1].input, "Ship the permit pack");
});

test("an unscripted turn fails loudly instead of inventing an answer", async () => {
  const adapter = new ScriptedAdapter([]);
  await assert.rejects(
    () => adapter.converse({ threadKey: "t", instructions: "", input: "hello" }),
    /no scripted answer left/,
  );
});

test("a matcher script can react to the input (branching dialogues)", async () => {
  const { adapter } = testContext({
    script: (request) => ({ text: request.input.includes("permit") ? "permit path" : "default path" }),
  });
  assert.equal((await adapter.converse({ threadKey: "t", instructions: "", input: "permit?" })).text, "permit path");
  assert.equal((await adapter.converse({ threadKey: "t", instructions: "", input: "other" })).text, "default path");
});

test("the board fake produces the events an engine consumes", () => {
  const clock = new TestClock();
  const board = new BoardFake(clock);
  board.seed({ itemId: "42", title: "Permit pack", group: "ready", fields: {} });
  const mark = clock.now();
  clock.advanceHours(1);
  board.move("42", "doing", "UFOUNDER1");
  clock.advanceHours(1);
  board.changeField("42", "outcome", "submitted", "ULEAD0001");

  const since = board.since(mark);
  assert.deepEqual(since.map((e) => e.type), ["item.moved", "field.changed"]);
  assert.equal(since[0].from, "ready");
  assert.equal(since[0].to, "doing");
  assert.equal(since[0].actor, "UFOUNDER1", "the causer is logged, never trusted");
  assert.equal(board.get("42")?.group, "doing");
});

test("engine-side writes are recorded separately from human changes", () => {
  const board = new BoardFake(new TestClock());
  board.seed({ itemId: "7", title: "Roof", group: "doing", fields: {} });
  board.writeField("7", "definition_of_done", "signed off by lead");
  board.writeComment("7", "brief complete");
  assert.equal(board.writes.length, 2);
  assert.equal(board.writes[0].field, "definition_of_done");
  assert.equal(board.writes[1].comment, "brief complete");
  // Writing a field is not a move: the engine never relocates cards.
  assert.equal(board.get("7")?.group, "doing");
  assert.equal(board.events.filter((e) => e.type === "item.moved").length, 0);
});
