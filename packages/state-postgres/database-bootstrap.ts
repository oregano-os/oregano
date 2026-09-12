import { ensureWorkflowExecutionSchema } from "./workflow-migrate.ts";
import { createHash } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { ensureCompanyOSSchema } from "./migrate.ts";
import { postgresTimestampToIso } from "./postgres-values.ts";
import { ensureCompanyRecordsSchema } from "./records-migrate.ts";

const CONTROL_TABLES = [
  "approval_requests",
  "approvals",
  "chat_lists",
  "chat_locks",
  "chat_queue",
  "chat_subscriptions",
  "chat_values",
  "effects",
  "events",
  "published_artifacts",
  "schema_manifests",
  "workflow_runs",
  "workflow_artifacts",
  "workflow_executions",
  "workflow_thread_assignments",
] as const;

const RECORDS_TABLES_PHASE_EIGHT = [
  "access_decisions",
  "callback_replay_claims",
  "connector_echo_receipts",
  "current_objects",
  "durable_timers",
  "object_versions",
  "projection_rows",
  "source_events",
  "source_watermarks",
  "sync_leases",
  "sync_receipts",
] as const;

const RECORDS_TABLES = [...RECORDS_TABLES_PHASE_EIGHT].sort();

const RECORDS_REQUIRED_INDEXES_PHASE_EIGHT = [
  "companyos_records.records_access_decisions_principal_idx",
  "companyos_records.records_callback_replay_expiry_idx",
  "companyos_records.records_connector_echo_expiry_idx",
  "companyos_records.records_durable_timers_due_idx",
  "companyos_records.records_object_versions_object_idx",
  "companyos_records.records_projection_rows_values_idx",
  "companyos_records.records_source_events_object_idx",
  "companyos_records.records_sync_leases_due_idx",
] as const;

const RECORDS_REQUIRED_INDEXES = [...RECORDS_REQUIRED_INDEXES_PHASE_EIGHT].sort();

const RECORDS_REQUIRED_CONSTRAINTS: readonly string[] = [];

/** The retired subsystem is removed through a separate explicit migration. */
export const COMPANY_DATABASE_MANIFEST = Object.freeze({
  schemaVersion: 2,
  id: "companyos-postgres",
  version: "3.0.0",
  predecessorVersion: "2.1.0",
  migrationMode: "explicit-retirement",
  schemas: Object.freeze({
    companyos: Object.freeze({ tables: CONTROL_TABLES }),
    companyos_records: Object.freeze({ tables: Object.freeze(RECORDS_TABLES) }),
  }),
  requiredIndexes: Object.freeze([
    "companyos.chat_lists_key_sequence_idx",
    "companyos.chat_queue_thread_sequence_idx",
    ...RECORDS_REQUIRED_INDEXES,
    "companyos.workflow_executions_status_idx",
    "companyos.workflow_thread_assignments_run_idx",
  ]),
  requiredConstraints: Object.freeze([...RECORDS_REQUIRED_CONSTRAINTS,
    "companyos.workflow_execution_origin_unique", "companyos.workflow_execution_revision_check", "companyos.workflow_execution_lease_check"]),
  optionalFeatures: Object.freeze([]),
});

export const COMPANY_DATABASE_MANIFEST_DIGEST = createHash("sha256")
  .update(JSON.stringify(COMPANY_DATABASE_MANIFEST)).digest("hex");

// Frozen identities allow existing instances to upgrade without carrying old schema constructors.
export const LEGACY_COMPANY_DATABASE_MANIFEST_DIGESTS: Readonly<Record<string, string>> = Object.freeze({
  "2.1.0": "2e9d59368faaf6e69ffd333658ba9799242cf2b9ff0af25a4cbcaf6c4fb805d9",
  "2.0.0": "c18e31ab0729557a1e073f19fe2c83cdde3ff4b88cb4105e7799fdf6470cc925",
  "1.0.0": "0bbe79c8c2f5a6f370f35a7e4f09f1aa7440ded33f0548aa5778fad70aa42cc0",
  "1.1.0": "9ffe70ef8836fba556b213b2b55a68a670c347a2ecbd747daf5677f57a9271f0",
  "1.2.0": "c93be83156e9f6333fdc7ce492cee9704ae22184e99a0102d56bb3fac50d40f2",
  "1.3.0": "d8f28c995427de642dd8e923f2cc82035fe4c557d838f99177abbd961e4b17db",
  "1.4.0": "6c0b3366540c8b1c0a3d889ef8c180c32d15d4e1bb92dbbbd8b10e94ddbce16c",
  "1.5.0": "bb3dcef272ce2c33ae1a479171a648ea6e79ab01b04ca37dce998a5e0e404cea",
  "1.6.0": "b9ba518e64d39e754e917348dd67b2bad7aa200d533af8343fba0c6f3774c4b1",
  "1.7.0": "7114b3061ff5b277a931f33e08f1f6f803f2fbdd98539ffad9d487498e461167",
  "1.8.0": "af8998dfd03df7e0c68296b22a74783fbb2439186d1337d00f0413b67832872d",
  "1.9.0": "a41c86014840dc9ecec0e7fb71095605e3760b7940b2e346c08e0708cfeece9c",
});

export interface CompanyDatabaseQualificationReceipt {
  receiptVersion: 2;
  status: "qualified";
  manifestId: string;
  manifestVersion: string;
  manifestDigest: string;
  qualifiedAt: string;
  schemas: {
    companyos: { tableCount: number };
    companyosRecords: { tableCount: number };
  };
  features: Record<string, never>;
}

export interface CompanyDatabasePreparationReceipt {
  receiptVersion: 1;
  operation: "bootstrap" | "upgrade" | "verify";
  previousManifestVersions: string[];
  qualification: CompanyDatabaseQualificationReceipt;
}

export interface CompanyDatabaseStateInspection {
  schemas: { companyos: boolean; companyosRecords: boolean };
  tableCounts: { companyos: number; companyosRecords: number };
  manifests: Array<{ manifestId: string; manifestVersion: string; manifestDigest: string; appliedAt: string }>;
}

const databaseUrl = (): string => {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is not set — provision or adopt a StateStore before database preparation.");
  return value;
};

export function createNeonBranchDatabaseUrl(databaseUrlValue: string, branchHost: string): string {
  const normalizedHost = branchHost.trim().toLowerCase();
  if (!/^ep-[a-z0-9-]+(?:\.[a-z0-9-]+)+\.neon\.tech$/.test(normalizedHost) || normalizedHost.length > 253) {
    throw new Error("Neon branch database host is invalid.");
  }
  const url = new URL(databaseUrlValue);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("Company database URL must use PostgreSQL.");
  if (!url.hostname.endsWith(".neon.tech")) throw new Error("Neon branch host override requires an existing Neon database URL.");
  if (url.hostname === normalizedHost) throw new Error("Neon branch host override must differ from the bound database host.");
  url.hostname = normalizedHost;
  return url.toString();
}

export async function withNeonBranchDatabaseHost<T>(branchHost: string, operation: () => Promise<T>): Promise<T> {
  const previous = databaseUrl();
  process.env.DATABASE_URL = createNeonBranchDatabaseUrl(previous, branchHost);
  try {
    return await operation();
  } finally {
    process.env.DATABASE_URL = previous;
  }
}

const SUPPORTED_MANIFEST_DIGESTS = new Map<string, string>([
  ...Object.entries(LEGACY_COMPANY_DATABASE_MANIFEST_DIGESTS),
  [COMPANY_DATABASE_MANIFEST.version, COMPANY_DATABASE_MANIFEST_DIGEST],
]);

export function assertSupportedCompanyDatabaseManifestHistory(rows: Array<Record<string, unknown>>): string[] {
  const versions: string[] = [];
  for (const row of rows) {
    const version = String(row.manifest_version);
    const digest = String(row.manifest_digest);
    const expected = SUPPORTED_MANIFEST_DIGESTS.get(version);
    if (!expected) throw new Error(`Database preparation found unsupported manifest version '${version}'.`);
    if (digest !== expected) throw new Error(`Database preparation found conflicting content for manifest version '${version}'.`);
    versions.push(version);
  }
  return versions;
}

export async function inspectCompanyDatabaseState(): Promise<CompanyDatabaseStateInspection> {
  const sql = neon(databaseUrl());
  const relations = (await sql`select
    to_regnamespace('companyos')::text as control_schema,
    to_regnamespace('companyos_records')::text as records_schema,
    to_regclass('companyos.schema_manifests')::text as manifest_ledger`)[0] ?? {};
  const tableRows = await sql`select schemaname, count(*)::int as table_count from pg_tables
    where schemaname in ('companyos', 'companyos_records') group by schemaname order by schemaname`;
  const tableCounts = new Map(tableRows.map((row) => [String(row.schemaname), Number(row.table_count)]));
  const manifestRows = relations.manifest_ledger
    ? await sql`select manifest_id, manifest_version, manifest_digest, applied_at from companyos.schema_manifests order by applied_at, manifest_id, manifest_version`
    : [];
  return {
    schemas: { companyos: Boolean(relations.control_schema), companyosRecords: Boolean(relations.records_schema) },
    tableCounts: { companyos: tableCounts.get("companyos") ?? 0, companyosRecords: tableCounts.get("companyos_records") ?? 0 },
    manifests: manifestRows.map((row) => ({
      manifestId: String(row.manifest_id), manifestVersion: String(row.manifest_version),
      manifestDigest: String(row.manifest_digest), appliedAt: postgresTimestampToIso(row.applied_at),
    })),
  };
}

const missing = (expected: readonly string[], actual: readonly string[]): string[] =>
  expected.filter((item) => !actual.includes(item));

export function assertCompanyDatabaseQualificationReceipt(value: unknown): asserts value is CompanyDatabaseQualificationReceipt {
  if (!value || typeof value !== "object") throw new Error("Database qualification receipt must be an object.");
  const receipt = value as Partial<CompanyDatabaseQualificationReceipt>;
  if (receipt.receiptVersion !== 2 || receipt.status !== "qualified") throw new Error("Unsupported database qualification receipt; requalify the current Instance.");
  if (receipt.manifestId !== COMPANY_DATABASE_MANIFEST.id || receipt.manifestVersion !== COMPANY_DATABASE_MANIFEST.version) {
    throw new Error("Database qualification receipt does not match the maintained manifest identity.");
  }
  if (receipt.manifestDigest !== COMPANY_DATABASE_MANIFEST_DIGEST) throw new Error("Database qualification receipt has the wrong manifest digest.");
  if (!receipt.qualifiedAt || Number.isNaN(Date.parse(receipt.qualifiedAt))) throw new Error("Database qualification receipt requires an ISO timestamp.");
  if (receipt.schemas?.companyos?.tableCount !== CONTROL_TABLES.length) throw new Error("Database qualification receipt has the wrong companyos table count.");
  if (receipt.schemas?.companyosRecords?.tableCount !== RECORDS_TABLES.length) throw new Error("Database qualification receipt has the wrong companyos_records table count.");
  if (!receipt.schemas || Object.keys(receipt.schemas).sort().join(",") !== "companyos,companyosRecords") throw new Error("Database qualification receipt contains obsolete or unsupported schemas.");
  if (!receipt.features || Array.isArray(receipt.features) || typeof receipt.features !== "object" || Object.keys(receipt.features).length) throw new Error("Database qualification receipt contains unsupported features.");
}

function qualificationError(failures: string[]): Error {
  return new Error(`Company Instance database qualification failed: ${failures.join("; ")}.`);
}

export async function qualifyCompanyDatabase(): Promise<CompanyDatabaseQualificationReceipt> {
  const sql = neon(databaseUrl());
  const expectedTables = [
    ...CONTROL_TABLES.map((name) => `companyos.${name}`),
    ...RECORDS_TABLES.map((name) => `companyos_records.${name}`),
  ];
  // Compare in one read-only database snapshot. Healthy qualification returns no
  // catalog names, regardless of how many unrelated objects the Instance holds.
  const rows = await sql`with expected_tables as (
      select jsonb_array_elements_text(${JSON.stringify(expectedTables)}::jsonb) as name
    ), expected_indexes as (
      select jsonb_array_elements_text(${JSON.stringify(COMPANY_DATABASE_MANIFEST.requiredIndexes)}::jsonb) as name
    ), expected_constraints as (
      select jsonb_array_elements_text(${JSON.stringify(COMPANY_DATABASE_MANIFEST.requiredConstraints)}::jsonb) as name
    )
    select
      array(select name from expected_tables where not exists(
        select 1 from pg_tables where schemaname || '.' || tablename = name
      ) order by name) as missing_tables,
      array(select name from expected_indexes where not exists(
        select 1 from pg_indexes where schemaname || '.' || indexname = name
      ) order by name) as missing_indexes,
      array(select name from expected_constraints where not exists(
        select 1 from pg_constraint c join pg_namespace n on n.oid = c.connamespace
        where n.nspname || '.' || c.conname = name
      ) order by name) as missing_constraints,
      exists(select 1 from companyos.schema_manifests
        where manifest_id = ${COMPANY_DATABASE_MANIFEST.id}
          and manifest_version = ${COMPANY_DATABASE_MANIFEST.version}
          and manifest_digest = ${COMPANY_DATABASE_MANIFEST_DIGEST}) as manifest_matches
    `;
  const result = rows[0];
  const listFields = ["missing_tables", "missing_indexes", "missing_constraints"] as const;
  if (rows.length !== 1 || !result
    || typeof result.manifest_matches !== "boolean"
    || listFields.some((field) => !Array.isArray(result[field]) || result[field].some((value: unknown) => typeof value !== "string"))
) {
    throw qualificationError(["invalid database qualification evidence"]);
  }
  const failures: string[] = [];
  const missingTables = result.missing_tables as string[];
  const missingIndexes = result.missing_indexes as string[];
  const missingConstraints = result.missing_constraints as string[];
  if (missingTables.length > 0) failures.push(`missing tables ${missingTables.join(", ")}`);
  if (missingIndexes.length > 0) failures.push(`missing indexes ${missingIndexes.join(", ")}`);
  if (missingConstraints.length > 0) failures.push(`missing constraints ${missingConstraints.join(", ")}`);
  if (!result.manifest_matches) failures.push("missing or mismatched schema manifest ledger entry");
  if (failures.length > 0) throw qualificationError(failures);

  const receipt: CompanyDatabaseQualificationReceipt = {
    receiptVersion: 2,
    status: "qualified",
    manifestId: COMPANY_DATABASE_MANIFEST.id,
    manifestVersion: COMPANY_DATABASE_MANIFEST.version,
    manifestDigest: COMPANY_DATABASE_MANIFEST_DIGEST,
    qualifiedAt: new Date().toISOString(),
    schemas: {
      companyos: { tableCount: CONTROL_TABLES.length },
      companyosRecords: { tableCount: RECORDS_TABLES.length },
    },
    features: {},
  };
  assertCompanyDatabaseQualificationReceipt(receipt);
  return receipt;
}

export async function bootstrapCompanyDatabase(): Promise<CompanyDatabaseQualificationReceipt> {
  await ensureCompanyOSSchema();
  await ensureWorkflowExecutionSchema();
  await ensureCompanyRecordsSchema();
  const sql = neon(databaseUrl());
  const rows = await sql`insert into companyos.schema_manifests
      (manifest_id, manifest_version, manifest_digest, features)
    values (${COMPANY_DATABASE_MANIFEST.id}, ${COMPANY_DATABASE_MANIFEST.version}, ${COMPANY_DATABASE_MANIFEST_DIGEST}, '{}')
    on conflict (manifest_id, manifest_version) do update set manifest_id = excluded.manifest_id
    where companyos.schema_manifests.manifest_digest = excluded.manifest_digest
      and companyos.schema_manifests.features = excluded.features
    returning manifest_id`;
  if (!rows.length) throw new Error("Database manifest identity already exists with different content or features.");
  return qualifyCompanyDatabase();
}

export async function prepareCompanyDatabase(): Promise<CompanyDatabasePreparationReceipt> {
  const sql = neon(databaseUrl());
  const relation = (await sql`select
    to_regnamespace('companyos')::text as control_schema,
    to_regnamespace('companyos_records')::text as records_schema,
    to_regclass('companyos.schema_manifests')::text as manifest_ledger`)[0] ?? {};
  const previousManifestVersions = relation.manifest_ledger
    ? assertSupportedCompanyDatabaseManifestHistory(await sql`select manifest_version, manifest_digest from companyos.schema_manifests
        where manifest_id = ${COMPANY_DATABASE_MANIFEST.id} order by manifest_version`)
    : [];
  const hasExistingState = Boolean(relation.control_schema || relation.records_schema || relation.manifest_ledger);
  const operation = previousManifestVersions.includes(COMPANY_DATABASE_MANIFEST.version)
    ? "verify" : hasExistingState ? "upgrade" : "bootstrap";
  const qualification = operation === "verify" ? await qualifyCompanyDatabase() : await bootstrapCompanyDatabase();
  return { receiptVersion: 1, operation, previousManifestVersions, qualification };
}
