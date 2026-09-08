import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sha256 } from "../../runtime/canonical.ts";
import { createPostgresReleasePrivateState, createPostgresReleaseRunStore } from "../../state-postgres/release-run-store.ts";
import type { ReleaseCandidate } from "../../runtime/release/contracts.ts";
import type { ReleaseRun } from "../../state-store/release-runs.ts";
import { createPostgresBuilderTestStore } from "../../state-postgres/builder-test-store.ts";
import { BuilderFunctionalTests, builderTestResultDigest } from "../../runtime/builder/functional-tests.ts";
import { builderFunctionalFixture } from "../builder-functional-fixture.ts";

const enabled = process.env.RUN_DATABASE_TESTS === "1";
if (process.env.COMPANYOS_REQUIRE_DATABASE_TESTS === "1" && (!enabled || !process.env.DATABASE_URL)) throw new Error("Required release database configuration is missing.");

test("Postgres functional-test acceptance survives restart and races atomically with feedback", { skip: !enabled }, async () => {
  const f = builderFunctionalFixture();
  try {
    const prepared = { ...f.session, id: `builder-test-${sha256(randomUUID()).slice(0, 40)}` };
    const store = createPostgresBuilderTestStore(), service = new BuilderFunctionalTests(store);
    await store.create(prepared);
    await service.begin(prepared.id, f.candidate.artifactHash, "slack:C20002:2.0", "https://example.slack.com/archives/C20002/p2000000");
    const reviewed = await service.recordResult(prepared.id, { artifactHash: f.candidate.artifactHash, candidateCommit: prepared.candidateCommit,
      executionDigest: prepared.scopeDigest, summary: "Synthetic fixture result", completedAt: new Date().toISOString(), evidence: { synthetic: true } });
    assert.equal((await createPostgresBuilderTestStore().create(prepared)).stage, "reviewable", "notification reconstruction must preserve the existing result");
    const restarted = new BuilderFunctionalTests(createPostgresBuilderTestStore());
    const results = await Promise.allSettled([
      service.requestFeedback(prepared.id, prepared.requester),
      restarted.accept(prepared.id, { principal: prepared.requester, actionId: "synthetic-action", resultDigest: builderTestResultDigest(reviewed), acceptedAt: new Date().toISOString() }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const final = await createPostgresBuilderTestStore().get(prepared.id);
    assert.equal(final?.revision, 3);
    assert.ok(final?.stage === "feedback-pending" || final?.stage === "accepted");
    await assert.rejects(store.create({ ...prepared, candidateCommit: "f".repeat(40) }), /conflicts/);
  } finally { f.cleanup(); }
});

test("Postgres release snapshots retain exact acceptance, fence concurrent saves and recover expired leases", { skip: !enabled }, async () => {
  const id = randomUUID(), now = "2031-04-05T12:00:00.000Z";
  const candidate: ReleaseCandidate = { version: 1, id, instanceId: id, repositoryId: "synthetic/company", targetBranch: "main",
    baseCommit: "a".repeat(40), candidateCommit: "b".repeat(40), candidateTree: "c".repeat(40), coreCommit: "d".repeat(40),
    configurationDigest: "1".repeat(64), policyDigest: "2".repeat(64), diffDigest: "3".repeat(64), checksDigest: "4".repeat(64),
    changeClass: "behavior", requester: "test:synthetic:owner", sourceConversation: "test:synthetic:thread",
    requiredChecks: ["check"], previousArtifactHash: "5".repeat(64) };
  const run: ReleaseRun = { id, candidate, candidateDigest: sha256(candidate), acceptedBy: candidate.requester, acceptedAt: now,
    stage: "approved", revision: 0, updatedAt: now };
  const store = createPostgresReleaseRunStore();
  const creates = await Promise.all([store.create(run), createPostgresReleaseRunStore().create(run)]);
  assert.equal(creates[0].id, creates[1].id);
  await assert.rejects(store.create({ ...run, candidateDigest: "6".repeat(64) }), /conflicts/);
  const claims = await Promise.all([store.claim(id, "worker-a", now, 1000), createPostgresReleaseRunStore().claim(id, "worker-b", now, 1000)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const lease = claims.find(Boolean)!;
  const next = { ...lease.run, stage: "merging" as const, revision: 1 };
  const saves = await Promise.allSettled([store.save(lease, next, now), createPostgresReleaseRunStore().save(lease, next, now)]);
  assert.equal(saves.filter((result) => result.status === "fulfilled").length, 1, "database CAS must also fence two holders of the same stale revision");
  const reclaimed = await createPostgresReleaseRunStore().claim(id, "restarted", "2031-04-05T12:00:02.000Z", 10000);
  assert.equal(reclaimed?.run.revision, 1);
  await assert.rejects(store.save({ ...lease, run: next }, { ...next, revision: 2 }, "2031-04-05T12:00:02.000Z"), /stale/);
  await store.release(lease);
  assert.equal(await store.claim(id, "other", "2031-04-05T12:00:03.000Z", 1000), undefined);
  await store.save(reclaimed!, { ...reclaimed!.run, revision: 2, stage: "failed", notificationDelivered: true }, "2031-04-05T12:00:03.000Z");
  await store.release(reclaimed!);
  assert.equal((await createPostgresReleaseRunStore().get(id))?.candidateDigest, run.candidateDigest);
  assert.equal(await store.claim(id, "finished", "2031-04-05T12:00:04.000Z", 1000), undefined);
});

test("Postgres private release intents and artifacts survive reconstruction and admit one creator", { skip: !enabled }, async () => {
  const key = `fixture:${randomUUID()}`;
  const state = createPostgresReleasePrivateState();
  const claims = await Promise.all([state.setIfNotExists(key, { phase: "requested" }), createPostgresReleasePrivateState().setIfNotExists(key, { phase: "requested" })]);
  assert.equal(claims.filter(Boolean).length, 1);
  await state.set(key, { phase: "recorded", deploymentId: "dpl_synthetic", artifactHash: "a".repeat(64) });
  assert.deepEqual(await createPostgresReleasePrivateState().get(key), { phase: "recorded", deploymentId: "dpl_synthetic", artifactHash: "a".repeat(64) });
});


test("release Knowledge selects its verified snapshot without changing the legacy live selection", { skip: !enabled }, async () => {
  const { buildKnowledgeBundle } = await import("../../knowledge/okf.ts");
  const { createPostgresKnowledgeProvider } = await import("../../state-postgres/knowledge-store.ts");
  const { resolve } = await import("node:path");
  const workspaceRoot = resolve(import.meta.dirname, "../fixtures/acme-casas");
  const old = buildKnowledgeBundle({ workspaceRoot, workspaceCommit: "a".repeat(40) });
  const next = buildKnowledgeBundle({ workspaceRoot, workspaceCommit: "b".repeat(40) });
  const legacy = createPostgresKnowledgeProvider();
  await legacy.stage(old); await legacy.verify(old.bundleHash); await legacy.activate(old.bundleHash);
  await legacy.stage(next);
  const selected = createPostgresKnowledgeProvider({ snapshotHash: next.bundleHash });
  assert.equal(await selected.activeSnapshot(), undefined, "unverified staging is not a readable release");
  await legacy.verify(next.bundleHash);
  assert.equal((await selected.activeSnapshot())?.snapshotHash, next.bundleHash);
  assert.equal((await legacy.activeSnapshot())?.snapshotHash, old.bundleHash);
  assert.equal((await selected.search({ query: "company" })).snapshotHash, next.bundleHash);
  const missing = createPostgresKnowledgeProvider({ snapshotHash: "f".repeat(64) });
  assert.equal(await missing.activeSnapshot(), undefined);
  assert.equal(await missing.get({ path: "index.md" }), undefined);
  assert.equal((await missing.search({ query: "company" })).snapshotHash, null);
});
