import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareConversationDelivery } from "../../runner-vercel/src/lib/conversation-delivery.ts";

function fixture() {
  const values = new Map<string, unknown>();
  const state: Parameters<typeof prepareConversationDelivery>[0]["state"] = {
    async get<T>(key: string) { return values.has(key) ? values.get(key) as T : null; },
    async set<T>(key: string, value: T) { values.set(key, value); },
    async setIfNotExists(key, value) { if (values.has(key)) return false; values.set(key, value); return true; },
    async delete(key) { values.delete(key); },
  };
  const args = { state, routeKey: "conversation-dispatch:fixture", eventId: "verified-event", now: "2030-01-04T12:00:00Z", ttlMs: 30 * 86400000 };
  const claimKey = `${args.routeKey}:delivery-claim`;
  return { values, state, args, claimKey };
}

for (const phase of ["evidence", "subscription"] as const) {
  test(`a failed ${phase} preparation releases its own claim so the same event can retry`, async () => {
    const f = fixture(), failure = new Error(`Transient ${phase} failure`);
    let attempts = 0, subscriptions = 0;
    const normalSet = f.state.set;
    f.state.set = async (key, value, ttl) => {
      if (phase === "evidence" && attempts++ === 0) throw failure;
      await normalSet(key, value, ttl);
    };
    const subscribe = async () => {
      subscriptions++;
      if (phase === "subscription" && attempts++ === 0) throw failure;
    };
    const args = { ...f.args, modelEvidence: { model: "fixture" }, subscribe };
    await assert.rejects(prepareConversationDelivery(args), error => error === failure);
    assert.equal(f.values.has(f.claimKey), false);
    assert.equal(subscriptions, phase === "evidence" ? 0 : 1);
    assert.equal(await prepareConversationDelivery(args), true);
    assert.deepEqual(f.values.get(`${f.args.routeKey}:model`), args.modelEvidence);
    assert.equal(f.values.has(f.claimKey), true);
  });
}

test("concurrent delivery attempts cannot release another attempt's claim", async () => {
  const f = fixture();
  let ready!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { ready = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const owner = prepareConversationDelivery({ ...f.args, subscribe: async () => { ready(); await blocked; } });
  await entered;
  const claim = f.values.get(f.claimKey);
  assert.equal(await prepareConversationDelivery({ ...f.args, subscribe: async () => { throw new Error("Duplicate attempted preparation"); } }), false);
  assert.equal(f.values.get(f.claimKey), claim);
  release();
  assert.equal(await owner, true);
});

test("a prepared delivery retains deduplication after an uncertain external effect", async () => {
  const f = fixture();
  let effects = 0;
  const deliver = async () => {
    if (!await prepareConversationDelivery({ ...f.args, subscribe: async () => {} })) return;
    effects++;
    throw new Error("Provider receipt unavailable after attempted delivery");
  };
  await assert.rejects(deliver(), /Provider receipt unavailable/);
  await deliver();
  assert.equal(effects, 1);
  assert.equal(f.values.has(f.claimKey), true);
});

test("completed delivery needs no new claim and failed cleanup preserves the preparation cause", async () => {
  const f = fixture();
  f.values.set(`${f.args.routeKey}:complete`, true);
  assert.equal(await prepareConversationDelivery({ ...f.args, subscribe: async () => { throw new Error("Already completed"); } }), false);
  assert.equal(f.values.has(f.claimKey), false);
  f.values.clear();
  const failure = new Error("Subscription unavailable"), cleanup = new Error("Claim cleanup unavailable");
  f.state.delete = async () => { throw cleanup; };
  await assert.rejects(prepareConversationDelivery({ ...f.args, subscribe: async () => { throw failure; } }), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, failure);
    assert.deepEqual(error.errors, [failure, cleanup]);
    return true;
  });
  assert.equal(f.values.has(f.claimKey), true);
});
