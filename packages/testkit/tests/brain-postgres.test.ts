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
