import assert from "node:assert/strict";
import { test } from "node:test";
import { BuilderFunctionalTests, builderTestResultDigest, prepareBuilderTestSession, scopeBuilderTestConnector,
  type BuilderTestSession, type BuilderTestStore } from "../../runtime/builder/functional-tests.ts";
import type { BuilderJob } from "../../state-store/builder-jobs.ts";
import { sha256 } from "../../runtime/canonical.ts";

function fixture() {
  const job = { jobId: "builder-example", instanceId: "example", repositoryId: "example/company", requesterPrincipal: "slack:TEAM:HUMAN",
    sourceConversationKey: "slack:CHANNEL:1.0", baseCommit: "a".repeat(40), state: "published",
    brief: { artifactHash: "d".repeat(64), digest: "e".repeat(64), brief: { test: { strategy: "test-resources", targetBindings: ["test-board"] } } },
    evidence: { proposal: { jobId: "builder-example", repositoryId: "example/company", baseCommit: "a".repeat(40), proposalCommit: "b".repeat(40) },
      validation: { validationPassed: true, releaseChangeClass: "behavior", checks: [{ id: "validate", evidenceDigest: "f".repeat(64) }] } },
  } as unknown as BuilderJob;
  const session = prepareBuilderTestSession({ job, coreCommit: "c".repeat(40), resources: [
    { id: "test-board", capability: "work-item.comment", match: { resource_binding: "designated-test-board", work_item_id: "42" } },
  ], execution: { kind: "workflow", workflowId: "example-workflow", fields: { report_id: "example" } } });
  const values = new Map<string, BuilderTestSession>();
  const store: BuilderTestStore = {
    get: async (id) => structuredClone(values.get(id)),
    create: async (value) => { if (!values.has(value.id)) values.set(value.id, structuredClone(value)); return structuredClone(values.get(value.id)!); },
    replace: async (previous, next) => {
      if (sha256(values.get(previous.id)) !== sha256(previous)) return false;
      values.set(previous.id, structuredClone(next)); return true;
    },
  };
  const service = new BuilderFunctionalTests(store);
  const begin = async () => { await store.create(session); return service.begin(session.id, "1".repeat(64), "slack:TEST:2.0"); };
  const complete = async () => {
    await begin();
    return service.recordResult(session.id, { artifactHash: "1".repeat(64), candidateCommit: job.evidence && (job.evidence as any).proposal.proposalCommit,
      executionDigest: session.scopeDigest, completedAt: "2026-09-08T12:00:00Z", summary: "The changed workflow posted its revised report.",
      evidence: { provider: "synthetic", commentId: "test-comment" } });
  };
  return { job, session, store, service, begin, complete };
}

test("selected resources require trusted Instance qualification before preparing a candidate test", () => {
  const f = fixture();
  assert.throws(() => prepareBuilderTestSession({ job: f.job, coreCommit: f.session.coreCommit, resources: [], execution: f.session.execution }), /not qualified/);
});

test("a selected test strategy or running test never satisfies the release gate", async () => {
  const f = fixture();
  await assert.rejects(() => f.service.releaseEvidence(f.job, false), /no current/);
  await f.begin();
  await assert.rejects(() => f.service.releaseEvidence(f.job, false), /no current/);
  await assert.rejects(() => f.service.recordResult(f.session.id, { artifactHash: "2".repeat(64), candidateCommit: f.session.candidateCommit,
    executionDigest: f.session.scopeDigest, completedAt: "2026-09-08T12:00:00Z", summary: "Wrong Artifact", evidence: {} }), /exact execution/);
});

test("real result precedes one candidate-bound acceptance; replay cannot change the accepting human", async () => {
  const f = fixture(), reviewed = await f.complete();
  const resultDigest = builderTestResultDigest(reviewed);
  assert.equal((await f.service.releaseEvidence(f.job, false)).digest, resultDigest);
  await assert.rejects(() => f.service.releaseEvidence(f.job, true), /no current/);
  await assert.rejects(() => f.service.accept(f.session.id, { principal: f.session.requester, actionId: "action-1", resultDigest: "0".repeat(64), acceptedAt: "2026-09-08T12:01:00Z" }), /exact current/);
  await f.service.accept(f.session.id, { principal: f.session.requester, actionId: "action-1", resultDigest, acceptedAt: "2026-09-08T12:01:00Z" });
  assert.equal((await f.service.releaseEvidence(f.job, true)).session.acceptance?.principal, f.session.requester);
  await assert.rejects(() => f.service.accept(f.session.id, { principal: "other", actionId: "action-2", resultDigest, acceptedAt: "2026-09-08T12:02:00Z" }));
});

test("feedback invalidates acceptance and cannot be attributed to another human", async () => {
  const f = fixture(), reviewed = await f.complete(), resultDigest = builderTestResultDigest(reviewed);
  const feedback = { principal: f.session.requester, messageId: "human-message", text: "Show the summary before the task list.", receivedAt: "2026-09-08T12:01:00Z" };
  await assert.rejects(() => f.service.requestChanges(f.session.id, { ...feedback, principal: "other" }), /authenticated requester/);
  await f.service.requestChanges(f.session.id, feedback);
  await assert.rejects(() => f.service.releaseEvidence(f.job, false), /no current/);
  await assert.rejects(() => f.service.accept(f.session.id, { principal: f.session.requester, actionId: "stale-card", resultDigest, acceptedAt: "2026-09-08T12:02:00Z" }));
});

test("changed source, checks or brief cannot reuse a functional-test receipt", async () => {
  const f = fixture(); await f.complete();
  for (const change of ["source", "checks", "brief"]) {
    const changed = structuredClone(f.job) as any;
    if (change === "source") changed.evidence.proposal.proposalCommit = "f".repeat(40);
    if (change === "checks") changed.evidence.validation.checks = [];
    if (change === "brief") changed.brief.digest = "0".repeat(64);
    await assert.rejects(() => f.service.releaseEvidence(changed, false), /no current/);
  }
});

test("simultaneous feedback and acceptance have exactly one winner", async () => {
  const f = fixture(), reviewed = await f.complete();
  const results = await Promise.allSettled([
    f.service.requestChanges(f.session.id, { principal: f.session.requester, messageId: "feedback", text: "Please revise.", receivedAt: "2026-09-08T12:01:00Z" }),
    f.service.accept(f.session.id, { principal: f.session.requester, actionId: "accept", resultDigest: builderTestResultDigest(reviewed), acceptedAt: "2026-09-08T12:01:00Z" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const current = await f.store.get(f.session.id);
  assert.ok(current?.feedback ? !current.acceptance : !!current?.acceptance);
});

test("test connector blocks live resources, foreign runs and inactive tests before provider dispatch", async () => {
  const f = fixture(); let calls = 0, active = true;
  const connector = scopeBuilderTestConnector({ id: "example", version: "1.0.0", capabilities: ["work-item.comment"],
    invoke: async () => { calls++; return { output: { comment_id: "42" }, evidence: { synthetic: true } }; } }, {
      instanceId: f.session.instanceId, runId: `${f.session.id}:run`, resources: f.session.resources,
      assertActive: async () => { if (!active) throw new Error("Test is closed."); },
    });
  const context = { instanceId: f.session.instanceId, runId: `${f.session.id}:run`, stepId: "publish", agentId: "example", toolId: "comment" };
  const input = { resource_binding: "designated-test-board", work_item_id: "42", body: "Test result" };
  await connector.invoke("work-item.comment", input, context);
  await assert.rejects(() => connector.invoke("work-item.comment", { ...input, resource_binding: "live-board" }, context));
  await assert.rejects(() => connector.invoke("work-item.comment", { ...input, work_item_id: "99" }, context));
  await assert.rejects(() => connector.invoke("work-item.comment", input, { ...context, runId: "production-run" }));
  await assert.rejects(() => connector.invoke("work-item.update", input, context));
  active = false;
  await assert.rejects(() => connector.invoke("work-item.comment", input, context));
  assert.equal(calls, 1);
});

async function interactiveFixture() {
  const f = fixture();
  let now = new Date("2026-09-09T10:00:00Z");
  const service = new BuilderFunctionalTests(f.store, () => now);
  const session = prepareBuilderTestSession({ job: f.job, coreCommit: f.session.coreCommit, resources: f.session.resources,
    execution: { kind: "agent", agentId: "example", prompt: "Explain your role.", interaction: "interactive" } });
  await f.store.create(session);
  await service.begin(session.id, "1".repeat(64), "slack:TEST:2.0");
  const result = (summary: string) => ({ artifactHash: "1".repeat(64), candidateCommit: session.candidateCommit,
    executionDigest: session.scopeDigest, summary, completedAt: now.toISOString(), evidence: { synthetic: true } });
  await service.recordResult(session.id, result("I help with the company process."));
  return { ...f, session, service, result, advanceDay: () => { now = new Date(now.getTime() + 8 * 24 * 60 * 60_000); } };
}

test("interactive Go Live freezes current evidence directly without a Finish test action", async () => {
  const f = await interactiveFixture(), id = f.session.id, actor = f.session.requester;
  const old = (await f.service.releaseEvidence(f.job, false)).digest;
  await assert.rejects(() => f.service.beginTurn(id, "another-human", "m1", "Explain more"));
  await f.service.beginTurn(id, actor, "m1", "Explain the second point");
  await assert.rejects(() => f.service.releaseEvidence(f.job, false), /no current/);
  await assert.rejects(() => f.service.accept(id, { principal: actor, actionId: "old", resultDigest: old, acceptedAt: "2026-09-09T10:01:00Z" }));
  const answered = await f.service.recordTurn(id, "m1", f.result("Here is the second point."));
  await assert.rejects(() => f.service.beginTurn(id, actor, "m1", "Replay"));
  assert.notEqual(builderTestResultDigest(answered), old);
  await assert.rejects(() => f.service.accept(id, { principal: actor, actionId: "old", resultDigest: old, acceptedAt: "2026-09-09T10:01:00Z" }));
  await f.service.accept(id, { principal: actor, actionId: "current", resultDigest: builderTestResultDigest(answered), acceptedAt: "2026-09-09T10:01:00Z" });
  assert.equal((await f.service.releaseEvidence(f.job, true)).session.stage, "accepted");
  await assert.rejects(() => f.service.beginTurn(id, actor, "m2", "Too late"));
});

test("retesting the same candidate clears history and invalidates its previous acceptance token", async () => {
  const f = await interactiveFixture(), id = f.session.id, actor = f.session.requester;
  const old = await f.service.finish(id, actor), oldDigest = builderTestResultDigest(old);
  const restarted = await f.service.restart(id, actor);
  assert.equal(restarted.candidateCommit, old.candidateCommit);
  assert.equal(restarted.conversation?.turns.length, 0); assert.equal(restarted.result, undefined);
  await assert.rejects(() => f.service.accept(id, { principal: actor, actionId: "old", resultDigest: oldDigest, acceptedAt: "2026-09-09T10:01:00Z" }));
  await f.service.beginTurn(id, actor, "new-question", "Give an example");
  await f.service.recordTurn(id, "new-question", f.result("A new example."));
  const fresh = await f.service.finish(id, actor), freshDigest = builderTestResultDigest(fresh);
  assert.notEqual(freshDigest, oldDigest);
  await assert.rejects(() => f.service.accept(id, { principal: actor, actionId: "old", resultDigest: oldDigest, acceptedAt: "2026-09-09T10:02:00Z" }));
  await f.service.accept(id, { principal: actor, actionId: "fresh", resultDigest: freshDigest, acceptedAt: "2026-09-09T10:02:00Z" });
  await assert.rejects(() => f.service.restart(id, actor));
});

test("inactivity pauses tests after seven days and requester resume retains the candidate and history", async () => {
  const f = await interactiveFixture(), id = f.session.id, actor = f.session.requester;
  f.advanceDay();
  await assert.rejects(() => f.service.beginTurn(id, actor, "late", "Continue"));
  await assert.rejects(() => f.service.finish(id, actor));
  assert.equal((await f.service.expire(id)).stage, "expired");
  await assert.rejects(() => f.service.releaseEvidence(f.job, false));
  const resumed = await f.service.resume(id, actor);
  assert.equal(resumed.candidateCommit, f.session.candidateCommit);
  assert.equal(resumed.conversation?.turns.length, 1);
  assert.equal((await f.service.beginTurn(id, actor, "fresh", "Start again")).stage, "responding");
});

test("concurrent interactive turns have one durable winner", async () => {
  const f = await interactiveFixture();
  const results = await Promise.allSettled([f.service.beginTurn(f.session.id, f.session.requester, "a", "First"),
    f.service.beginTurn(f.session.id, f.session.requester, "b", "Second")]);
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal((await f.store.get(f.session.id))?.stage, "responding");
});

test("fresh conversations have independent histories while existing conversations remain pinned", async () => {
  const f = await interactiveFixture(), id = f.session.id, actor = f.session.requester;
  const fresh = await f.service.beginTurn(id, actor, "new-root", "First question", "example-chat:new-thread");
  assert.equal(fresh.conversation?.turns.length, 0, "new threads do not inherit the scripted initial test answer");
  const answered = await f.service.recordTurn(id, "new-root", f.result("Fresh answer"));
  assert.equal(answered.testConversations?.["example-chat:new-thread"].turns.length, 1);
  const original = await f.service.beginTurn(id, actor, "original-followup", "Continue", "slack:TEST:2.0");
  assert.equal(original.conversation?.turns.length, 1);
  assert.equal(original.conversation?.turns[0].prompt, "Explain your role.");
  const completed = await f.service.recordTurn(id, "original-followup", f.result("Original followup"));
  assert.equal(completed.testConversations?.["example-chat:new-thread"].turns.length, 1);
  assert.equal(completed.testConversations?.["slack:TEST:2.0"].turns.length, 2);
  assert.equal(completed.candidateCommit, f.session.candidateCommit);
});

test("publication and a new test reply race through the same atomic session revision", async () => {
  const f = await interactiveFixture();
  const resultDigest = (await f.service.releaseEvidence(f.job, false)).digest;
  const results = await Promise.allSettled([
    f.service.accept(f.session.id, { principal: f.session.requester, actionId: "live", resultDigest, acceptedAt: "2026-09-09T10:01:00Z" }),
    f.service.beginTurn(f.session.id, f.session.requester, "new", "Another question", "example:new"),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
});

test("a silent candidate turn retains context without replacing the last visible result or weakening identity", async () => {
  const f = await interactiveFixture(), id = f.session.id, actor = f.session.requester;
  const previousSession = (await f.store.get(id))!;
  const previous = previousSession.result, previousDigest = builderTestResultDigest(previousSession);
  const message = { id: "ambient", conversationId: "slack:TEST:2.0", senderId: actor, senderName: "Alice",
    text: "Bob, we can discuss this tomorrow.", sentAt: "2026-09-09T10:01:00Z", shared: true, mentioned: false };
  await assert.rejects(() => f.service.beginTurn(id, actor, message.id, message.text, message.conversationId, { ...message, senderId: "person:other" }));
  await f.service.beginTurn(id, actor, message.id, message.text, message.conversationId, message);
  await assert.rejects(() => f.service.recordTurn(id, message.id, { ...f.result("Leaked text"), participation: "context-only" }));
  const retained = await f.service.recordTurn(id, message.id, { ...f.result(""), participation: "context-only" });
  assert.deepEqual(retained.result, previous);
  assert.equal(builderTestResultDigest(retained), previousDigest, "Silent context must not stale the existing Go Live card");
  await f.service.beginTurn(id, actor, "visible", "Please explain");
  const visible = await f.service.recordTurn(id, "visible", f.result("A new answer"));
  assert.notEqual(builderTestResultDigest(visible), previousDigest);
  assert.deepEqual(retained.conversation?.turns.at(-1)?.message, message);
  assert.equal(retained.stage, "interactive");
  await assert.rejects(() => f.service.beginTurn(id, actor, message.id, message.text));
});
