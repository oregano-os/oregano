// The heart of the governance layer: one approval = exactly one effect, even
// under concurrent clicks. Runs against a real Postgres (Neon) because the
// guarantee IS the SQL — a mock would only prove the mock. The mandatory
// test:database gate supplies an isolated Postgres through the Neon HTTP driver.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createPostgresStateStore } from "../../state-postgres/store.ts";

function databaseUrl(): string | undefined {
  if (process.env.COMPANYOS_SKIP_DATABASE_TESTS === "1") return undefined;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envFile = join(import.meta.dirname, "..", "..", "..", ".env.local");
  if (!existsSync(envFile)) return undefined;
  return readFileSync(envFile, "utf8").match(/^DATABASE_URL="?([^"\n]+)"?$/m)?.[1];
}

const url = databaseUrl();
if (process.env.COMPANYOS_REQUIRE_DATABASE_TESTS === "1" && !url) throw new Error("Required approval database configuration is missing.");
const skip = url ? false : "no database configured or explicitly disabled";
if (url) process.env.DATABASE_URL = url;

const store = url ? createPostgresStateStore() : null;
const TEAM = "TFIXTURE1";
const APPROVER = "UFOUNDER1";
const principal = `slack:${TEAM}:${APPROVER}`;

/** Fresh run + request + granted approval for one test case. */
async function stage(caseId: string) {
  const runId = `test_${caseId}_${Date.now()}`;
  await store!.ensureRun({
    runId,
    workflow: "fixture-atomicity",
    workflowVersion: "0".repeat(40),
    companyCommit: "1".repeat(40),
    companySnapshotHash: "test-snapshot",
    agentDefinitionHash: "test-agent",
    agentAdapter: "testkit",
  });
  const inputHash = `hash_${caseId}`;
  const requestId = await store!.createApprovalRequest({
    runId,
    stepId: "step-1",
    action: "fixture_send",
    inputHash,
  });
  const approvalId = await store!.recordDecision({
    requestId,
    subjectPrincipal: principal,
    role: "founder",
    decision: "approved",
  });
  return { runId, inputHash, requestId, approvalId, key: `fixture_send:${runId}:${inputHash}` };
}

test("a granted approval can be consumed exactly once", { skip }, async () => {
  const s = await stage("once");
  const first = await store!.consumeApprovalAndClaimEffect({
    approvalId: s.approvalId,
    idempotencyKey: s.key,
    runId: s.runId,
    stepId: "step-1",
    inputHash: s.inputHash,
  });
  assert.equal(first, true, "the first consumption must succeed");

  const second = await store!.consumeApprovalAndClaimEffect({
    approvalId: s.approvalId,
    idempotencyKey: s.key,
    runId: s.runId,
    stepId: "step-1",
    inputHash: s.inputHash,
  });
  assert.equal(second, false, "a second consumption must be refused");
});

test("CONCURRENT clicks produce exactly one effect (double-click test)", { skip }, async () => {
  const s = await stage("race");
  // Fire both at once — this is the real double-click, not two sequential calls.
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      store!.consumeApprovalAndClaimEffect({
        approvalId: s.approvalId,
        idempotencyKey: s.key,
        runId: s.runId,
        stepId: "step-1",
        inputHash: s.inputHash,
      }),
    ),
  );
  const winners = results.filter(Boolean).length;
  assert.equal(winners, 1, `exactly one click may win, got ${winners}`);
});

test("consumption and effect claim commit TOGETHER (no half state)", { skip }, async () => {
  const s = await stage("together");
  await store!.consumeApprovalAndClaimEffect({
    approvalId: s.approvalId,
    idempotencyKey: s.key,
    runId: s.runId,
    stepId: "step-1",
    inputHash: s.inputHash,
  });
  const effect = await store!.getEffect(s.key);
  assert.ok(effect, "the effect row must exist after a successful claim");
  assert.equal(effect?.status, "claimed");
});

test("a DIFFERENT input hash cannot reuse the same approval", { skip }, async () => {
  const s = await stage("hash");
  await store!.consumeApprovalAndClaimEffect({
    approvalId: s.approvalId,
    idempotencyKey: s.key,
    runId: s.runId,
    stepId: "step-1",
    inputHash: s.inputHash,
  });
  // Same approval, different content → different idempotency key. The approval
  // is already consumed, so this must fail: one signature, one payload.
  const reused = await store!.consumeApprovalAndClaimEffect({
    approvalId: s.approvalId,
    idempotencyKey: `fixture_send:${s.runId}:tampered`,
    runId: s.runId,
    stepId: "step-1",
    inputHash: "tampered",
  });
  assert.equal(reused, false, "a consumed approval must not cover other content");
});

test("the effect state machine reaches succeeded with evidence", { skip }, async () => {
  const s = await stage("evidence");
  await store!.consumeApprovalAndClaimEffect({
    approvalId: s.approvalId,
    idempotencyKey: s.key,
    runId: s.runId,
    stepId: "step-1",
    inputHash: s.inputHash,
  });
  assert.equal(await store!.markEffectDispatched(s.key), true);
  await store!.completeEffect(s.key, { provider_id: "fixture-123" });
  const effect = await store!.getEffect(s.key);
  assert.equal(effect?.status, "succeeded");
  assert.deepEqual(effect?.evidence, { provider_id: "fixture-123" });
});

test("dispatching twice is refused (no silent re-send)", { skip }, async () => {
  const s = await stage("dispatch");
  await store!.consumeApprovalAndClaimEffect({
    approvalId: s.approvalId,
    idempotencyKey: s.key,
    runId: s.runId,
    stepId: "step-1",
    inputHash: s.inputHash,
  });
  assert.equal(await store!.markEffectDispatched(s.key), true);
  assert.equal(await store!.markEffectDispatched(s.key), false);
});

test("events are append-only and carry the deciding principal", { skip }, async () => {
  const s = await stage("events");
  await store!.appendEvent({
    runId: s.runId,
    stepId: "step-1",
    actor: "human:founder",
    subjectPrincipal: principal,
    event: "approval.granted",
    status: "succeeded",
  });
  // listEvents returns raw DB rows (snake_case) — the append-only log is read
  // by humans and forensics, not mapped through a domain type.
  const events = await store!.listEvents(s.runId);
  assert.equal(events.length, 1);
  assert.equal(events[0].subject_principal, principal);
  assert.equal(events[0].event, "approval.granted");
  assert.equal(events[0].actor, "human:founder");
});

for (const mismatch of ["runId", "stepId", "inputHash"] as const) {
  test(`unconsumed Postgres approval rejects different ${mismatch} without a partial claim`, { skip }, async () => {
    const s = await stage(`unconsumed_${mismatch}`);
    const claim = { approvalId: s.approvalId, idempotencyKey: s.key, runId: s.runId, stepId: "step-1", inputHash: s.inputHash };
    assert.equal(await store!.consumeApprovalAndClaimEffect({ ...claim, [mismatch]: "different" }), false);
    assert.equal(await store!.getEffect(s.key), undefined);
    assert.equal(await store!.consumeApprovalAndClaimEffect(claim), true);
  });
}

test("Postgres refuses rejected decisions before claiming any effect", { skip }, async () => {
  const s = await stage("rejected_decision");
  const approvalId = await store!.recordDecision({ requestId: s.requestId, subjectPrincipal: principal, role: "founder", decision: "rejected" });
  assert.equal(await store!.consumeApprovalAndClaimEffect({ approvalId, idempotencyKey: s.key, runId: s.runId, stepId: "step-1", inputHash: s.inputHash }), false);
  assert.equal(await store!.getEffect(s.key), undefined);
});

for (const expiry of ["expired", "missing"] as const) {
  test(`Postgres refuses ${expiry} expiry at atomic consumption`, { skip }, async () => {
    const s = await stage(`expiry_${expiry}`);
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(url!);
    // Preserve a historical request, then exercise the actual atomic boundary.
    await sql`update companyos.approval_requests set expires_at = ${expiry === "expired" ? new Date(0) : null} where request_id = ${s.requestId}`;
    assert.equal(await store!.consumeApprovalAndClaimEffect({ approvalId: s.approvalId, idempotencyKey: s.key, runId: s.runId, stepId: "step-1", inputHash: s.inputHash }), false);
    assert.equal(await store!.getEffect(s.key), undefined);
    const rows = await sql`select consumed_at from companyos.approvals where approval_id = ${s.approvalId}`;
    assert.equal(rows[0]!.consumed_at, null);
  });
}

test("Postgres latest expired draft cannot reactivate an older unexpired request", { skip }, async () => {
  const s = await stage("latest_expired");
  const latest = await store!.createApprovalRequest({ runId: s.runId, stepId: "step-1", action: "fixture_send", inputHash: "new-hash", expiresAt: new Date(0) });
  assert.equal((await store!.getLatestApprovalRequest(s.runId, "step-1", "fixture_send"))!.requestId, latest);
  assert.equal(await store!.consumeApprovalAndClaimEffect({ approvalId: s.approvalId, idempotencyKey: s.key, runId: s.runId, stepId: "step-1", inputHash: s.inputHash }), false);
  assert.equal(await store!.getEffect(s.key), undefined);
});

test("equally timestamped Postgres drafts are ambiguous and cannot authorize effects", { skip }, async () => {
  const s = await stage("equal_creation_time");
  const second = await store!.createApprovalRequest({ runId: s.runId, stepId: "step-1", action: "fixture_send", inputHash: "different" });
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url!);
  await sql`update companyos.approval_requests set created_at = (select created_at from companyos.approval_requests where request_id = ${s.requestId}) where request_id = ${second}`;
  assert.equal(await store!.getLatestApprovalRequest(s.runId, "step-1", "fixture_send"), undefined);
  assert.equal(await store!.consumeApprovalAndClaimEffect({ approvalId: s.approvalId, idempotencyKey: s.key, runId: s.runId, stepId: "step-1", inputHash: s.inputHash }), false);
});

for (const separate of [false, true]) {
  test(`Postgres-backed R4 action ${separate ? "accepts distinct humans" : "rejects the recorded requester"}`, { skip }, async () => {
    const { executeApprovedAction } = await import("../../state-store/action-approval.ts");
    const s = await stage(`r4_separate_${separate}`);
    const requesterPrincipal = separate ? "test:requester" : principal;
    await store!.appendEvent({
      runId: s.runId, stepId: "step-1", actor: "human:owner", subjectPrincipal: requesterPrincipal,
      event: "approval.requested", status: "succeeded",
      payload: { request_id: s.requestId, action: "fixture_send", input_hash: s.inputHash, risk: "R4", requester_member_id: separate ? "requester" : "approver" },
    });
    let calls = 0;
    const result = await executeApprovedAction({
      store: store!, roster: [
        { id: "requester", name: "Requester", role: "owner", status: "active", principals: ["test:requester"], mayApprove: [] },
        { id: "approver", name: "Approver", role: "owner", status: "active", principals: [principal], mayApprove: ["R4"] },
      ], runId: s.runId, stepId: "step-1", action: "fixture_send", inputHash: s.inputHash, principal, level: "R4", eventName: "fixture.sent",
      effect: async () => { calls++; return { receipt: "test-only" }; },
    });
    assert.equal(result.ok, separate);
    assert.equal(calls, separate ? 1 : 0);
    assert.equal((await store!.getEffect(s.key))?.status, separate ? "succeeded" : undefined);
  });
}
