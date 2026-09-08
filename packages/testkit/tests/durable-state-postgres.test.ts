import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createPostgresDurableTimerStore } from "../../state-postgres/durable-timer-store.ts";
import { createPostgresStateStore } from "../../state-postgres/store.ts";

const enabled = process.env.RUN_DATABASE_TESTS === "1";
if (process.env.COMPANYOS_REQUIRE_DATABASE_TESTS === "1" && (!enabled || !process.env.DATABASE_URL)) throw new Error("Required database configuration is missing.");

test("Postgres timer identities survive JSONB order and competing lease owners", { skip: !enabled }, async () => {
  const store = createPostgresDurableTimerStore();
  const instanceId = randomUUID();
  const timer = { instanceId, timerId: "run-a:wait", timerKind: "fixture-wait", dueAt: "2030-01-04T16:00:00.000Z",
    idempotencyKey: "run-a:wait", payload: { z: { second: 2, first: 1 }, a: "value" } };
  assert.equal(await store.schedule(timer), true);
  const restarted = createPostgresDurableTimerStore();
  assert.equal(await restarted.schedule({ ...timer, payload: { a: "value", z: { first: 1, second: 2 } } }), false);
  await assert.rejects(restarted.schedule({ ...timer, payload: { a: "changed", z: { first: 1, second: 2 } } }), /conflicts/);
  assert.equal(await restarted.schedule({ ...timer, timerId: "run-b:wait", idempotencyKey: "run-b:wait" }), true);
  const claims = await Promise.all(["worker-a", "worker-b"].map((owner) => restarted.claimDue({ instanceId, owner,
    leaseToken: owner, now: timer.dueAt, leaseExpiresAt: "2030-01-04T16:05:00.000Z", limit: 2 })));
  const flattened = claims.flat();
  assert.equal(flattened.length, 2);
  assert.equal(new Set(flattened.map((claim) => claim.timerId)).size, 2);
  const reclaimed = await restarted.claimDue({ instanceId, owner: "restarted", leaseToken: "new-lease",
    now: "2030-01-04T16:06:00.000Z", leaseExpiresAt: "2030-01-04T16:10:00.000Z", limit: 2 });
  assert.equal(reclaimed.length, 2);
  const old = flattened[0];
  assert.equal(await restarted.complete({ instanceId, timerId: old.timerId, leaseToken: old.leaseToken, evidence: {}, completedAt: "2030-01-04T16:06:00.000Z" }), false);
  for (const claim of reclaimed) assert.equal(await restarted.complete({ instanceId, timerId: claim.timerId, leaseToken: claim.leaseToken,
    evidence: { resumed: true }, completedAt: "2030-01-04T16:06:00.000Z" }), true);
});

test("Postgres effects retain receipts across reconstruction and refuse redispatch after an unknown result", { skip: !enabled }, async () => {
  const store = createPostgresStateStore();
  const runId = randomUUID();
  await store.ensureRun({ runId, workflow: "fixture", workflowVersion: "1".repeat(40), companySnapshotHash: "fixture", agentDefinitionHash: "fixture", agentAdapter: "testkit" });
  const claim = { runId, stepId: "publish", idempotencyKey: `${runId}:publish`, inputHash: "digest" };
  assert.equal(await store.claimEffect(claim), true);
  assert.equal(await store.markEffectDispatched(claim.idempotencyKey), true);
  await store.completeEffect(claim.idempotencyKey, { message_id: "message-1", thread_reference: "thread-1" });
  const restarted = createPostgresStateStore();
  assert.equal(await restarted.claimEffect(claim), false);
  assert.equal(await restarted.markEffectDispatched(claim.idempotencyKey), false);
  assert.deepEqual((await restarted.getEffect(claim.idempotencyKey))?.evidence, { message_id: "message-1", thread_reference: "thread-1" });
  const unknown = { ...claim, stepId: "batch", idempotencyKey: `${runId}:batch` };
  assert.equal(await restarted.claimEffect(unknown), true);
  assert.equal(await restarted.markEffectDispatched(unknown.idempotencyKey), true);
  await restarted.markEffectUnknown(unknown.idempotencyKey, { reason: "connection-ended-after-dispatch" });
  assert.equal(await createPostgresStateStore().markEffectDispatched(unknown.idempotencyKey), false);
});
