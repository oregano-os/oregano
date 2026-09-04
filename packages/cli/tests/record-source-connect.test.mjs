import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  advanceRecordSourceConnect,
  initializeRecordSourceConnect,
  planRecordSourceConnect,
  readRecordSourceConnectState,
  recordSourceConnectRuntimeConfigurationValue,
  writeRecordSourceConnectState,
} from "../src/record-source-connect.mjs";
import { createVercelNeonRecordSourceProfile } from "../src/records/profiles/vercel-neon.mjs";

const core = {
  repository: "example/oregano",
  ref: "a".repeat(40),
  core_version: "0.5.7",
  workbench_version: "0.1.0-experimental.15",
  clean: true,
};
const sha256 = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

const operationPlanner = () => ({
  diagnostics: [],
  source: {
    schema_version: 1,
    id: "fixture-items",
    record_type: "work-item",
    connection: "connections/provider.md",
    resource_binding: "fixture-board",
    delivery: "poll",
    reconcile_schedule: "schedules/records.md",
    identity: { source_field: "id" },
    fields: [{ target: "title", source: "name", value_type: "string", required: true }],
    access: { read_groups: ["fixture"], write_roles: [] },
  },
  projections: [{
    schema_version: 1,
    id: "fixture-projection",
    record_type: "work-item",
    selection: { source_id: "fixture-items" },
    fields: [{ name: "title", path: "title" }],
    freshness: { max_age_minutes: 60 },
    access: { read_groups: ["fixture"] },
    materialization: { mode: "database-view" },
  }],
  binding: {
    schema_version: 1,
    instance_id: "fixture-preview",
    source_id: "fixture-items",
    resource_binding: "fixture-board",
    connector: "fixture/record-source",
    connector_version: "1.0.0",
    secret_ref: "env:FIXTURE_PROVIDER_TOKEN",
    qualification: { receipt_ref: "qualification.json", digest: "d".repeat(64) },
    configuration: { resource_id: "fixture" },
  },
  qualification: { schema_version: 1, kind: "fixture-qualification", phase: "complete" },
});

const createPlan = (root) => planRecordSourceConnect({
  workspaceRoot: join(root, "workspace"),
  sourceId: "fixture-items",
  bindingPath: join(root, "binding.yaml"),
  endpoint: "https://fixture-preview.vercel.app/api/records/rehearsal",
  runtimeScope: "fixture-team",
  runtimeProject: "fixture-project",
  statePath: join(root, "connect.json"),
  coreIdentity: core,
  workspaceIdentity: { repository: "example/company-workspace", ref: "b".repeat(40), clean: true },
  operationPlanner,
});

const initialize = (root) => {
  const planned = createPlan(root);
  assert.deepEqual(planned.diagnostics, []);
  const initialized = initializeRecordSourceConnect({ planResult: planned, confirmationHash: planned.plan.confirmation_hash });
  assert.ok(initialized.state);
  return { planned, initialized, statePath: join(root, "connect.json") };
};

const responseProfile = (calls, { state, completeStatus = true } = {}) => ({
  id: "vercel-neon",
  async request({ body }) {
    calls.push(body);
    if (body.action === "plan-migration") return { ok: true, plan: {
      kind: "company-records-preview-migration",
      environment: "preview",
      instance_id: state.configuration.instance_id,
      core: state.core,
      workspace: `${state.workspace.repository}@${state.workspace.ref}`,
      configuration_digest: state.configuration_digest,
      confirmation_hash: "1".repeat(64),
      database_secret_ref: "env:DATABASE_URL",
    } };
    if (body.action === "plan-sync") return { ok: true, plan: {
      kind: "company-record-source-operation",
      environment: "preview",
      instance_id: state.configuration.instance_id,
      core: state.core,
      source_id: "fixture-items",
      source_digest: sha256(state.configuration.sources[0]),
      projection_digests: state.configuration.projections.map((projection) => ({ id: projection.id, digest: sha256(projection) })),
      binding_digest: sha256(state.configuration.bindings[0].binding),
      rehearsal: {
        configuration_digest: state.configuration_digest,
        workspace_ref: state.workspace.ref,
        source_confirmation_hash: state.configuration.source_confirmations[state.source_id],
      },
      confirmation_hash: "2".repeat(64),
      provider_secret_ref: "env:FIXTURE_PROVIDER_TOKEN",
    } };
    if (body.action === "apply-migration") return { ok: true, applied: true, operation: "migrate", credentials_retained: false };
    if (body.action === "apply-sync") return { ok: true, applied: true, operation: "sync", source_id: "fixture-items", receipt: { observed: 2, errors: 0 }, provider_evidence: { objects: 2, complete: true }, credentials_retained: false };
    return {
      ok: true,
      status: completeStatus
        ? { available: true, watermark: "page-2", last_sync: { completed_at: "2026-09-02T10:00:00.000Z", errors: 0 }, current_objects: 2 }
        : { available: true, current_objects: 2 },
      projections: [{ available: true, projection_id: "fixture-projection", rows: 2 }],
      binding: { instance_id: "fixture-preview", connector: "fixture/record-source@1.0.0", resource_binding: "fixture-board" },
    };
  },
});

test("connect plan freezes exact identities and initialization writes credential-free mode-0600 state", () => {
  const root = mkdtempSync(join(tmpdir(), "companyos-record-source-connect-"));
  try {
    const { planned, statePath } = initialize(root);
    assert.equal(planned.plan.profile, "vercel-neon");
    assert.equal(planned.plan.core.ref, "a".repeat(40));
    assert.equal(planned.plan.workspace.ref, "b".repeat(40));
    assert.equal(planned.plan.source_id, "fixture-items");
    assert.match(recordSourceConnectRuntimeConfigurationValue(readRecordSourceConnectState(statePath)), /^[A-Za-z0-9+/=]+$/);
    assert.equal(statSync(statePath).mode & 0o077, 0);
    const source = readFileSync(statePath, "utf8");
    assert.equal(source.includes("fixture-rehearsal-secret-value"), false);
    assert.equal(source.includes("postgresql://"), false);
    const duplicate = initializeRecordSourceConnect({ planResult: planned, confirmationHash: planned.plan.confirmation_hash });
    assert.equal(duplicate.state, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("connect planning rejects state inside the Company Workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "companyos-record-source-connect-"));
  try {
    const planned = planRecordSourceConnect({
      workspaceRoot: join(root, "workspace"),
      sourceId: "fixture-items",
      bindingPath: join(root, "binding.yaml"),
      endpoint: "https://fixture-preview.vercel.app/api/records/rehearsal",
      runtimeScope: "fixture-team",
      runtimeProject: "fixture-project",
      statePath: join(root, "workspace", "state.json"),
      coreIdentity: core,
      workspaceIdentity: { repository: "example/company-workspace", ref: "b".repeat(40), clean: true },
      operationPlanner,
    });
    assert.equal(planned.diagnostics.some((entry) => entry.code === "REC038"), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("connect resume plans first and applies only both exact confirmations", async () => {
  const root = mkdtempSync(join(tmpdir(), "companyos-record-source-connect-"));
  try {
    const { statePath } = initialize(root);
    const calls = [];
    const profile = responseProfile(calls, { state: readRecordSourceConnectState(statePath) });
    const planned = await advanceRecordSourceConnect({ statePath, profile });
    assert.equal(planned.status, "waiting-for-confirmation");
    assert.deepEqual(calls.map((call) => call.action), ["plan-migration", "plan-sync"]);
    const waiting = await advanceRecordSourceConnect({ statePath, profile });
    assert.equal(waiting.status, "waiting-for-confirmation");
    assert.equal(calls.length, 2);
    await assert.rejects(advanceRecordSourceConnect({ statePath, profile, migrationConfirmation: "9".repeat(64), syncConfirmation: "2".repeat(64) }), /does not match/);
    assert.equal(calls.length, 2);
    const complete = await advanceRecordSourceConnect({ statePath, profile, migrationConfirmation: "1".repeat(64), syncConfirmation: "2".repeat(64) });
    assert.equal(complete.status, "complete");
    assert.equal(complete.state.phase, "complete");
    assert.deepEqual(calls.map((call) => call.action), ["plan-migration", "plan-sync", "apply-migration", "apply-sync", "status"]);
    assert.equal(complete.cleanup.production_activated, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("connect remains resumable when status cannot prove a complete watermark and receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "companyos-record-source-connect-"));
  try {
    const { statePath } = initialize(root);
    const profile = responseProfile([], { state: readRecordSourceConnectState(statePath), completeStatus: false });
    await advanceRecordSourceConnect({ statePath, profile });
    await assert.rejects(
      advanceRecordSourceConnect({ statePath, profile, migrationConfirmation: "1".repeat(64), syncConfirmation: "2".repeat(64) }),
      /does not prove a complete successful source synchronization/,
    );
    assert.equal(readRecordSourceConnectState(statePath).phase, "sync-applied");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("connect rejects a remote plan for a different frozen configuration before any apply", async () => {
  const root = mkdtempSync(join(tmpdir(), "companyos-record-source-connect-"));
  try {
    const { statePath } = initialize(root);
    const state = readRecordSourceConnectState(statePath);
    const calls = [];
    const valid = responseProfile(calls, { state });
    const profile = {
      ...valid,
      async request(input) {
        const response = await valid.request(input);
        if (input.body.action === "plan-migration") response.plan.configuration_digest = "9".repeat(64);
        return response;
      },
    };
    await assert.rejects(advanceRecordSourceConnect({ statePath, profile }), /does not match the frozen configuration/);
    assert.deepEqual(calls.map((call) => call.action), ["plan-migration"]);
    assert.equal(readRecordSourceConnectState(statePath).phase, "configured");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("connect state rejects credentials and the Vercel profile passes its bearer only through subprocess stdin", async () => {
  const root = mkdtempSync(join(tmpdir(), "companyos-record-source-connect-"));
  try {
    assert.throws(() => writeRecordSourceConnectState(join(root, "unsafe.json"), { schema_version: 1, kind: "company-record-source-connect", api_token: "not-even-a-real-token" }), /sensitive state field/);
    const calls = [];
    const profile = createVercelNeonRecordSourceProfile({
      environment: { COMPANYOS_RECORDS_REHEARSAL_SECRET: "fixture-rehearsal-secret-value-long" },
      vercelCli: "/fixture/vercel",
      executor: {
        run(file, args, options) {
          calls.push({ file, args, input: options.input });
          return { status: 0, stdout: '{"ok":true,"plan":{"confirmation_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}', stderr: "" };
        },
      },
    });
    await profile.request({ endpoint: "https://fixture.vercel.app/api/records/rehearsal", runtimeScope: "fixture", body: { action: "plan-migration" } });
    assert.equal(calls[0].file, "/fixture/vercel");
    assert.deepEqual(calls[0].args.slice(0, 4), ["curl", "/api/records/rehearsal", "--deployment", "https://fixture.vercel.app"]);
    assert.equal(calls[0].args.includes("--scope"), false);
    assert.deepEqual(calls[0].args.slice(-3), ["--", "--config", "-"]);
    assert.equal(calls[0].args.join(" ").includes("fixture-rehearsal-secret"), false);
    assert.equal(calls[0].input.includes("fixture-rehearsal-secret-value-long"), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
