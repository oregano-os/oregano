import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { neon, neonConfig } from "@neondatabase/serverless";
import {
  bootstrapCompanyDatabase, qualifyCompanyDatabase,
  createNeonBranchDatabaseUrl, assertSupportedCompanyDatabaseManifestHistory,
  assertCompanyDatabaseQualificationReceipt, COMPANY_DATABASE_MANIFEST,
  COMPANY_DATABASE_MANIFEST_DIGEST, LEGACY_COMPANY_DATABASE_MANIFEST_DIGESTS,
} from "../../state-postgres/database-bootstrap.ts";

const qualification = () => ({
  receiptVersion: 2, status: "qualified", manifestId: COMPANY_DATABASE_MANIFEST.id,
  manifestVersion: COMPANY_DATABASE_MANIFEST.version, manifestDigest: COMPANY_DATABASE_MANIFEST_DIGEST,
  qualifiedAt: "2026-09-11T12:00:00.000Z",
  schemas: {
    companyos: { tableCount: COMPANY_DATABASE_MANIFEST.schemas.companyos.tables.length },
    companyosRecords: { tableCount: COMPANY_DATABASE_MANIFEST.schemas.companyos_records.tables.length },
  }, features: {},
});

test("database contract retains execution and Records and requires no retired schema or vector service", () => {
  assert.equal(COMPANY_DATABASE_MANIFEST.version, "3.0.0");
  assert.deepEqual(Object.keys(COMPANY_DATABASE_MANIFEST.schemas).sort(), ["companyos", "companyos_records"]);
  assert.equal(COMPANY_DATABASE_MANIFEST.schemas.companyos.tables.length, 15);
  assert.equal(COMPANY_DATABASE_MANIFEST.schemas.companyos_records.tables.length, 11);
  assert.deepEqual(COMPANY_DATABASE_MANIFEST.optionalFeatures, []);
  assert.equal(createHash("sha256").update(JSON.stringify(COMPANY_DATABASE_MANIFEST)).digest("hex"), COMPANY_DATABASE_MANIFEST_DIGEST);
});

test("qualification rejects obsolete receipts and retained-schema identity or count drift", () => {
  assert.doesNotThrow(() => assertCompanyDatabaseQualificationReceipt(qualification()));
  for (const invalid of [
    { ...qualification(), receiptVersion: 1 },
    { ...qualification(), manifestDigest: "0".repeat(64) },
    { ...qualification(), qualifiedAt: "invalid" },
    { ...qualification(), features: { vector: false } },
    { ...qualification(), schemas: { ...qualification().schemas, companyosKnowledge: { tableCount: 67 } } },
    { ...qualification(), schemas: { ...qualification().schemas, companyosRecords: { tableCount: 0 } } },
  ]) assert.throws(() => assertCompanyDatabaseQualificationReceipt(invalid));
});

test("upgrades recognize frozen historical manifest identities without accepting modified or unknown history", () => {
  const rows = Object.entries(LEGACY_COMPANY_DATABASE_MANIFEST_DIGESTS).map(([manifest_version, manifest_digest]) => ({ manifest_version, manifest_digest }));
  assert.equal(assertSupportedCompanyDatabaseManifestHistory(rows).length, 12);
  assert.throws(() => assertSupportedCompanyDatabaseManifestHistory([{ ...rows[0], manifest_digest: "0".repeat(64) }]), /conflicting/);
  assert.throws(() => assertSupportedCompanyDatabaseManifestHistory([{ manifest_version: "9.0.0", manifest_digest: "0".repeat(64) }]), /unsupported/);
});

test("branch isolation changes only a validated Neon host and preserves credentials and database", () => {
  const url = "postgresql://test_user:test_password@ep-origin.example.neon.tech/test_database?sslmode=require";
  const result = new URL(createNeonBranchDatabaseUrl(url, "ep-isolated.example.neon.tech"));
  assert.equal(result.hostname, "ep-isolated.example.neon.tech");
  assert.equal(result.username, "test_user");
  assert.equal(result.pathname, "/test_database");
  assert.equal(result.searchParams.get("sslmode"), "require");
  for (const host of ["ep-origin.example.neon.tech", "evil.example", "ep-test.neon.tech/other"]) {
    assert.throws(() => createNeonBranchDatabaseUrl(url, host));
  }
});

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("Postgres bootstrap is idempotent and qualification reads the same manifest", { skip: !runDatabaseTests }, async () => {
  const first = await bootstrapCompanyDatabase();
  const second = await bootstrapCompanyDatabase();
  const verified = await qualifyCompanyDatabase();
  for (const receipt of [first, second, verified]) assertCompanyDatabaseQualificationReceipt(receipt);
  const stable = (receipt: typeof first) => ({ ...receipt, qualifiedAt: undefined });
  assert.deepEqual(stable(second), stable(first));
  assert.deepEqual(stable(verified), stable(first));
});

test("retirement upgrades a known manifest without deleting historical domain audit rows", { skip: !runDatabaseTests }, async () => {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL!);
  await bootstrapCompanyDatabase();
  // A minimal historical audit relation is enough to detect destructive cleanup.
  await sql`create table if not exists companyos_records.sprint_events (id text primary key, payload jsonb not null)`;
  await sql`insert into companyos_records.sprint_events (id, payload) values ('retained-audit-fixture', '{"historical":true}'::jsonb) on conflict (id) do nothing`;
  await sql`insert into companyos.schema_manifests (manifest_id, manifest_version, manifest_digest, features) values (${COMPANY_DATABASE_MANIFEST.id}, ${"2.1.0"}, ${LEGACY_COMPANY_DATABASE_MANIFEST_DIGESTS["2.1.0"]}, '{"vector":false}'::jsonb) on conflict do nothing`;
  const upgraded = await bootstrapCompanyDatabase();
  assert.equal(upgraded.manifestVersion, "3.0.0");
  assertCompanyDatabaseQualificationReceipt(await qualifyCompanyDatabase());
  const rows = await sql`select payload from companyos_records.sprint_events where id = 'retained-audit-fixture'`;
  assert.deepEqual(rows[0]?.payload, { historical: true });
});

test("Postgres qualification returns compact evidence and rejects every maintained drift category", { skip: !runDatabaseTests }, async (t) => {
  await bootstrapCompanyDatabase();
  const sql = neon(process.env.DATABASE_URL!);
  const previousFetch = neonConfig.fetchFunction;
  const fetch = previousFetch ?? globalThis.fetch;
  let calls = 0;
  let bytes = 0;
  neonConfig.fetchFunction = async (...args: Parameters<typeof globalThis.fetch>) => {
    const response = await fetch(...args);
    calls += 1;
    bytes += Buffer.byteLength(await response.clone().text());
    return response;
  };
  try {
    // The unbounded catalog responses, measured through the same isolated HTTP transport.
    await sql`select schemaname, tablename from pg_tables
      where schemaname in ('companyos', 'companyos_records') order by schemaname, tablename`;
    await sql`select schemaname, indexname from pg_indexes
      where schemaname in ('companyos', 'companyos_records') order by schemaname, indexname`;
    await sql`select n.nspname as schema_name, c.conname from pg_constraint c join pg_namespace n on n.oid = c.connamespace
      where n.nspname in ('companyos', 'companyos_records') order by n.nspname, c.conname`;
    await sql`select manifest_digest from companyos.schema_manifests
      where manifest_id = ${COMPANY_DATABASE_MANIFEST.id} and manifest_version = ${COMPANY_DATABASE_MANIFEST.version} limit 1`;
    const legacyBytes = bytes;
    assert.equal(calls, 4);
    calls = 0; bytes = 0;
    const qualified = await qualifyCompanyDatabase();
    const compactBytes = bytes;
    assert.equal(calls, 1);
    assert.ok(compactBytes < legacyBytes / 10, "healthy qualification must not export the catalog");
    t.diagnostic(`Qualification HTTP response bodies: 4 -> 1 requests; ${legacyBytes} -> ${compactBytes} bytes (isolated PostgreSQL bridge)`);

    await sql`create table companyos.traffic_fixture (id integer primary key, note text check (length(note) > 0))`;
    try {
      calls = 0; bytes = 0;
      await qualifyCompanyDatabase();
      assert.equal(calls, 1);
      assert.equal(bytes, compactBytes, "unrelated tables, indexes and constraints do not grow successful evidence");
    } finally {
      await sql`drop table companyos.traffic_fixture`;
    }
  } finally {
    neonConfig.fetchFunction = previousFetch;
  }

  // Each mutation is restored before the next assertion, in the isolated test database.
  const cases = [
    {
      change: () => sql`alter table companyos.workflow_thread_assignments rename to traffic_workflow_thread_assignments`,
      restore: () => sql`alter table companyos.traffic_workflow_thread_assignments rename to workflow_thread_assignments`,
      error: /missing tables companyos\.workflow_thread_assignments/,
    },
    {
      change: () => sql`alter index companyos.workflow_thread_assignments_run_idx rename to traffic_events_idx`,
      restore: () => sql`alter index companyos.traffic_events_idx rename to workflow_thread_assignments_run_idx`,
      error: /missing indexes companyos\.workflow_thread_assignments_run_idx/,
    },
    {
      change: () => sql`alter table companyos.workflow_executions rename constraint workflow_execution_origin_unique to traffic_event_fk`,
      restore: () => sql`alter table companyos.workflow_executions rename constraint traffic_event_fk to workflow_execution_origin_unique`,
      error: /missing constraints companyos\.workflow_execution_origin_unique/,
    },
    {
      change: () => sql`update companyos.schema_manifests set manifest_digest = ${"0".repeat(64)}
        where manifest_id = ${COMPANY_DATABASE_MANIFEST.id} and manifest_version = ${COMPANY_DATABASE_MANIFEST.version}`,
      restore: () => sql`update companyos.schema_manifests set manifest_digest = ${COMPANY_DATABASE_MANIFEST_DIGEST}
        where manifest_id = ${COMPANY_DATABASE_MANIFEST.id} and manifest_version = ${COMPANY_DATABASE_MANIFEST.version}`,
      error: /missing or mismatched schema manifest ledger entry/,
    },
    {
      change: () => sql`update companyos.schema_manifests set manifest_version = 'traffic-fixture'
        where manifest_id = ${COMPANY_DATABASE_MANIFEST.id} and manifest_version = ${COMPANY_DATABASE_MANIFEST.version}`,
      restore: () => sql`update companyos.schema_manifests set manifest_version = ${COMPANY_DATABASE_MANIFEST.version}
        where manifest_id = ${COMPANY_DATABASE_MANIFEST.id} and manifest_version = 'traffic-fixture'`,
      error: /missing or mismatched schema manifest ledger entry/,
    },
  ];
  for (const fixture of cases) {
    await fixture.change();
    try {
      await assert.rejects(qualifyCompanyDatabase(), fixture.error);
    } finally {
      await fixture.restore();
    }
    await qualifyCompanyDatabase();
  }
});
