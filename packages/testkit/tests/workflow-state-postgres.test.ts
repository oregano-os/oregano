import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { neon } from "@neondatabase/serverless";
import { createPostgresWorkflowExecutionStore } from "../../state-postgres/workflow-store.ts";
import { createPostgresStateStore } from "../../state-postgres/store.ts";
import { workflowAssignmentKey, workflowPublicationKey, workflowOriginDigest } from "../../runtime/workflow-engine/state-validation.ts";
import { sha256 } from "../../runtime/canonical.ts";
import { CompanyOSRuntime } from "../../runtime/companyos-runtime.ts";
import type { WorkflowInvocationContext } from "../../runtime/workflow-engine/context.ts";
import { workflowToolInput } from "../../runtime/workflow-engine/guard.ts";
import { workflowStateFixture, WORKFLOW_STATE_NOW as now } from "../workflow-state-fixture.ts";
import { createPostgresDurableTimerStore } from "../../state-postgres/durable-timer-store.ts";

const enabled = process.env.RUN_DATABASE_TESTS === "1";
if (process.env.COMPANYOS_REQUIRE_DATABASE_TESTS === "1" && (!enabled || !process.env.DATABASE_URL)) throw new Error("Required database configuration is missing.");
const fixture = async () => {
  const args = workflowStateFixture(), store = createPostgresWorkflowExecutionStore(), control = createPostgresStateStore();
  await store.putArtifact(args.artifact); const run = await store.create(args);
  return { args, store, control, run };
};
const lease = (run: { instanceId: string; runId: string }, token = randomUUID()) => ({ instanceId: run.instanceId, runId: run.runId, owner: "test-worker", token, now, expiresAt: "2030-01-04T12:05:00.000Z" });

test("Postgres publication context survives restart and cancellation without becoming an active assignment", { skip: !enabled }, async () => {
  const { store, run } = await fixture(), claimed = (await store.claim(lease(run)))!;
  const conversation = { surface: "mail", accountId: "example.test", channelId: `room-${randomUUID()}`, threadId: "<report@example.test>", subjectPrincipal: "mail:example.test:owner" };
  const content = "Delivery finished. One dependency remains.", format = "plain-text" as const;
  const publication = { messageId: "<outgoing@example.test>", content, format, publishedAt: now, sequence: 1, contentDigest: sha256({ content, format }) };
  const assignment = { ...conversation, publication, instanceId: run.instanceId, assignmentKey: workflowPublicationKey(run.instanceId, conversation, publication.messageId),
    runId: run.runId, stepId: "open-close-thread", artifactHash: run.artifactHash, expiresAt: "2030-01-05T12:00:00.000Z" };
  const commit = { instanceId: run.instanceId, runId: run.runId, expectedRevision: 0, leaseToken: claimed.lease!.token, now, state: run.state,
    event: { name: "workflow.publication", stepId: assignment.stepId }, assignments: [assignment] };
  assert.ok(await store.commit(commit)); assert.equal(await store.commit(commit), undefined);
  const restarted = createPostgresWorkflowExecutionStore();
  assert.deepEqual(await restarted.publishedAssignments({ instanceId: run.instanceId, conversation, now }), [assignment]);
  assert.equal(await restarted.deliveredAssignment({ instanceId: run.instanceId, conversation }), undefined);
  assert.deepEqual(await restarted.channelAssignments({ instanceId: run.instanceId, ...conversation, now }), []);
  for (const change of [{ surface: "other" }, { accountId: "other" }, { channelId: "other" }, { threadId: "other" }, { subjectPrincipal: "mail:example.test:other" }])
    assert.deepEqual(await restarted.publishedAssignments({ instanceId: run.instanceId, conversation: { ...conversation, ...change }, now }), []);
  assert.deepEqual(await restarted.publishedAssignments({ instanceId: "other", conversation, now }), []);
  assert.deepEqual(await restarted.publishedAssignments({ instanceId: run.instanceId, conversation, now: "2030-01-06T12:00:00.000Z" }), []);
  const next = (await store.claim(lease(run)))!;
  const changedContent = "Changed after publication.";
  await assert.rejects(store.commit({ ...commit, expectedRevision: next.revision, leaseToken: next.lease!.token,
    assignments: [{ ...assignment, publication: { ...publication, content: changedContent, contentDigest: sha256({ content: changedContent, format }) } }] }));
  assert.equal((await restarted.read(run.instanceId, run.runId))!.revision, 1);
  assert.ok(await store.cancel({ instanceId: run.instanceId, runId: run.runId, principal: run.subjectPrincipal, now }));
  assert.deepEqual(await restarted.publishedAssignments({ instanceId: run.instanceId, conversation, now }), [assignment]);
  assert.equal(await restarted.assignment({ instanceId: run.instanceId, conversation, now }), undefined);
});

test("candidate execution namespaces isolate workflow state, dispatch fences and timers from production workers", { skip: !enabled }, async () => {
  const args = workflowStateFixture(), executionNamespace = `builder-test-${sha256(randomUUID()).slice(0, 40)}`;
  const store = createPostgresWorkflowExecutionStore({ executionNamespace }), production = createPostgresWorkflowExecutionStore();
  const control = createPostgresStateStore({ executionNamespace });
  await store.putArtifact(args.artifact);
  const run = await store.create(args);
  assert.equal(run.instanceId, args.artifact.instance.id, "the Artifact identity must stay unchanged");
  assert.equal(await production.read(run.instanceId, run.runId), undefined);
  assert.equal((await production.list({ instanceId: run.instanceId, limit: 200 })).some((entry) => entry.runId === run.runId), false);
  const claimed = (await store.claim(lease(run)))!;
  const effect = { runId: run.runId, stepId: run.state.cursor!, idempotencyKey: `${run.runId}:namespace-effect`, inputHash: "input" };
  await control.claimEffect(effect);
  const fence = { instanceId: run.instanceId, runId: run.runId, stepId: run.state.cursor!, leaseToken: claimed.lease!.token, now };
  assert.equal(await createPostgresStateStore().markEffectDispatched(effect.idempotencyKey, fence), false);
  assert.equal(await control.markEffectDispatched(effect.idempotencyKey, fence), true);
  const timers = createPostgresDurableTimerStore({ executionNamespace }), timer = { instanceId: run.instanceId, timerId: randomUUID(), timerKind: "builder-test", dueAt: now, idempotencyKey: randomUUID(), payload: {} };
  await timers.schedule(timer);
  assert.equal((await createPostgresDurableTimerStore().list({ instanceId: run.instanceId })).some((entry) => entry.timerId === timer.timerId), false);
  const due = await timers.claimDue({ instanceId: run.instanceId, now, owner: "test-worker", leaseToken: randomUUID(), leaseExpiresAt: "2030-01-04T12:10:00.000Z", limit: 10 });
  assert.equal(due.length, 1); assert.equal(due[0]!.instanceId, run.instanceId);
  assert.equal(await timers.complete({ instanceId: run.instanceId, timerId: timer.timerId, leaseToken: due[0]!.leaseToken, completedAt: now, evidence: { synthetic: true } }), true);
  assert.equal((await createPostgresWorkflowExecutionStore({ executionNamespace }).read(run.instanceId, run.runId))?.lease?.token, claimed.lease!.token);
});

test("candidate conversation lookups retain their namespace across restart and cannot read production or another candidate", { skip: !enabled }, async () => {
  const executionNamespace = `builder-test-${sha256(randomUUID()).slice(0, 40)}`;
  const candidate = createPostgresWorkflowExecutionStore({ executionNamespace });
  const production = createPostgresWorkflowExecutionStore();
  const otherCandidate = createPostgresWorkflowExecutionStore({ executionNamespace: `builder-test-${sha256(randomUUID()).slice(0, 40)}` });
  const conversation = { surface: "mail", accountId: "example.test", channelId: `room-${randomUUID()}`,
    threadId: "<shared@example.test>", subjectPrincipal: "mail:example.test:owner" };
  const publish = async (store: ReturnType<typeof createPostgresWorkflowExecutionStore>, content: string) => {
    const args = workflowStateFixture();
    await store.putArtifact(args.artifact);
    const run = await store.create(args), claimed = (await store.claim(lease(run)))!;
    const assignment = { ...conversation, instanceId: run.instanceId, assignmentKey: workflowAssignmentKey(run.instanceId, conversation),
      runId: run.runId, stepId: "open-close-thread", artifactHash: run.artifactHash, expiresAt: "2030-01-05T12:00:00.000Z" };
    const format = "plain-text" as const;
    const publication = { messageId: "<notice@example.test>", content, format, publishedAt: now, sequence: 1, contentDigest: sha256({ content, format }) };
    const published = { ...assignment, assignmentKey: workflowPublicationKey(run.instanceId, conversation, publication.messageId), publication };
    assert.ok(await store.commit({ instanceId: run.instanceId, runId: run.runId, expectedRevision: 0, leaseToken: claimed.lease!.token, now,
      state: run.state, event: { name: "workflow.publication", stepId: assignment.stepId }, assignments: [assignment, published] }));
    return { run, assignment, published };
  };
  const expectedCandidate = await publish(candidate, "Candidate-only publication.");
  const channel = { instanceId: expectedCandidate.run.instanceId, ...conversation, now };
  const publicationQuery = { instanceId: expectedCandidate.run.instanceId, conversation, now };
  assert.deepEqual(await production.channelAssignments(channel), []);
  assert.deepEqual(await production.publishedAssignments(publicationQuery), []);
  const expectedProduction = await publish(production, "Production-only publication.");
  const restarted = createPostgresWorkflowExecutionStore({ executionNamespace });
  assert.deepEqual(await restarted.channelAssignments(channel), [expectedCandidate.assignment]);
  assert.deepEqual(await restarted.publishedAssignments(publicationQuery), [expectedCandidate.published]);
  assert.deepEqual(await production.channelAssignments(channel), [expectedProduction.assignment]);
  assert.deepEqual(await production.publishedAssignments(publicationQuery), [expectedProduction.published]);
  assert.deepEqual(await otherCandidate.channelAssignments(channel), []);
  assert.deepEqual(await otherCandidate.publishedAssignments(publicationQuery), []);
  assert.ok(await restarted.cancel({ instanceId: expectedCandidate.run.instanceId, runId: expectedCandidate.run.runId, principal: conversation.subjectPrincipal, now }));
  assert.deepEqual(await restarted.channelAssignments(channel), []);
  assert.deepEqual(await restarted.publishedAssignments(publicationQuery), [expectedCandidate.published]);
  assert.deepEqual(await production.channelAssignments(channel), [expectedProduction.assignment]);
});

test("Postgres workflow create is atomic and redelivery survives JSONB reordering and store reconstruction", { skip: !enabled }, async () => {
  const { args, store, control, run } = await fixture();
  const restart = createPostgresWorkflowExecutionStore();
  const reordered = { ...args, identity: { ...args.identity, fields: Object.fromEntries(Object.entries(args.identity.fields).reverse()) } };
  assert.deepEqual(await restart.create(reordered), run);
  assert.deepEqual(await restart.getArtifact(run.artifactHash), JSON.parse(JSON.stringify(args.artifact)));
  args.identity.fields.sprint_id = "changed"; args.identity.originDigest = workflowOriginDigest(args.identity);
  await assert.rejects(restart.create(args), /conflicts/);
  assert.equal((await store.read(run.instanceId, run.runId))!.fields.sprint_id, "period-1");
  assert.equal((await control.listEvents(run.runId)).filter((event) => event.event === "workflow.opened").length, 1);
  assert.equal((await control.getRun(run.runId))!.workflow, "friday-close");
  assert.equal(await restart.read("other-instance", run.runId), undefined);
});

test("Postgres workflow leases choose one winner and stale owners cannot overwrite resumed state", { skip: !enabled }, async () => {
  const { store, run } = await fixture();
  const leases = [lease(run), lease(run)];
  const claims = await Promise.all(leases.map((args) => store.claim(args)));
  assert.equal(claims.filter(Boolean).length, 1);
  const old = claims.find(Boolean)!;
  const next = { ...lease(run), now: "2030-01-04T12:06:00.000Z", expiresAt: "2030-01-04T12:10:00.000Z" };
  assert.ok(await createPostgresWorkflowExecutionStore().claim(next));
  const commit = { instanceId: run.instanceId, runId: run.runId, expectedRevision: 0, leaseToken: old.lease!.token, now: next.now, state: run.state, event: { name: "workflow.test", stepId: run.state.cursor! } };
  assert.equal(await store.commit(commit), undefined);
  assert.equal((await store.commit({ ...commit, leaseToken: next.token }))!.revision, 1);
  assert.equal(await store.commit({ ...commit, leaseToken: next.token }), undefined);
});

test("Postgres assignment conflict rolls back state and event together; private identity and cancellation are enforced", { skip: !enabled }, async () => {
  const first = await fixture(), second = await fixture();
  const conversation = { surface: "slack", accountId: "T10001", channelId: `C${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`, threadId: randomUUID(), subjectPrincipal: "slack:T10001:U10002" };
  const key = workflowAssignmentKey(first.run.instanceId, conversation);
  const assign = async (f: typeof first) => {
    const claimed = (await f.store.claim(lease(f.run)))!;
    return f.store.commit({ instanceId: f.run.instanceId, runId: f.run.runId, expectedRevision: 0, leaseToken: claimed.lease!.token, now, state: f.run.state,
      event: { name: "workflow.bound", stepId: f.run.state.cursor! }, assignments: [{ ...conversation, instanceId: f.run.instanceId, assignmentKey: key, runId: f.run.runId,
        stepId: f.run.state.cursor!, artifactHash: f.run.artifactHash, expiresAt: "2030-01-05T12:00:00.000Z" }] });
  };
  assert.ok(await assign(first));
  await assert.rejects(assign(second), /null|constraint/i);
  assert.equal((await second.store.read(second.run.instanceId, second.run.runId))!.revision, 0);
  assert.equal((await second.control.listEvents(second.run.runId)).some((event) => event.event === "workflow.bound"), false);
  assert.ok(await first.store.assignment({ instanceId: first.run.instanceId, conversation, now }));
  assert.equal(await first.store.assignment({ instanceId: first.run.instanceId, conversation: { ...conversation, subjectPrincipal: "slack:T10001:U10003" }, now }), undefined);
  const channel = { instanceId: first.run.instanceId, surface: conversation.surface, accountId: conversation.accountId,
    channelId: conversation.channelId, subjectPrincipal: conversation.subjectPrincipal, now };
  assert.equal((await first.store.channelAssignments(channel)).length, 1);
  for (const change of [{ instanceId: "foreign-instance" }, { accountId: "T20002" }, { channelId: "C20002" },
    { subjectPrincipal: "slack:T10001:U10003" }, { surface: "another-provider" }, { now: "2030-01-06T12:00:00.000Z" }]) {
    assert.deepEqual(await first.store.channelAssignments({ ...channel, ...change }), []);
  }
  await first.store.cancel({ instanceId: first.run.instanceId, runId: first.run.runId, principal: conversation.subjectPrincipal, now });
  assert.equal(await first.store.assignment({ instanceId: first.run.instanceId, conversation, now }), undefined);
  assert.equal((await first.control.getRun(first.run.runId))!.status, "cancelled");
  assert.deepEqual(await first.store.channelAssignments(channel), []);
});

test("Postgres cancellation and dispatch share a lock; no new dispatch is possible after cancellation", { skip: !enabled }, async () => {
  for (let iteration = 0; iteration < 5; iteration++) {
    const { store, control, run } = await fixture(), claimed = (await store.claim(lease(run)))!;
    const effect = { runId: run.runId, stepId: run.state.cursor!, idempotencyKey: `${run.runId}:effect`, inputHash: "input" };
    assert.equal(await control.claimEffect(effect), true);
    const fence = { instanceId: run.instanceId, runId: run.runId, stepId: run.state.cursor!, leaseToken: claimed.lease!.token, now };
    const [dispatched, cancelled] = await Promise.all([control.markEffectDispatched(effect.idempotencyKey, fence), store.cancel({ instanceId: run.instanceId, runId: run.runId, principal: run.subjectPrincipal, now })]);
    assert.equal(cancelled, true);
    assert.equal((await control.getEffect(effect.idempotencyKey))!.status, dispatched ? "dispatched" : "claimed");
    assert.equal(await control.markEffectDispatched(effect.idempotencyKey, fence), false);
    assert.equal(await store.commit({ instanceId: run.instanceId, runId: run.runId, expectedRevision: 0, leaseToken: fence.leaseToken, now, state: run.state, event: { name: "workflow.test", stepId: run.state.cursor! } }), undefined);
  }
});

test("actual Runtime cannot send when cancellation lands between effect claim and dispatch", { skip: !enabled }, async () => {
  const { args, store, control, run } = await fixture();
  let claimed = (await store.claim(lease(run)))!;
  const state = { ...run.state, cursor: "open-close-thread" };
  await store.commit({ instanceId: run.instanceId, runId: run.runId, expectedRevision: 0, leaseToken: claimed.lease!.token, now, state, event: { name: "workflow.fixture-positioned", stepId: state.cursor } });
  claimed = (await store.claim(lease(run)))!;
  const wf = args.artifact.workflows!.find((w) => w.id === run.workflowId)!;
  const step = wf.steps.find((s) => s.id === state.cursor)!;
  const ctx: WorkflowInvocationContext = { mode: "engine", runId: run.runId, workflowId: run.workflowId, stepId: step.id,
    artifactHash: run.artifactHash, manifestHash: run.manifestHash, status: "running", subjectPrincipal: run.subjectPrincipal,
    steps: {}, trigger: run.trigger, instance: run.fields, decisions: {}, currentRoster: args.artifact.roster,
    dispatchFence: { instanceId: run.instanceId, runId: run.runId, stepId: step.id, leaseToken: claimed.lease!.token, now } };
  const intercepted = { ...control, async claimEffect(effect: Parameters<typeof control.claimEffect>[0]) {
    const accepted = await control.claimEffect(effect);
    await store.cancel({ instanceId: run.instanceId, runId: run.runId, principal: run.subjectPrincipal, now });
    return accepted;
  } };
  let sends = 0;
  const runtime = new CompanyOSRuntime({ artifact: args.artifact, state: intercepted, workflowContext: { read: async () => ctx }, connectors: [{
    id: "test/state", version: "1.0.0", capabilities: ["communication.message.publish"],
    async invoke() { sends++; throw new Error("Provider must not be called"); },
  }] });
  await assert.rejects(runtime.execute({ runId: run.runId, stepId: step.id, agentId: wf.agentId, grantId: step.tool!.grantId, subjectPrincipal: run.subjectPrincipal,
    input: workflowToolInput(args.artifact, wf, step, ctx) }), /dispatch claim/);
  assert.equal(sends, 0);
});


test("Postgres dispatch uses current database time even when a worker retained an earlier fence timestamp", { skip: !enabled }, async () => {
  const { store, control, run } = await fixture();
  const claimed = (await store.claim(lease(run)))!;
  const effect = { runId: run.runId, stepId: run.state.cursor!, idempotencyKey: `${run.runId}:expired`, inputHash: "input" };
  await control.claimEffect(effect);
  const sql = neon(process.env.DATABASE_URL!);
  await sql`update companyos.workflow_executions set lease_expires_at = clock_timestamp() - interval '1 second' where run_id = ${run.runId}`;
  const staleNow = new Date(Date.now() - 60_000).toISOString();
  assert.equal(await control.markEffectDispatched(effect.idempotencyKey, { instanceId: run.instanceId, runId: run.runId, stepId: run.state.cursor!, leaseToken: claimed.lease!.token, now: staleNow }), false);
  assert.equal((await control.getEffect(effect.idempotencyKey))!.status, "claimed");
});

test("Postgres retains parent conversation and separate review notices across restart", { skip: !enabled }, async () => {
  const { store, run } = await fixture();
  const claimed = (await store.claim(lease(run)))!;
  const parent = { surface: "slack", accountId: "T10001", channelId: `C${randomUUID().replaceAll("-", "").toUpperCase()}`, threadId: "1.000001", subjectPrincipal: "slack:T10001:U10002" };
  const notices = [parent, { ...parent, decisionMessageId: "2.000001" }, { ...parent, decisionMessageId: "3.000001" }];
  const assignments = notices.map((conversation) => ({ ...conversation, instanceId: run.instanceId, assignmentKey: workflowAssignmentKey(run.instanceId, conversation), runId: run.runId, stepId: run.state.cursor!, artifactHash: run.artifactHash, expiresAt: "2030-01-05T12:00:00.000Z" }));
  await store.commit({ instanceId: run.instanceId, runId: run.runId, expectedRevision: 0, leaseToken: claimed.lease!.token, now, state: run.state, event: { name: "workflow.test", stepId: run.state.cursor! }, assignments });
  const restarted = createPostgresWorkflowExecutionStore();
  for (const [i, conversation] of notices.entries()) assert.deepEqual(await restarted.deliveredAssignment({ instanceId: run.instanceId, conversation }), assignments[i]);
  for (const changed of [{ ...notices[1]!, threadId: "9.000001" }, { ...notices[1]!, decisionMessageId: "9.000001" }, { ...notices[1]!, subjectPrincipal: "slack:T10001:U10003" }])
    assert.equal(await restarted.deliveredAssignment({ instanceId: run.instanceId, conversation: changed }), undefined);
});
