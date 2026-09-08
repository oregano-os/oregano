import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryStateStore } from "../adapter/in-memory-state.ts";
import { approvalExpiry, DEFAULT_APPROVAL_TTL_MS } from "../../state-store/approval-validity.ts";
import { executeApprovedAction } from "../../state-store/action-approval.ts";

async function stage(expiresAt?: Date) {
  const store = new InMemoryStateStore();
  const request = { runId: "run", stepId: "step", action: "send", inputHash: "exact-hash", ...(expiresAt ? { expiresAt } : {}) };
  const requestId = await store.createApprovalRequest(request);
  const approvalId = await store.recordDecision({ requestId, subjectPrincipal: "test:owner", role: "owner", decision: "approved" });
  const claim = { approvalId, runId: "run", stepId: "step", inputHash: "exact-hash", idempotencyKey: "exact-effect" };
  return { store, request, requestId, claim };
}

test("approval defaults are finite and explicit deadlines are copied and validated", async () => {
  const now = new Date("2026-09-05T12:00:00Z");
  assert.equal(approvalExpiry(undefined, now).getTime(), now.getTime() + DEFAULT_APPROVAL_TTL_MS);
  assert.throws(() => approvalExpiry(new Date(NaN)), /finite instant/);
  const expiresAt = new Date(Date.now() + 90_000);
  const original = expiresAt.getTime();
  const { store } = await stage(expiresAt);
  expiresAt.setTime(0);
  assert.equal((await store.getLatestApprovalRequest("run", "step", "send"))!.expiresAt!.getTime(), original);
});

for (const mismatch of ["runId", "stepId", "inputHash"] as const) {
  test(`unconsumed memory approval rejects different ${mismatch} without a partial claim`, async () => {
    const { store, claim } = await stage();
    assert.equal(await store.consumeApprovalAndClaimEffect({ ...claim, [mismatch]: "different" }), false);
    assert.equal(await store.getEffect(claim.idempotencyKey), undefined);
    assert.equal(await store.consumeApprovalAndClaimEffect(claim), true);
  });
}

for (const expiry of ["expired", "missing"] as const) {
  test(`memory store refuses ${expiry} expiry at consumption`, async () => {
    const { store, claim } = await stage(new Date(0));
    if (expiry === "missing") store.requests[0]!.expiresAt = undefined;
    assert.equal(await store.consumeApprovalAndClaimEffect(claim), false);
    assert.equal(await store.getEffect(claim.idempotencyKey), undefined);
    assert.equal(store.approvals.get(claim.approvalId)!.consumed, false);
  });
}

test("an expired new draft never reactivates an older unexpired approval", async () => {
  const { store, request, claim } = await stage();
  const latest = await store.createApprovalRequest({ ...request, inputHash: "new-hash", expiresAt: new Date(0) });
  assert.equal((await store.getLatestApprovalRequest("run", "step", "send"))!.requestId, latest);
  assert.equal(await store.consumeApprovalAndClaimEffect(claim), false);
  assert.equal(await store.getEffect(claim.idempotencyKey), undefined);
});

test("generic action path reports expiry without recording an approval or dispatching", async () => {
  const { store, request } = await stage(new Date(0));
  const before = store.approvals.size;
  let calls = 0;
  const result = await executeApprovedAction({
    store, roster: [{ id: "owner", name: "Fixture owner", role: "owner", status: "active", mayApprove: ["R3"], principals: ["test:owner"] }],
    ...request, level: "R3", principal: "test:owner", eventName: "test.sent", effect: async () => { calls++; return {}; },
  });
  assert.equal(result.ok, false);
  assert.match("reason" in result ? result.reason : "", /expired/);
  assert.equal(calls, 0);
  assert.equal(store.approvals.size, before);
  assert.ok(store.events.some((event) => event.event === "approval.expired"));
});

test("expiry between authorization and atomic claim requests fresh approval, not a duplicate success", async () => {
  const { store, request } = await stage();
  const consume = store.consumeApprovalAndClaimEffect.bind(store);
  store.consumeApprovalAndClaimEffect = async (claim) => {
    store.requests[0]!.expiresAt = new Date(0);
    return await consume(claim);
  };
  let calls = 0;
  const result = await executeApprovedAction({
    store, roster: [{ id: "owner", name: "Fixture owner", role: "owner", status: "active", mayApprove: ["R3"], principals: ["test:owner"] }],
    ...request, level: "R3", principal: "test:owner", eventName: "test.sent", effect: async () => { calls++; return {}; },
  });
  assert.equal(result.ok, false);
  assert.equal("duplicate" in result, false);
  assert.match("reason" in result ? result.reason : "", /no longer valid/);
  assert.equal(calls, 0);
  assert.equal(store.effects.size, 0);
});
