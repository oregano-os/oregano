import assert from "node:assert/strict";
import test from "node:test";
import { ArtifactReferenceCache } from "./artifact-reference.ts";
import type { CompanyOSArtifact } from "../../../companyos-builder/types.ts";

const hash = "a".repeat(64), other = "b".repeat(64);
const artifact = { artifactHash: hash } as CompanyOSArtifact;

test("concurrent cold starts wait for one verified exact Artifact before serving", async () => {
  let reads = 0, checks = 0;
  let resolve!: (value: CompanyOSArtifact) => void;
  const pending = new Promise<CompanyOSArtifact>((done) => { resolve = done; });
  const cache = new ArtifactReferenceCache((value) => { assert.equal(value, artifact); checks++; });
  const read = async (requested: string) => { assert.equal(requested, hash); reads++; return pending; };
  const first = cache.initialize(hash, read), second = cache.initialize(hash, read);
  assert.throws(() => cache.get(hash), /verified startup/);
  resolve(artifact); await Promise.all([first, second]);
  await cache.initialize(hash, read);
  assert.equal(cache.get(hash), artifact);
  assert.equal(reads, 1); assert.equal(checks, 1);
  assert.throws(() => cache.get(other), /verified startup/);
  await assert.rejects(cache.initialize(other, read), /cannot change/);
});

test("missing or corrupt retained content never becomes a usable deployment", async () => {
  const cache = new ArtifactReferenceCache(() => { throw new Error("integrity failure"); });
  await assert.rejects(cache.initialize(hash, async () => undefined), /unavailable/);
  await assert.rejects(cache.initialize(hash, async () => ({ artifactHash: other } as CompanyOSArtifact)), /unavailable/);
  await assert.rejects(cache.initialize(hash, async () => artifact), /integrity failure/);
  assert.throws(() => cache.get(hash), /verified startup/);
  await assert.rejects(cache.initialize(other, async () => artifact), /cannot change/);
});

test("a transient startup read can retry only its original immutable reference", async () => {
  const cache = new ArtifactReferenceCache(() => {});
  await assert.rejects(cache.initialize(hash, async () => { throw new Error("database unavailable"); }), /database unavailable/);
  await cache.initialize(hash, async () => artifact);
  assert.equal(cache.get(hash), artifact);
  for (const invalid of ["latest", "", hash.toUpperCase(), "../artifact"]) {
    await assert.rejects(new ArtifactReferenceCache(() => {}).initialize(invalid, async () => artifact), /exact SHA-256/);
  }
});
