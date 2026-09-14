import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { bootstrapCompanyDatabase, qualifyCompanyDatabase } from "../../state-postgres/database-bootstrap.ts";
import { PostgresBrainStore } from "../../state-postgres/brain-store.ts";
import { createPostgresCompanyRecordsStore } from "../../state-postgres/records-store.ts";
import { syncBrain } from "../../brain/sync.ts";
import { BrainReads } from "../../brain/reads.ts";
import { brainConfig, brainFiles, brainFixturePage } from "../fixtures/brain.ts";

const enabled = process.env.RUN_DATABASE_TESTS === "1" && !!process.env.DATABASE_URL;
test("Postgres Brain publishes one scoped projection, performs language search and preserves control/Records", { skip: !enabled }, async () => {
  await bootstrapCompanyDatabase();
  const store = new PostgresBrainStore(), leases = createPostgresCompanyRecordsStore();
  const scope = { instance_id: `brain-test-${randomUUID()}`, repository_id: "example/knowledge" };
  let commit = "a".repeat(40), files: Record<string, string> = { ...brainFiles,
    "brain/topics/german.md": brainFixturePage("topic", "Planung", "Die Zahlungen bleiben offen.", "lang: de\n") };
  const sync = () => syncBrain({ store, leases, scope, configuration: brainConfig, repository: { revision: async () => commit, read: async () => files } });
  const reads = new BrainReads(store, scope), sql = neon(process.env.DATABASE_URL!);
  try {
    const result = await sync(); assert.equal(result.status, "indexed");
    assert.equal((await qualifyCompanyDatabase()).schemas.companyosBrain.tableCount, 5);
    const revision = await store.revision(scope); assert.ok(revision);
    assert.equal((await reads.entity("Alex")).found, true);
    const hits = await reads.recall({ query: "branch" });
    assert.deepEqual(hits.hits.filter(hit => hit.take).map(hit => hit.take!.row_num).sort(), [4, 7]);
    assert.ok(hits.hits.every(hit => !hit.excerpt.includes("Open the branch now")));
    assert.ok((await reads.recall({ query: "Zahlung" })).hits.some(hit => hit.slug === "topics/german"), "Use declared language stemming");
    assert.equal((await sync()).status, "unchanged");
    await assert.rejects(store.pages({ ...scope, instance_id: "other-instance" }, revision, ["people/alex"]), /revision changed/);
    await assert.rejects(store.pages(scope, { ...revision, sequence: revision.sequence + 1 }, []), /revision changed/, "An empty data result still checks revision");
    const cursor = (await reads.contextPack({ entities: "topics/expansion" })).change_cursor;
    assert.equal(JSON.parse(Buffer.from(cursor, "base64url").toString()).after, revision.sequence);
    files = { ...files }; delete files["brain/topics/expansion.md"]; commit = "b".repeat(40);
    assert.equal((await sync()).status, "indexed");
    assert.equal((await reads.entity("topics/expansion")).found, false);
    assert.equal((await reads.recall({ query: "branch" })).hits.filter(hit => hit.take).length, 0);
    const changes = await sql`select slug, kind from companyos_brain.changes where instance_id = ${scope.instance_id} and repository_id = ${scope.repository_id} and sequence = 2`;
    assert.deepEqual(changes, [{ slug: "topics/expansion", kind: "removed" }]);
    const delta = await reads.delta({ cursor });
    assert.equal(delta.status, "ok"); assert.equal(delta.changes.length, 1); assert.equal(delta.changes[0].kind, "removed"); assert.equal(delta.changes[0].current, null);
    assert.equal((await reads.delta({ cursor: delta.next_cursor! })).changes.length, 0);
    const first = await reads.delta({ since: "2000-01-01T00:00:00Z", budget_tokens: 1 });
    assert.equal(first.has_more, true); assert.equal(first.changes.length, 0);
    const collected: string[] = []; let continuation = first;
    for (let i = 0; continuation.has_more && i < 20; i++) {
      continuation = await reads.delta({ cursor: continuation.next_cursor!, budget_tokens: 200 });
      collected.push(...continuation.changes.map(change => change.change_id));
    }
    assert.equal(collected.length, 7); assert.equal(new Set(collected).size, 7); assert.equal(continuation.has_more, false);
    const before = await store.revision(scope);
    assert.equal(await store.publish({ scope, expected: revision, revision: { ...revision, sequence: 3 }, pages: [], changes: [], lease: { source_id: "missing", token: randomUUID() } }), false);
    assert.deepEqual(await store.revision(scope), before, "Invalid lease/CAS cannot mutate any part of the projection");
    const records = await sql`select to_regclass('companyos_records.object_versions') as objects, to_regclass('companyos.workflow_executions') as executions`;
    assert.ok(records[0].objects && records[0].executions);
  } finally {
    await sql`delete from companyos_brain.revisions where instance_id = ${scope.instance_id} and repository_id = ${scope.repository_id}`;
  }
});

test("effect checkpoints and receipt reconciliation use atomic status/input/evidence compare-and-set in PostgreSQL", { skip: !enabled }, async () => {
  const { createPostgresStateStore } = await import("../../state-postgres/store.ts");
  const { InMemoryStateStore } = await import("../../runtime/memory-state.ts");
  await bootstrapCompanyDatabase();
  const sql = neon(process.env.DATABASE_URL!);
  for (const store of [createPostgresStateStore(), new InMemoryStateStore()]) {
    const runId = `brain-effect-${randomUUID()}`, key = `brain-test:${runId}`, inputHash = "a".repeat(64);
    await store.ensureRun({ runId, workflow: "brain-fixture", workflowVersion: "1", companySnapshotHash: "snapshot", agentDefinitionHash: "agent", agentAdapter: "test" });
    try {
      assert.equal(await store.claimEffect({ idempotencyKey: key, inputHash, runId, stepId: "write" }), true);
      const prepared = { phase: "prepared", paths: ["brain/topics/review.md"] };
      const checkpoint = { idempotencyKey: key, inputHash, expectedStatus: "claimed" as const, expectedEvidence: null, status: "claimed" as const, evidence: prepared };
      const claims = await Promise.all([store.compareAndSetEffect(checkpoint), store.compareAndSetEffect(checkpoint)]);
      assert.equal(claims.filter(Boolean).length, 1);
      assert.equal(await store.compareAndSetEffect({ ...checkpoint, expectedEvidence: prepared, inputHash: "b".repeat(64) }), false);
      await assert.rejects(store.compareAndSetEffect({ ...checkpoint, status: "dispatched" }));
      assert.equal(await store.markEffectDispatched(key), true);
      await store.markEffectUnknown(key, { operation_id: "synthetic-operation" });
      const expected = await store.getEffect(key), proof = { verified_commit: "c".repeat(40) };
      const recovered = { idempotencyKey: key, inputHash, expectedStatus: "unknown" as const, expectedEvidence: expected!.evidence, status: "succeeded" as const, evidence: proof };
      assert.equal(await store.compareAndSetEffect(recovered), true); assert.equal(await store.compareAndSetEffect(recovered), false);
      await assert.rejects(store.compareAndSetEffect({ ...recovered, expectedStatus: "succeeded", status: "claimed", expectedEvidence: proof }));
      assert.equal((await store.getEffect(key))?.status, "succeeded");
    } finally {
      await sql`delete from companyos.effects where run_id = ${runId}`;
      await sql`delete from companyos.workflow_runs where run_id = ${runId}`;
    }
  }
});

test("Postgres retains frozen transcript cohorts across concurrent setup and bounded extensions", { skip: !enabled }, async () => {
  const { createPostgresStateStore } = await import("../../state-postgres/store.ts");
  const { freezeTranscriptCohort } = await import("../../brain/import-policy.ts");
  const { transcriptImportOrigin } = await import("../../brain/import-admission.ts");
  await bootstrapCompanyDatabase(); const store = createPostgresStateStore(), sql = neon(process.env.DATABASE_URL!);
  const runId = `brain-cohort-${randomUUID()}`, extensionId = `${runId}-extension`;
  for (const id of [runId, extensionId]) await store.ensureRun({ runId: id, workflow: "brain-import-fixture", workflowVersion: "1", companySnapshotHash: "snapshot", agentDefinitionHash: "agent", agentAdapter: "test" });
  const candidates = Array.from({ length: 6 }, (_, i) => ({ identity: `synthetic:${i}`, source_version: `version:${i}`, meeting_start_at: "2030-04-01T00:00:00Z", origin: "provider" as const, finished: true }));
  const args = { store, instanceId: runId, importId: "brain-import", runId, candidates, reserved: [], inventoryComplete: true, availableFrom: null,
    policy: { mode: "bounded" as const, max_transcripts: 4, meeting_date: { start_at: null, end_at: null } }, now: "2030-04-02T00:00:00Z" };
  try {
    const cohorts = await Promise.all([freezeTranscriptCohort(args), freezeTranscriptCohort(args)]);
    assert.deepEqual(cohorts[0], cohorts[1]); assert.equal(cohorts[0].cumulative_count, 4);
    const extension = await freezeTranscriptCohort({ ...args, store: createPostgresStateStore(), runId: extensionId, policy: { ...args.policy, max_transcripts: 6 } });
    assert.equal(extension.cumulative_count, 6); assert.equal(extension.admitted.length, 2);
    assert.deepEqual(await freezeTranscriptCohort({ ...args, store: createPostgresStateStore() }), cohorts[0]);
    const admission = { store: createPostgresStateStore(), instanceId: args.instanceId,
      workflow: { config: { value: { policy: args.policy } } } as unknown as import("../../companyos-builder/workflow-types.ts").CompiledWorkflow,
      binding: { workflowId: "synthetic", importId: args.importId, cohortId: cohorts[0].id, policyField: "policy", sourceIdentityField: "source", sourceVersionField: "version" },
      fields: { source: "synthetic:0", version: "content-version" } };
    const opened = await transcriptImportOrigin(admission);
    assert.equal(opened.receipt.cohortId, cohorts[0].id);
    assert.equal(opened.receipt.sourceVersion, "content-version");
    assert.deepEqual(await transcriptImportOrigin({ ...admission, store: createPostgresStateStore() }), opened);
    await assert.rejects(transcriptImportOrigin({ ...admission, fields: { source: "synthetic:4", version: "content-version" } }), /outside/);
  } finally {
    await sql`delete from companyos.effects where run_id = ${runId} or run_id = ${extensionId}`;
    await sql`delete from companyos.workflow_runs where run_id = ${runId} or run_id = ${extensionId}`;
  }
});

test("Postgres model-attempt reports reconcile a lost completion event and retain incomplete-call cost", { skip: !enabled }, async () => {
  const { createPostgresStateStore } = await import("../../state-postgres/store.ts");
  const { LanguageAttempt, readLanguageAttempts } = await import("../../language/attempts.ts");
  const { languageCostReport } = await import("../../language/costs.ts");
  await bootstrapCompanyDatabase(); const store = createPostgresStateStore(), sql = neon(process.env.DATABASE_URL!);
  const runId = `brain-cost-${randomUUID()}`;
  await store.ensureRun({ runId, workflow: "brain-import-fixture", workflowVersion: "1", companySnapshotHash: "snapshot", agentDefinitionHash: "agent", agentAdapter: "test" });
  const selection = { route: "anthropic-direct", model: "anthropic/synthetic", provider: "anthropic", transport: "anthropic-messages", credentialRef: null, baseUrlRef: null, recipeVersion: "1.0.0" } as const;
  const evidence = { model_execution: { ...selection, responseId: "synthetic-response", responseModel: "synthetic", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, uncachedInputTokens: 100 } };
  try {
    const attempt = new LanguageAttempt(store, { runId, stepId: "triage", inputHash: "a".repeat(64), evidence: { artifact_hash: "b".repeat(64) } });
    await attempt.prepare(); await attempt.dispatch(selection); await attempt.finish("failed", evidence);
    await sql`delete from companyos.events where run_id = ${runId} and event = 'language.attempt-finished'`;
    const receipts = await readLanguageAttempts(createPostgresStateStore(), [runId, runId]);
    assert.equal(receipts.length, 1); assert.equal(receipts[0].status, "failed"); assert.equal(receipts[0].step_id, "triage");
    assert.deepEqual(receipts[0].evidence.model_execution, evidence.model_execution);
    const report = languageCostReport(receipts, [{ ...selection, currency: "USD", source: "https://example.invalid/prices", valid_from: "2020-01-01T00:00:00Z", valid_until: null,
      input_per_million: 2, output_per_million: 8, cache_read_per_million: 0.2, cache_write_per_million: 2.5 }]);
    assert.equal(report.totals.USD.estimated, 0.0006);
  } finally {
    await sql`delete from companyos.events where run_id = ${runId}`;
    await sql`delete from companyos.effects where run_id = ${runId}`;
    await sql`delete from companyos.workflow_runs where run_id = ${runId}`;
  }
});
