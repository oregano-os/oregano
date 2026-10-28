import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkflowArtifactCache } from "../../state-postgres/artifact-cache.ts";
import { workflowStateFixture } from "../workflow-state-fixture.ts";

test("Artifact reads coalesce, isolate databases and protect cached content from callers", async () => {
  const { artifact } = workflowStateFixture(), cache = new WorkflowArtifactCache();
  let reads = 0;
  const load = async () => { reads++; return artifact; };
  const values = await Promise.all(Array.from({ length: 8 }, () => cache.read("database-a", artifact.artifactHash, load)));
  assert.equal(reads, 1);
  values[0]!.instance.id = "tampered";
  assert.equal(values[1]!.instance.id, artifact.instance.id);
  assert.equal((await cache.read("database-a", artifact.artifactHash, load))!.instance.id, artifact.instance.id);
  await cache.read("database-b", artifact.artifactHash, load);
  assert.equal(reads, 2);
});

test("failed, missing and invalid Artifacts never become cached successes", async () => {
  const { artifact } = workflowStateFixture(), cache = new WorkflowArtifactCache();
  const read = (load: () => Promise<typeof artifact | undefined>) => cache.read("db", artifact.artifactHash, load);
  await assert.rejects(() => read(async () => { throw new Error("offline"); }), /offline/);
  assert.equal(await read(async () => undefined), undefined);
  const bad = structuredClone(artifact); bad.instance.id = "tampered";
  await assert.rejects(() => read(async () => bad));
  await assert.rejects(() => cache.read("db", "a".repeat(64), async () => artifact));
  assert.deepEqual(await read(async () => artifact), artifact);
});

test("cache entry and byte budgets evict or bypass without losing valid results", async () => {
  const { artifact } = workflowStateFixture();
  for (const cache of [new WorkflowArtifactCache(1), new WorkflowArtifactCache(16, 1)]) {
    let reads = 0;
    const load = async () => { reads++; return artifact; };
    await cache.read("a", artifact.artifactHash, load);
    await cache.read("b", artifact.artifactHash, load);
    await cache.read("a", artifact.artifactHash, load);
    assert.equal(reads, 3);
  }
});
