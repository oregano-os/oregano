import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import test from "node:test";
import {
  authorizeCompanyRecordsProductionOperator,
  authorizeCompanyRecordsScheduler,
  companyRecordsScheduleDue,
  decodeCompanyRecordsProductionConfiguration,
  executeCompanyRecordsProduction,
  parseCompanyRecordsProductionRequest,
  planCompanyRecordsProductionMigration,
  runCompanyRecordsScheduledReconciliation,
  type CompanyRecordsProductionConfiguration,
  type CompanyRecordsProductionDependencies,
} from "./company-records-production.ts";

const coreRef = "a".repeat(40);
const workspaceRef = "b".repeat(40);
const qualificationDigest = "d".repeat(64);

const configuration = (): CompanyRecordsProductionConfiguration => ({
  version: 1,
  environment: "production",
  instance_id: "fixture-production",
  core: {
    repository: "example/oregano",
    ref: coreRef,
    core_version: "0.5.7",
    workbench_version: "0.1.0-experimental.15",
    clean: true,
  },
  workspace: { repository: "example/company-workspace", ref: workspaceRef },
  source_confirmations: { "fixture-items": "c".repeat(64) },
  sources: [{
    schema_version: 1,
    id: "fixture-items",
    record_type: "work-item",
    connection: "connections/monday.md",
    resource_binding: "fixture-board",
    delivery: "poll",
    reconcile_schedule: "schedules/records.md",
    identity: { source_field: "id" },
    fields: [
      { target: "source_id", source: "source_id", value_type: "string", required: true },
      { target: "title", source: "name", value_type: "string", required: true },
    ],
    access: { read_groups: ["fixture"], write_roles: [] },
  }],
  projections: [{
    schema_version: 1,
    id: "fixture-projection",
    record_type: "work-item",
    selection: { source_id: "fixture-items" },
    fields: [{ name: "title", path: "title" }],
    freshness: { max_age_minutes: 1_440 },
    access: { read_groups: ["fixture"] },
    materialization: { mode: "database-view" },
  }],
  bindings: [{
    source_id: "fixture-items",
    binding: {
      schema_version: 1,
      instance_id: "fixture-production",
      source_id: "fixture-items",
      resource_binding: "fixture-board",
      connector: "oregano/monday-record-source",
      connector_version: "0.3.0",
      secret_ref: "env:FIXTURE_PROVIDER_TOKEN",
      qualification: { receipt_ref: "qualification.json", digest: qualificationDigest },
      configuration: {
        api_version: "dev",
        agent_id: "700001",
        board_id: "100001",
        permission: "read",
        page_size: 100,
        max_pages: 5,
        max_objects: 1_000,
      },
    },
    qualification: {
      schema_version: 1,
      kind: "monday-external-agent-qualification",
      phase: "complete",
      evidence: {
        discovery: {
          discovery_hash: qualificationDigest,
          credentials_retained: false,
          authentication_mode: "external-agent",
          configured_agent_id: "700001",
          identity_mapping_status: "administrator-confirmed",
          identity: { externalAgentId: "800001" },
          resources: [{ id: "100001", scope: "board", permission: "read" }],
          boards: [{ id: "100001", groups: [], columns: [] }],
        },
      },
    },
  }],
  reconciliation: [{
    source_id: "fixture-items",
    time_zone: "Europe/Madrid",
    local_time: "06:00",
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    max_lateness_minutes: 180,
  }],
});

const environment = {
  VERCEL_ENV: "production",
  VERCEL_GIT_COMMIT_SHA: coreRef,
  COMPANYOS_RECORDS_ENABLED: "true",
  COMPANYOS_RECORDS_SCHEDULER_ENABLED: "true",
};
const identity = { instance_id: "fixture-production", core_ref: coreRef, workspace_ref: workspaceRef };

const dependencies = (overrides: Partial<CompanyRecordsProductionDependencies> = {}): CompanyRecordsProductionDependencies => ({
  prepareDatabase: async () => ({ operation: "upgrade", manifest: "1.9.0" }),
  readInventory: async () => { throw new Error("not reached"); },
  inspectReceipt: async () => undefined,
  inspectStatus: async () => ({ status: { available: true, current_objects: 2 }, projections: [] }),
  runSourceOperation: async ({ sourceId, runId }) => ({
    receipt: { source_id: sourceId, run_id: runId, observed: 2, inserted: 2, unchanged: 0, deleted: 0, errors: 0 },
    provider_evidence: { complete: true, objects: 2, credentials_retained: false },
  }),
  ...overrides,
});

test("production operator and scheduler authorization are independent", () => {
  const operatorSecret = "o".repeat(32);
  const cronSecret = "c".repeat(32);
  const operator = new Request("https://example.test", { headers: { authorization: `Bearer ${operatorSecret}` } });
  const scheduler = new Request("https://example.test", { headers: { authorization: `Bearer ${cronSecret}` } });
  assert.equal(authorizeCompanyRecordsProductionOperator(operator, operatorSecret), true);
  assert.equal(authorizeCompanyRecordsProductionOperator(scheduler, operatorSecret), false);
  assert.equal(authorizeCompanyRecordsScheduler(scheduler, cronSecret), true);
  assert.equal(authorizeCompanyRecordsScheduler(operator, cronSecret), false);
  assert.equal(authorizeCompanyRecordsProductionOperator(new Request("https://example.test", { headers: { authorization: "Bearer short" } }), "short"), false);
});

test("production configuration is compressed, credential-free, and schedule-bounded", () => {
  const encoded = gzipSync(Buffer.from(JSON.stringify(configuration()))).toString("base64");
  assert.equal(decodeCompanyRecordsProductionConfiguration(encoded).reconciliation?.[0]?.time_zone, "Europe/Madrid");
  const crossing = structuredClone(configuration()) as any;
  crossing.reconciliation[0] = { ...crossing.reconciliation[0], local_time: "23:00", max_lateness_minutes: 120 };
  assert.throws(() => decodeCompanyRecordsProductionConfiguration(gzipSync(Buffer.from(JSON.stringify(crossing))).toString("base64")), /service-day boundary/);
  const credential = structuredClone(configuration()) as any;
  credential.bindings[0].qualification.token = "forbidden";
  assert.throws(() => decodeCompanyRecordsProductionConfiguration(gzipSync(Buffer.from(JSON.stringify(credential))).toString("base64")), /SecretRefs/);
});

test("production request parsing and deployment identity fail closed", async () => {
  assert.deepEqual(parseCompanyRecordsProductionRequest({ action: "plan-reconcile", source_id: "fixture-items" }), { action: "plan-reconcile", source_id: "fixture-items" });
  assert.throws(() => parseCompanyRecordsProductionRequest({ action: "status", source_id: "fixture-items", token: "forbidden" }), /unsupported fields/);
  let prepared = 0;
  const deps = dependencies({ prepareDatabase: async () => { prepared += 1; return {}; } });
  await assert.rejects(executeCompanyRecordsProduction({ action: "plan-migration" }, configuration(), {
    ...environment,
    COMPANYOS_RECORDS_ADMIN_SECRET: "s".repeat(32),
    CRON_SECRET: "s".repeat(32),
  }, identity, deps), /different secrets/);
  await assert.rejects(executeCompanyRecordsProduction({ action: "plan-migration" }, configuration(), { ...environment, VERCEL_ENV: "preview" }, identity, deps), /only in a Vercel Production/);
  await assert.rejects(executeCompanyRecordsProduction({ action: "plan-migration" }, configuration(), environment, { ...identity, workspace_ref: "9".repeat(40) }, deps), /Workspace/);
  assert.equal(prepared, 0);
});

test("production migration requires enablement and its exact independent confirmation", async () => {
  const selected = configuration();
  let prepared = 0;
  const deps = dependencies({ prepareDatabase: async () => { prepared += 1; return { operation: "upgrade" }; } });
  const plan = planCompanyRecordsProductionMigration(selected);
  await assert.rejects(executeCompanyRecordsProduction({ action: "apply-migration", confirmation_hash: plan.confirmation_hash }, selected, { ...environment, COMPANYOS_RECORDS_ENABLED: "false" }, identity, deps), /disabled/);
  await assert.rejects(executeCompanyRecordsProduction({ action: "apply-migration", confirmation_hash: "0".repeat(64) }, selected, environment, identity, deps), /does not match/);
  assert.equal(prepared, 0);
  const applied = await executeCompanyRecordsProduction({ action: "apply-migration", confirmation_hash: plan.confirmation_hash }, selected, environment, identity, deps);
  assert.equal(applied.applied, true);
  assert.equal(prepared, 1);
});

test("confirmed initial synchronization is applied once and then reuses its receipt", async () => {
  const selected = configuration();
  let providerRuns = 0;
  let prior: any;
  const deps = dependencies({
    inspectReceipt: async () => prior,
    runSourceOperation: async ({ sourceId, runId }) => {
      providerRuns += 1;
      prior = { source_id: sourceId, run_id: runId, observed: 2, inserted: 2, unchanged: 0, deleted: 0, errors: 0 };
      return { receipt: prior, provider_evidence: { complete: true, objects: 2 } };
    },
  });
  const planned: any = await executeCompanyRecordsProduction({ action: "plan-sync", source_id: "fixture-items" }, selected, environment, identity, deps);
  await assert.rejects(executeCompanyRecordsProduction({ action: "apply-sync", source_id: "fixture-items", confirmation_hash: "0".repeat(64) }, selected, environment, identity, deps), /does not match/);
  const first: any = await executeCompanyRecordsProduction({ action: "apply-sync", source_id: "fixture-items", confirmation_hash: planned.plan.confirmation_hash }, selected, environment, identity, deps);
  const second: any = await executeCompanyRecordsProduction({ action: "apply-sync", source_id: "fixture-items", confirmation_hash: planned.plan.confirmation_hash }, selected, environment, identity, deps);
  assert.equal(first.applied, true);
  assert.equal(second.reused, true);
  assert.equal(providerRuns, 1);
});

test("local-time scheduled reconciliation runs once per service date", async () => {
  const selected = configuration();
  const schedule = selected.reconciliation![0]!;
  assert.deepEqual(companyRecordsScheduleDue(schedule, new Date("2026-09-02T04:05:00.000Z")), { due: true, service_date: "2026-09-02" });
  assert.equal(companyRecordsScheduleDue(schedule, new Date("2026-09-02T03:00:00.000Z")).due, false);
  let runs = 0;
  let prior: any;
  const deps = dependencies({
    inspectReceipt: async () => prior,
    runSourceOperation: async ({ sourceId, runId }) => {
      runs += 1;
      prior = { source_id: sourceId, run_id: runId, observed: 2, inserted: 0, unchanged: 2, deleted: 0, errors: 0 };
      return { receipt: prior };
    },
  });
  const first = await runCompanyRecordsScheduledReconciliation({ configuration: selected, environment, identity, now: new Date("2026-09-02T04:05:00.000Z"), dependencies: deps });
  const second = await runCompanyRecordsScheduledReconciliation({ configuration: selected, environment, identity, now: new Date("2026-09-02T04:20:00.000Z"), dependencies: deps });
  assert.equal(first.results[0]?.status, "completed");
  assert.equal(second.results[0]?.status, "already-completed");
  assert.equal(runs, 1);
});
