import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { sha256 } from "../../runtime/canonical.ts";
import { assertArtifactCoreCommit } from "../../runner-vercel/src/lib/artifact.ts";

const core = "a".repeat(40);
const root = resolve(import.meta.dirname, "../../..");

test("deployment requires the independently supplied source SHA to match the Artifact", () => {
  assert.doesNotThrow(() => assertArtifactCoreCommit(core, core));
  for (const source of ["b".repeat(40), "", "main", core.slice(0, 7)]) {
    assert.throws(() => assertArtifactCoreCommit(core, source), /Core mismatch|identity is missing or invalid/);
  }
});

test("hosted Artifact ingress rejects mismatched and absent live source identities", () => {
  const body = { instance: { environment: "production" }, provenance: { coreCommit: core } };
  const artifact = { ...body, artifactHash: sha256(body) };
  for (const source of [core, "b".repeat(40), ""]) {
    const env: NodeJS.ProcessEnv = { ...process.env, VERCEL_ENV: "production", VERCEL_GIT_COMMIT_SHA: source,
      COMPANYOS_ARTIFACT_GZIP_BASE64: gzipSync(JSON.stringify(artifact)).toString("base64") };
    for (const key of ["COMPANYOS_ARTIFACT_HASH", "COMPANYOS_ARTIFACT_BUNDLED", "COMPANYOS_ARTIFACT_BROTLI_BASE64"]) delete env[key];
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
      'import { loadArtifact } from "./packages/runner-vercel/src/lib/artifact.ts"; loadArtifact();'], { cwd: root, env, encoding: "utf8" });
    if (source === core) assert.equal(result.status, 0, result.stderr);
    else { assert.notEqual(result.status, 0); assert.match(result.stderr, /Core mismatch|identity is missing or invalid/); }
  }
});

test("health returns not-ready before database or provider work for an unproven Core pair", () => {
  const body = { instance: { environment: "production" }, provenance: { coreCommit: core } };
  const artifact = { ...body, artifactHash: sha256(body) };
  for (const source of ["b".repeat(40), ""]) {
    const env: NodeJS.ProcessEnv = { ...process.env, VERCEL_GIT_COMMIT_SHA: source,
      COMPANYOS_ARTIFACT_GZIP_BASE64: gzipSync(JSON.stringify(artifact)).toString("base64") };
    for (const key of ["VERCEL_ENV", "NODE_ENV", "COMPANYOS_ARTIFACT_HASH", "COMPANYOS_ARTIFACT_BUNDLED", "COMPANYOS_ARTIFACT_BROTLI_BASE64"]) delete env[key];
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { GET } from "./packages/runner-vercel/src/app/api/health/route.ts";
      const response = await GET();
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.status, "not-ready");
      assert.match(body.error, /Core mismatch|identity is missing or invalid/);
    `], { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});
