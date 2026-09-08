import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { neonConfig } from "@neondatabase/serverless";
import { createPostgresWorkflowExecutionStore } from "../../state-postgres/workflow-store.ts";
import { createPostgresStateStore } from "../../state-postgres/store.ts";
import { createPostgresDurableTimerStore } from "../../state-postgres/durable-timer-store.ts";
import { engineFixture, ENGINE_OPERATOR, ENGINE_OWNER } from "../workflow-engine-fixture.ts";
import { workflowDecisionId } from "../../runtime/workflow-engine/decision-notice.ts";
import { WorkflowRecordWorkers } from "../../runtime/workflow-engine/record-workers.ts";
import { sha256 } from "../../runtime/canonical.ts";
import { completedVerificationFixture } from "./workflow-verification-fixture.ts";
import { WorkflowReviewContextReader } from "../../runtime/workflow-engine/readers.ts";

const enabled = process.env.RUN_DATABASE_TESTS === "1";
if (process.env.COMPANYOS_REQUIRE_DATABASE_TESTS === "1" && (!enabled || !process.env.DATABASE_URL)) throw new Error("Required database configuration is missing.");
const fixture = () => engineFixture({ store: createPostgresWorkflowExecutionStore(), control: createPostgresStateStore(), timerStore: createPostgresDurableTimerStore() });

test("Postgres competing ordinary workers retain every step and one publication across store reconstruction", { skip: !enabled }, async () => {
  const h = fixture();
  const opened = await h.engine().openOperator({ workflowId: "monday-handoff", requestId: randomUUID(), principal: ENGINE_OPERATOR,
    fields: { period_start: "2030-01-07", period_end: "2030-01-11" } });
  await Promise.all(Array.from({ length: 4 }, () => h.engine().advance(opened.runId)));
  const run = (await h.engine().advance(opened.runId))!;
  assert.equal(run.state.status, "done");
  assert.deepEqual(Object.entries(run.state.steps).sort(([a], [b]) => a.localeCompare(b)).map(([id, step]) => [id, step.status]), [
    ["current-items", "succeeded"], ["directory", "succeeded"], ["handoff-view", "succeeded"],
    ["participant-roles", "succeeded"], ["participants", "succeeded"], ["post-handoff", "succeeded"],
  ]);
  assert.equal((run.state.steps["handoff-view"]!.output as any).unique_work_item_count, 1);
  const events = await h.control.listEvents(run.runId);
  assert.deepEqual(events.filter((event) => event.event === "workflow.step-completed").map((event) => event.step_id ?? event.stepId).sort(), Object.keys(run.state.steps).sort());
  assert.equal(events.filter((event) => event.event === "workflow.opened").length, 1);
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 1);
  const recovered = engineFixture({ artifact: h.artifact, store: createPostgresWorkflowExecutionStore(), control: createPostgresStateStore(), timerStore: createPostgresDurableTimerStore() });
  assert.deepEqual(await recovered.engine().advance(run.runId), run);
  assert.deepEqual(await recovered.control.listEvents(run.runId), events);
  assert.equal(recovered.calls.length, 0);
});

test("Postgres verification joins the consumed approval and preserves run, event and effect state", { skip: !enabled }, async () => {
  const { h, run } = await completedVerificationFixture({ store: createPostgresWorkflowExecutionStore(), control: createPostgresStateStore(), timerStore: createPostgresDurableTimerStore() });
  const events = await h.control.listEvents(run.runId), calls = h.calls.length;
  const proof = await h.engine().verify(run.runId, ENGINE_OPERATOR);
  assert.equal(proof.ok, true, JSON.stringify(proof.checks.filter((entry) => !entry.passed)));
  const effect = proof.receipts.find((receipt) => receipt.approvalId)!;
  const approval = await h.control.getEffectApproval(effect.effectKey);
  assert.equal(approval?.consumed, true);
  assert.equal(approval?.runId, run.runId);
  assert.equal(approval?.inputHash, effect.inputDigest);
  assert.equal(approval?.subjectPrincipal, ENGINE_OWNER);
  assert.deepEqual(await h.control.listEvents(run.runId), events);
  assert.equal((await h.store.read(h.artifact.instance.id, run.runId))?.revision, run.revision);
  assert.equal(h.calls.length, calls);
  assert.equal((await h.control.listEvents(run.runId, 1)).length, 1);
  await assert.rejects(h.control.listEvents(run.runId, 0), /read limit/);
  assert.equal(await h.control.getEffectApproval(`missing:${randomUUID()}`), undefined);
});

const stoppedForReview = async () => {
  const h = fixture();
  let run = await h.engine().openOperator({ workflowId: "friday-close", requestId: randomUUID(), principal: ENGINE_OPERATOR, fields: { sprint_id: "one", next_sprint_id: "two" } });
  await h.engine().advance(run.runId);
  for (const instant of ["2030-01-04T15:20:00.000Z", "2030-01-04T16:00:00.000Z"]) {
    h.now = instant; await h.engine().timers(); run = (await h.engine().advance(run.runId))!;
  }
  const decision = run.state.decisions["approve-rollover"]!;
  await h.engine().decide({ principal: ENGINE_OWNER, conversation: h.conversation("direct-jonas-owner", decision.deliveries["jonas-owner"]!), eventId: randomUUID(),
    requestId: workflowDecisionId(run.runId, decision.stepId, decision.boundDigest), decision: "approved" });
  h.unknownBatch = true; run = (await h.engine().advance(run.runId))!;
  assert.ok(run.state.blocked); run = (await h.engine().step(run.runId))!;
  assert.ok(run.state.reviewDelivery);
  return { h, run };
};

test("Postgres review publication survives worker loss after provider success without replay or business progress", { skip: !enabled }, async () => {
  const { h, run } = await stoppedForReview();
  const commit = h.store.commit.bind(h.store); let crash = true;
  h.store.commit = async (args) => { if (crash && args.event.name === "workflow.review-delivered") { crash = false; throw new Error("Synthetic lost worker after notice publication"); } return commit(args); };
  const count = h.calls.filter((call) => call.capability === "communication.message.publish").length;
  await assert.rejects(h.engine().step(run.runId), /Synthetic lost worker/);
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, count + 1);
  const recovered = engineFixture({ artifact: h.artifact, store: createPostgresWorkflowExecutionStore(), control: createPostgresStateStore(), timerStore: createPostgresDurableTimerStore() });
  recovered.now = h.now;
  const delivered = (await recovered.engine().step(run.runId))!;
  assert.equal(delivered.state.reviewDelivery!.outputs.length, 1);
  assert.equal(delivered.state.cursor, run.state.cursor); assert.deepEqual(delivered.state.blocked, run.state.blocked);
  assert.equal(recovered.calls.length, 0);
  await recovered.engine().step(run.runId); assert.equal(recovered.calls.length, 0);
  await assert.rejects(recovered.engine().resume(run.runId, ENGINE_OPERATOR), /reconciliation/);
});

test("Postgres review fences bind page payload and effect identity and cancellation prevents delivery", { skip: !enabled }, async () => {
  const { h, run } = await stoppedForReview();
  const lease = await h.store.claim({ instanceId: run.instanceId, runId: run.runId, owner: "test-review", token: randomUUID(), now: h.now, expiresAt: "2030-01-04T16:01:00.000Z" });
  const reader = new WorkflowReviewContextReader({ store: h.store, instanceId: run.instanceId, runId: run.runId, leaseToken: lease!.lease!.token, roster: async () => h.roster, clock: () => h.now });
  const context = await reader.read(), fence = context.dispatchFence!, page = fence.review!;
  const otherKey = randomUUID(), changedKey = randomUUID(), cancelledKey = randomUUID();
  await h.control.claimEffect({ idempotencyKey: otherKey, runId: run.runId, stepId: run.state.cursor!, inputHash: page.inputDigest });
  assert.equal(await h.control.markEffectDispatched(otherKey, fence), false);
  await h.control.claimEffect({ idempotencyKey: changedKey, runId: run.runId, stepId: page.executionStepId, inputHash: "a".repeat(64) });
  assert.equal(await h.control.markEffectDispatched(changedKey, fence), false);
  await h.control.claimEffect({ idempotencyKey: cancelledKey, runId: run.runId, stepId: page.executionStepId, inputHash: page.inputDigest });
  await h.engine().cancel(run.runId, ENGINE_OPERATOR);
  assert.equal(await h.control.markEffectDispatched(cancelledKey, fence), false);
  await assert.rejects(reader.read(), /lease/);
  await h.engine().step(run.runId);
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish" && call.input.content.startsWith("Workflow stopped:")).length, 0);
});

test("Postgres Records worker checks current historical execution eligibility and retains completed polls across restart", { skip: !enabled }, async () => {
  const h = fixture(); h.artifact.provenance.workspaceCommit = sha256(randomUUID()).slice(0, 40);
  const rehash = (value: typeof h.artifact) => {
    value.workflows = structuredClone(value.workflows);
    for (const workflow of value.workflows ?? []) {
      workflow.provenance.workspaceCommit = value.provenance.workspaceCommit;
      const { manifestHash: _, ...manifest } = workflow; workflow.manifestHash = sha256(manifest);
    }
    const { artifactHash: _, ...content } = value; value.artifactHash = sha256({ ...content, provenance: { ...content.provenance, builtAt: undefined } });
  };
  rehash(h.artifact);
  const run = await h.engine().openOperator({ workflowId: "friday-close", requestId: randomUUID(), principal: ENGINE_OPERATOR, fields: { sprint_id: "one", next_sprint_id: "two" } });
  await h.engine().advance(run.runId);
  const scope = { instanceId: h.artifact.instance.id, artifactHash: h.artifact.artifactHash, workflowIds: ["friday-close"] };
  assert.equal(await createPostgresWorkflowExecutionStore().hasActiveArtifact(scope), true);
  assert.equal(await h.store.hasActiveArtifact({ ...scope, workflowIds: [] }), false);
  assert.equal(await h.store.hasActiveArtifact({ ...scope, instanceId: "another-instance" }), false);
  const updated = structuredClone(h.artifact); updated.provenance.workspaceCommit = sha256(randomUUID()).slice(0, 40); rehash(updated);
  const reads: string[] = [];
  const worker = () => new WorkflowRecordWorkers({ artifact: updated, store: createPostgresWorkflowExecutionStore(), timers: h.timers, clock: () => h.now,
    enabledWorkflowIds: scope.workflowIds, recordSync: { intervalMinutes: 1, targets: [{ artifactHash: h.artifact.artifactHash, sourceIds: ["fixture-source"] }] },
    synchronizeSource: async (pinned) => { reads.push(pinned.artifactHash); return { synthetic: true }; } });
  assert.equal((await worker().run()).synchronized, 1); await worker().run(); assert.deepEqual(reads, [h.artifact.artifactHash]);
  await h.engine().cancel(run.runId, ENGINE_OPERATOR);
  assert.equal(await createPostgresWorkflowExecutionStore().hasActiveArtifact(scope), false);
  h.now = "2030-01-04T14:31:00.000Z";
  const stopped = await worker().run(); assert.equal(stopped.skipped, 1); assert.equal(stopped.synchronized, 0); assert.equal(reads.length, 1);
});

test("Postgres actual Engine runs Friday from entry through persisted waits, decision and atomic approval/effect", { skip: !enabled }, async () => {
  const h = fixture(), requestId = randomUUID();
  const args = { workflowId: "friday-close", principal: ENGINE_OPERATOR, requestId, fields: { sprint_id: "test-one", next_sprint_id: "test-two" } };
  let run = await h.engine().openOperator(args);
  assert.equal((await h.engine().openOperator({ ...args, fields: { next_sprint_id: "test-two", sprint_id: "test-one" } })).runId, run.runId);
  await assert.rejects(h.engine().openOperator({ ...args, fields: { ...args.fields, sprint_id: "changed" } }), /conflict/);
  run = (await h.engine().advance(run.runId))!; assert.equal(run.state.cursor, "await-chase", JSON.stringify(run.state));
  h.now = "2030-01-04T15:20:00.000Z"; await h.engine().timers(); run = (await h.engine().advance(run.runId))!;
  assert.equal(run.state.cursor, "await-report", JSON.stringify(run.state));
  h.now = "2030-01-04T16:00:00.000Z"; await h.engine().timers(); run = (await h.engine().advance(run.runId))!;
  assert.equal(run.state.cursor, "approve-rollover", JSON.stringify(run.state)); assert.equal(run.state.status, "waiting");
  const decision = run.state.decisions["approve-rollover"]!;
  const response = { principal: ENGINE_OWNER, conversation: h.conversation("direct-jonas-owner", decision.deliveries["jonas-owner"]!), eventId: randomUUID(), requestId: workflowDecisionId(run.runId, decision.stepId, decision.boundDigest), decision: "approved" as const };
  const attempts = await Promise.allSettled([h.engine().decide(response), h.engine().decide(response)]);
  assert.ok(attempts.some((attempt) => attempt.status === "fulfilled"));
  run = (await h.engine().advance(run.runId))!; assert.equal(run.state.status, "done", JSON.stringify(run.state));
  assert.deepEqual(await h.engine().decide(response), run);
  assert.equal(h.calls.filter((call) => call.capability === "work-item.batch-update").length, 1);
  assert.equal((await h.control.listEvents(run.runId)).filter((event) => event.event === "workflow.decision-approved").length, 1);
  const persisted = await createPostgresWorkflowExecutionStore().read(run.instanceId, run.runId);
  assert.deepEqual(persisted, JSON.parse(JSON.stringify(run)));
});

test("Postgres engine crash after successful publication recovers by lease expiry without provider deduplication", { skip: !enabled }, async () => {
  const h = fixture(); const run = await h.engine().openOperator({ workflowId: "monday-handoff", requestId: randomUUID(), principal: ENGINE_OPERATOR, fields: { period_start: "2030-01-07", period_end: "2030-01-11" } });
  const original = h.store.commit.bind(h.store); let crashed = false;
  h.store.commit = async (args) => {
    if (!crashed && args.event.name === "workflow.step-completed" && args.event.stepId === "post-handoff") { crashed = true; return undefined; }
    return original(args);
  };
  await h.engine().advance(run.runId); assert.ok(crashed);
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 1);
  h.now = "2030-01-04T14:36:00.000Z";
  const done = (await h.engine().advance(run.runId))!;
  assert.equal(done.state.status, "done", JSON.stringify(done.state));
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 1);
});

test("Postgres actual Engine cancellation wins before provider dispatch", { skip: !enabled }, async () => {
  const h = fixture(), run = await h.engine().openOperator({ workflowId: "monday-handoff", requestId: randomUUID(), principal: ENGINE_OPERATOR, fields: { period_start: "2030-01-07", period_end: "2030-01-11" } });
  const original = h.control.claimEffect.bind(h.control);
  h.control.claimEffect = async (...args) => { const claim = await original(...args); await h.engine().cancel(run.runId, ENGINE_OPERATOR); return claim; };
  const stopped = (await h.engine().advance(run.runId))!;
  assert.equal(stopped.state.status, "cancelled");
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 0);
});

test("Postgres keyed messages and business-day timers survive reconstructed workers without repeating recipients", { skip: !enabled }, async () => {
  const h = fixture(); h.now = "2030-01-08T09:00:00.000Z";
  h.items.push({ record_id: "item-2", values: { ...h.items[0]!.values, work_item_id: "item-2", assignee_ids: ["tim-contributor"] } });
  let run = await h.engine().openOperator({ workflowId: "board-hygiene", requestId: randomUUID(), principal: ENGINE_OPERATOR, fields: {} });
  for (let i = 0; i < 20; i++) {
    run = (await h.engine().step(run.runId))!; assert.equal(run.state.blocked, undefined, JSON.stringify(run.state));
    if (Object.keys(run.state.steps["nudge-owners"]?.items ?? {}).length === 1) break;
  }
  assert.equal(Object.keys(run.state.steps["nudge-owners"]!.items!).length, 1);
  run = (await h.engine().advance(run.runId))!; assert.equal(run.state.cursor, "grace", JSON.stringify(run.state));
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 2);
  h.now = run.state.wait!.dueAt;
  const [old] = await h.timers.claimDue({ timerKind: "workflow", now: h.now, owner: "test-expired", leaseToken: randomUUID(), leaseExpiresAt: "2030-01-10T09:01:00.000Z" });
  assert.ok(old); h.now = "2030-01-10T09:02:00.000Z"; assert.equal(await h.engine().wake(old), false);
  await h.engine().timers(); run = (await h.engine().advance(run.runId))!; assert.equal(run.state.cursor, "approve-move", JSON.stringify(run.state));
  await h.engine().cancel(run.runId, ENGINE_OPERATOR); h.now = "2030-01-20T09:00:00.000Z"; await h.engine().timers();
  assert.equal((await h.store.read(run.instanceId, run.runId))!.state.status, "cancelled");
  assert.equal(h.calls.filter((call) => call.capability === "work-item.batch-update").length, 0);
});

test("Postgres unknown batch evidence remains reviewable after reconstructing both stores and never authorizes retry", { skip: !enabled }, async () => {
  const h = fixture();
  let run = await h.engine().openOperator({ workflowId: "friday-close", requestId: randomUUID(), principal: ENGINE_OPERATOR, fields: { sprint_id: "one", next_sprint_id: "two" } });
  await h.engine().advance(run.runId);
  for (const instant of ["2030-01-04T15:20:00.000Z", "2030-01-04T16:00:00.000Z"]) {
    h.now = instant; await h.engine().timers(); run = (await h.engine().advance(run.runId))!;
    assert.equal(run.state.blocked, undefined);
  }
  const decision = run.state.decisions["approve-rollover"]!;
  await h.engine().decide({ principal: ENGINE_OWNER, conversation: h.conversation("direct-jonas-owner", decision.deliveries["jonas-owner"]!), eventId: randomUUID(),
    requestId: workflowDecisionId(run.runId, decision.stepId, decision.boundDigest), decision: "approved" });
  h.unknownBatch = true; run = (await h.engine().advance(run.runId))!; assert.ok(run.state.blocked);
  const report = await h.engine().review(run.runId, ENGINE_OPERATOR);
  const restarted = engineFixture({ artifact: h.artifact, store: createPostgresWorkflowExecutionStore(), control: createPostgresStateStore(), timerStore: createPostgresDurableTimerStore() });
  restarted.now = h.now;
  assert.deepEqual(await restarted.engine().review(run.runId, ENGINE_OPERATOR), report);
  assert.deepEqual(report.effect.capabilities[0]?.items, [{ item_id: "item-1", status: "unknown" }]);
  assert.equal(report.effect.retryAuthorized, false);
  await assert.rejects(restarted.engine().resume(run.runId, ENGINE_OPERATOR), /reconciliation/);
  await restarted.engine().advance(run.runId); assert.equal(restarted.calls.length, 0);
  assert.equal(h.calls.filter((call) => call.capability === "work-item.batch-update").length, 1);
});


test("Postgres deployment startup reads the exact immutable Artifact without schema preparation", { skip: !enabled }, async () => {
  const h = fixture();
  h.artifact.instance.environment = "production";
  const { artifactHash: _, ...content } = h.artifact;
  h.artifact.artifactHash = sha256({ ...content, provenance: { ...content.provenance, builtAt: undefined } });
  await h.store.putArtifact(h.artifact);
  const reader = createPostgresWorkflowExecutionStore({ prepareArtifactSchema: false });
  const originalFetch = neonConfig.fetchFunction, fetchSql = originalFetch ?? fetch;
  const previous = Object.fromEntries(["NEXT_RUNTIME", "VERCEL_ENV", "COMPANYOS_ARTIFACT_HASH"].map((key) => [key, process.env[key]]));
  let reads = 0;
  neonConfig.fetchFunction = async (url: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    assert.match(payload.query, /^select artifact_json from companyos\.workflow_artifacts /);
    reads++;
    return fetchSql(url, init);
  };
  try {
    assert.deepEqual(await reader.getArtifact(h.artifact.artifactHash), JSON.parse(JSON.stringify(h.artifact)));
    assert.equal(await reader.getArtifact(sha256(randomUUID())), undefined);
    const corrupt = structuredClone(h.artifact); corrupt.instance.id = "another-instance";
    await assert.rejects(reader.putArtifact(corrupt), /pinned hash/);
    Object.assign(process.env, { NEXT_RUNTIME: "nodejs", VERCEL_ENV: "production", COMPANYOS_ARTIFACT_HASH: h.artifact.artifactHash });
    const { register } = await import("../../runner-vercel/src/instrumentation.ts");
    const { loadArtifact } = await import("../../runner-vercel/src/lib/artifact.ts");
    assert.throws(loadArtifact, /verified startup/);
    await register();
    assert.deepEqual(loadArtifact(), JSON.parse(JSON.stringify(h.artifact)));
    await register();
    assert.equal(reads, 3, "only the first startup reads the exact retained Artifact");
  } finally {
    neonConfig.fetchFunction = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
