import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { loadInstanceBuildConfiguration } from "../../companyos-builder/instance-loader.ts";
import { buildCompanyOSArtifact } from "../../companyos-builder/build.ts";
import { sha256 } from "../../runtime/canonical.ts";
import { COMPANY_DATABASE_MANIFEST, LEGACY_COMPANY_DATABASE_MANIFEST_DIGESTS } from "../../state-postgres/database-bootstrap.ts";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("retired Instance declarations fail before compilation instead of silently losing behavior", () => {
  const directory = mkdtempSync(join(tmpdir(), "retired-instance-"));
  try {
    const path = join(directory, "instance.yaml");
    for (const value of ["[]", "null", "[{ definition: old-close, agent: old-agent }]"]) {
      writeFileSync(path, `version: 1\ninstance_id: test\nenvironment: test\nbindings: []\nsprint_runtimes: ${value}\n`);
      assert.throws(() => loadInstanceBuildConfiguration(path), /sprint_runtimes is retired.*workflow_bindings/);
    }
    const instance = { version: 1, instanceId: "test", environment: "test", bindings: [], sprintRuntimes: [] } as any;
    assert.throws(() => buildCompanyOSArtifact({ workspaceRoot: directory, instance, coreVersion: "0.5.14", workbenchVersion: "0.1.0", coreCommit: "1".repeat(40), workspaceCommit: "2".repeat(40) }), /Retired sprintRuntimes configuration/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("artifact ingress rejects active retired definitions and keeps empty historical artifacts readable", () => {
  for (const retired of [[], [{ id: "old-close" }], null, {}]) {
    const body = { instance: { environment: "preview" }, provenance: { builtAt: "2026-09-01T00:00:00Z" }, sprints: retired };
    const artifact = { ...body, artifactHash: sha256({ ...body, provenance: { builtAt: undefined } }) };
    const environment: Record<string, string | undefined> = { ...process.env, VERCEL_ENV: "preview", COMPANYOS_ARTIFACT_GZIP_BASE64: gzipSync(JSON.stringify(artifact)).toString("base64") };
    delete environment.COMPANYOS_ARTIFACT_BUNDLED;
    delete environment.COMPANYOS_ARTIFACT_BROTLI_BASE64;
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", 'import { loadArtifact } from "./packages/runner-vercel/src/lib/artifact.ts"; loadArtifact();'], { cwd: root, env: environment, encoding: "utf8" });
    if (Array.isArray(retired) && retired.length === 0) assert.equal(result.status, 0, result.stderr);
    else { assert.notEqual(result.status, 0); assert.match(result.stderr, /Artifact contains retired Sprint execution/); }
  }
});

test("retired routes and fresh-database definitions are absent while generic workers and audit history survive", () => {
  for (const path of ["packages/runtime/sprint-host.ts", "packages/runtime/sprint-orchestration.ts", "packages/companyos-builder/sprint-loader.ts", "packages/state-postgres/sprint-orchestration-store.ts", "packages/runner-vercel/src/lib/sprint-runtime.ts", "packages/runner-vercel/src/app/api/sprint/operator/route.ts", "packages/runner-vercel/src/app/api/sprint/timers/route.ts", "packages/runner-vercel/src/app/api/sprint/intents/route.ts", "packages/runner-vercel/src/app/api/stage0/qualification/route.ts"]) assert.equal(existsSync(join(root, path)), false, path);
  for (const file of ["vercel.json", "packages/runner-vercel/vercel.json"]) {
    const paths = JSON.parse(read(file)).crons.map((entry: { path: string }) => entry.path);
    assert.ok(paths.includes("/api/workflows/timers"));
    assert.ok(paths.includes("/api/workflows/steps"));
    assert.equal(paths.some((path: string) => path.startsWith("/api/sprint/")), false);
  }
  for (const file of ["packages/state-postgres/records-schema.sql", "packages/state-postgres/records-migrate.ts"]) {
    assert.doesNotMatch(read(file), /(?:create table|drop table|truncate table)[^;]*\bsprint_(?:states|events|intents)\b/i);
    assert.match(read(file), /records_source/);
  }
  assert.deepEqual(COMPANY_DATABASE_MANIFEST.schemas.companyos_records.tables.filter((table) => table.startsWith("sprint_")), []);
  assert.ok(COMPANY_DATABASE_MANIFEST.schemas.companyos.tables.includes("workflow_executions"));
  assert.equal(LEGACY_COMPANY_DATABASE_MANIFEST_DIGESTS["2.0.0"], "c18e31ab0729557a1e073f19fe2c83cdde3ff4b88cb4105e7799fdf6470cc925");
});
