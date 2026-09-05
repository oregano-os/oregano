import assert from "node:assert/strict";
import { test } from "node:test";
import { CapabilityEffectOutcomeUnknownError } from "../../capabilities/contracts.ts";
import { createSlackMessagePublisher } from "../../runner-vercel/src/lib/runtime-connectors.ts";

const sent = (id: string, threadId: string) => ({
  id,
  threadId,
  metadata: { dateSent: new Date("2030-01-01T10:00:00.000Z") },
});

test("Slack runtime publisher subscribes a new bot-authored root before returning its receipt", async () => {
  const calls: string[] = [];
  const publisher = createSlackMessagePublisher(() => ({
    channel(id: string) {
      calls.push(`channel:${id}`);
      return { async post(content: string) { calls.push(`post:${content}`); return sent("message-1", "slack:C123:root-1"); } } as any;
    },
    thread(id: string) {
      calls.push(`thread:${id}`);
      return {
        async subscribe() { calls.push("subscribe"); },
        async post(content: string) { calls.push(`reply:${content}`); return sent("message-2", id); },
      } as any;
    },
    async openDM() { throw new Error("not used"); },
  }));

  const receipt = await publisher.publishChannel("C123", "Friday sprint check");

  assert.deepEqual(calls, [
    "channel:slack:C123",
    "post:Friday sprint check",
    "thread:slack:C123:root-1",
    "subscribe",
  ]);
  assert.deepEqual(receipt, {
    messageId: "message-1",
    threadReference: "slack:C123:root-1",
    publishedAt: "2030-01-01T10:00:00.000Z",
  });
});

test("Slack runtime publisher replies only inside the supplied channel thread without resubscribing", async () => {
  const calls: string[] = [];
  const publisher = createSlackMessagePublisher(() => ({
    channel() { throw new Error("not used"); },
    thread(id: string) {
      calls.push(`thread:${id}`);
      return {
        async subscribe() { calls.push("subscribe"); },
        async post(content: string) { calls.push(`reply:${content}`); return sent("message-2", id); },
      } as any;
    },
    async openDM() { throw new Error("not used"); },
  }));

  await publisher.publishChannel("C123", "Report", "slack:C123:root-1");
  assert.deepEqual(calls, ["thread:slack:C123:root-1", "reply:Report"]);
  await assert.rejects(
    () => publisher.publishChannel("C999", "Report", "slack:C123:root-1"),
    /does not belong/,
  );
});

test("Slack runtime publisher preserves a partial receipt when root subscription cannot be verified", async () => {
  const publisher = createSlackMessagePublisher(() => ({
    channel() {
      return { async post() { return sent("message-unknown", "slack:C123:root-unknown"); } } as any;
    },
    thread() {
      return { async subscribe() { throw new Error("state adapter unavailable"); } } as any;
    },
    async openDM() { throw new Error("not used"); },
  }));

  await assert.rejects(
    () => publisher.publishChannel("C123", "Friday sprint check"),
    (error: unknown) => {
      assert.ok(error instanceof CapabilityEffectOutcomeUnknownError);
      assert.deepEqual((error.evidence as any).message_id, "message-unknown");
      assert.deepEqual((error.evidence as any).thread_reference, "slack:C123:root-unknown");
      assert.match((error.evidence as any).subscription_error_digest, /^[a-f0-9]{64}$/);
      return true;
    },
  );
});

test("each new direct publication binds its returned message timestamp and subscribes that exact reply thread", async () => {
  let count = 0; const subscriptions: string[] = [];
  const publisher = createSlackMessagePublisher(() => ({
    channel() { throw new Error("not used"); },
    thread(id: string) { return { async subscribe() { subscriptions.push(id); } } as any; },
    async openDM() { return { id: "slack:D12345:", async post() { return sent(`1893492000.00000${++count}`, "slack:D12345:"); } } as any; },
  }));
  const first = await (await publisher.openDirect("U12345")).publish("First approval");
  const second = await (await publisher.openDirect("U12345")).publish("Second approval");
  assert.equal(first.threadReference, "slack:D12345:1893492000.000001");
  assert.equal(second.threadReference, "slack:D12345:1893492000.000002");
  assert.deepEqual(subscriptions, [first.threadReference, second.threadReference]);
});

test("a direct-message subscription failure preserves the already published root receipt", async () => {
  const publisher = createSlackMessagePublisher(() => ({
    channel() { throw new Error("not used"); },
    thread() { return { async subscribe() { throw new Error("state unavailable"); } } as any; },
    async openDM() { return { id: "slack:D12345:", async post() { return sent("1893492000.000001", "slack:D12345:"); } } as any; },
  }));
  await assert.rejects((await publisher.openDirect("U12345")).publish("Approval"), (error: unknown) => {
    assert.ok(error instanceof CapabilityEffectOutcomeUnknownError);
    assert.equal((error.evidence as any).thread_reference, "slack:D12345:1893492000.000001"); return true;
  });
});
