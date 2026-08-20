// The heart of the governance layer: one approval = exactly one effect, even
// under concurrent clicks. Runs against a real Postgres (Neon) because the
// guarantee IS the SQL — a mock would only prove the mock. Skipped when no
// DATABASE_URL is configured (CI without DB secrets still runs everything else).
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
