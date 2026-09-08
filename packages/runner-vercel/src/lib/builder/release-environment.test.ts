import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import type { CompanyOSArtifact } from "../../../../companyos-builder/types.ts";
import { rebindBuilderReleaseEnvironment } from "./release-environment.ts";

const previous = { instance: { id: "synthetic-production", environment: "production" }, artifactHash: "1".repeat(64),
  provenance: { coreCommit: "a".repeat(40), workspaceCommit: "b".repeat(40) } } as CompanyOSArtifact;
const next = { ...previous, artifactHash: "2".repeat(64), provenance: { ...previous.provenance, workspaceCommit: "c".repeat(40) } };
const records = {
  version: 1, environment: "production", instance_id: previous.instance.id,
  core: { repository: "synthetic/core", ref: previous.provenance.coreCommit, core_version: "0.6.0", workbench_version: "0.1.0-experimental.16", clean: true },
  workspace: { repository: "synthetic/workspace", ref: previous.provenance.workspaceCommit }, source_confirmations: { tasks: "d".repeat(64) },
  sources: [{ schema_version: 1, id: "tasks", record_type: "work-item", connection: "connections/tasks.md", resource_binding: "task-board",
    delivery: "poll", reconcile_schedule: "schedules/records.md", identity: { source_field: "id" },
    fields: [{ target: "title", source: "name", value_type: "string", required: true }], access: { read_groups: ["company"], write_roles: [] } }],
  projections: [{ schema_version: 1, id: "tasks-view", record_type: "work-item", selection: {}, fields: [{ name: "title", path: "title" }],
    freshness: { max_age_minutes: 60 }, access: { read_groups: ["company"] }, materialization: { mode: "database-view" } }],
  bindings: [{ source_id: "tasks", binding: { source_id: "tasks", resource_binding: "task-board", secret_ref: "env:TASKS_TOKEN" }, qualification: { receipt: "existing" } }],
};
const environment = { NODE_ENV: "test" as const, VERCEL_ENV: "production", VERCEL_GIT_COMMIT_SHA: previous.provenance.coreCommit,
  COMPANYOS_RECORDS_CONFIG_GZIP_BASE64: gzipSync(JSON.stringify(records)).toString("base64"), TASKS_TOKEN: "private-provider-credential" };

test("ordinary Workspace changes retain qualified Records resources while advancing their exact source pairing", () => {
  const result = rebindBuilderReleaseEnvironment({ previous, next, changedPaths: ["agents/reporter/instructions.md"], environment });
  const rebound = JSON.parse(gunzipSync(Buffer.from(result.COMPANYOS_RECORDS_CONFIG_GZIP_BASE64!, "base64")).toString());
  assert.deepEqual(rebound, { ...records, workspace: { ...records.workspace, ref: next.provenance.workspaceCommit } });
  assert.doesNotMatch(JSON.stringify(result), /private-provider-credential/);
  assert.equal(records.workspace.ref, previous.provenance.workspaceCommit);
  assert.throws(() => rebindBuilderReleaseEnvironment({ previous, next, changedPaths: ["records/tasks.yaml"], environment }), /renewed Instance qualification/);
  assert.throws(() => rebindBuilderReleaseEnvironment({ previous, next, changedPaths: [], environment: { ...environment, VERCEL_GIT_COMMIT_SHA: "f".repeat(40) } }), /exact Core/);
  assert.deepEqual(rebindBuilderReleaseEnvironment({ previous, next, changedPaths: [], environment: { NODE_ENV: "test" } }), {});
});

test("release bindings cannot cross Company Instances or use a Workspace change to upgrade Core", () => {
  assert.throws(() => rebindBuilderReleaseEnvironment({ previous, next: { ...next, instance: { ...next.instance, id: "other-company" } }, changedPaths: [], environment: { NODE_ENV: "test" } }), /cannot change/);
  assert.throws(() => rebindBuilderReleaseEnvironment({ previous, next: { ...next, provenance: { ...next.provenance, coreCommit: "f".repeat(40) } }, changedPaths: [], environment: { NODE_ENV: "test" } }), /cannot change/);
});
