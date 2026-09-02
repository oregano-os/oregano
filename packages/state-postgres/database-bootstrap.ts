import { createHash } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { BASE_BRAIN_PAGE_TYPES } from "../knowledge/brain-contracts.ts";
import { ensureCompanyKnowledgeSchema } from "./knowledge-migrate.ts";
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
] as const;

const FOUNDATION_KNOWLEDGE_TABLES = [
  "claim_consolidations",
  "claim_evidence",
  "claim_relations",
  "claim_resolution_proposals",
  "claims",
  "documents",
  "entity_identities",
  "entity_identity_members",
  "entity_identity_proposals",
  "fragments",
  "graph_edges",
  "holders",
  "index_runs",
  "observation_deletion_requests",
  "observation_events",
  "observation_legal_holds",
  "page_type_aliases",
  "page_type_registry",
  "page_versions",
  "pages",
  "review_candidates",
  "runtime_observations",
  "snapshots",
  "source_inventory",
  "source_object_versions",
  "source_receipts",
  "sources",
] as const;

const PHASE_ONE_KNOWLEDGE_TABLES = [
  "acl_entries",
  "acl_policies",
  "brain_export_ledger",
  "calibration_profiles",
  "decision_receipts",
  "external_principals",
  "extraction_runs",
  "knowledge_edges",
  "merge_ledger",
  "promotion_candidates",
  "raw_assets",
  "session_corpus",
  "session_cursors",
  "sessions",
  "syntheses",
  "synthesis_versions",
  "timeline_events",
] as const;

const PHASE_TWO_KNOWLEDGE_TABLES = [
  "access_decision_events",
  "principal_group_members",
  "principal_groups",
] as const;

const PHASE_THREE_KNOWLEDGE_TABLES = [
  "knowledge_change_stream",
  "source_acl_snapshots",
  "source_events",
  "source_lifecycle_requests",
  "source_pipeline_receipts",
  "source_watermarks",
  "session_lifecycle_receipts",
] as const;

const PHASE_FOUR_KNOWLEDGE_TABLES = [
  "source_sync_leases",
] as const;

const PHASE_FIVE_KNOWLEDGE_TABLES = [
  "claim_grading_requests",
  "claim_pair_proposals",
  "compounding_leases",
  "compounding_receipts",
] as const;

const PHASE_SIX_KNOWLEDGE_TABLES = [
  "model_execution_ledger",
  "model_spend_reservations",
  "model_task_results",
] as const;

const PHASE_SEVEN_KNOWLEDGE_TABLES = [
  "knowledge_benchmark_runs",
  "knowledge_productization_receipts",
  "knowledge_shadow_comparisons",
  "retrieval_projection_runs",
  "retrieval_units",
] as const;

const PHASE_ONE_MANIFEST_KNOWLEDGE_TABLES = [...FOUNDATION_KNOWLEDGE_TABLES, ...PHASE_ONE_KNOWLEDGE_TABLES].sort();
const PHASE_TWO_MANIFEST_KNOWLEDGE_TABLES = [...PHASE_ONE_MANIFEST_KNOWLEDGE_TABLES, ...PHASE_TWO_KNOWLEDGE_TABLES].sort();
const PHASE_THREE_MANIFEST_KNOWLEDGE_TABLES = [...PHASE_TWO_MANIFEST_KNOWLEDGE_TABLES, ...PHASE_THREE_KNOWLEDGE_TABLES].sort();
const PHASE_FOUR_MANIFEST_KNOWLEDGE_TABLES = [...PHASE_THREE_MANIFEST_KNOWLEDGE_TABLES, ...PHASE_FOUR_KNOWLEDGE_TABLES].sort();
const PHASE_FIVE_MANIFEST_KNOWLEDGE_TABLES = [...PHASE_FOUR_MANIFEST_KNOWLEDGE_TABLES, ...PHASE_FIVE_KNOWLEDGE_TABLES].sort();
const PHASE_SIX_MANIFEST_KNOWLEDGE_TABLES = [...PHASE_FIVE_MANIFEST_KNOWLEDGE_TABLES, ...PHASE_SIX_KNOWLEDGE_TABLES].sort();
const KNOWLEDGE_TABLES = [...PHASE_SIX_MANIFEST_KNOWLEDGE_TABLES, ...PHASE_SEVEN_KNOWLEDGE_TABLES].sort();

const PHASE_TWO_REQUIRED_INDEXES = [
  "companyos.chat_lists_key_sequence_idx",
  "companyos.chat_queue_thread_sequence_idx",
  "companyos_knowledge.knowledge_claims_current_idx",
  "companyos_knowledge.knowledge_claims_holder_idx",
  "companyos_knowledge.knowledge_acl_entries_subject_idx",
  "companyos_knowledge.knowledge_brain_export_ledger_status_idx",
  "companyos_knowledge.knowledge_entity_members_entity_idx",
  "companyos_knowledge.knowledge_entity_proposals_queue_idx",
  "companyos_knowledge.knowledge_edges_from_idx",
  "companyos_knowledge.knowledge_edges_to_idx",
  "companyos_knowledge.knowledge_external_principals_canonical_idx",
  "companyos_knowledge.knowledge_extraction_runs_status_idx",
  "companyos_knowledge.knowledge_fragments_search_idx",
  "companyos_knowledge.knowledge_graph_edges_to_idx",
  "companyos_knowledge.knowledge_merge_ledger_status_idx",
  "companyos_knowledge.knowledge_observations_status_idx",
  "companyos_knowledge.knowledge_one_active_snapshot_idx",
  "companyos_knowledge.knowledge_page_versions_observed_idx",
  "companyos_knowledge.knowledge_promotion_candidates_queue_idx",
  "companyos_knowledge.knowledge_raw_assets_source_idx",
  "companyos_knowledge.knowledge_session_corpus_expiry_idx",
  "companyos_knowledge.knowledge_session_cursors_consumer_idx",
  "companyos_knowledge.knowledge_source_receipts_source_idx",
  "companyos_knowledge.knowledge_synthesis_versions_created_idx",
  "companyos_knowledge.knowledge_timeline_subject_idx",
  "companyos_knowledge.knowledge_access_decisions_outcome_idx",
  "companyos_knowledge.knowledge_access_decisions_principal_idx",
  "companyos_knowledge.knowledge_principal_group_members_principal_idx",
] as const;

const PHASE_THREE_REQUIRED_INDEXES = [
  ...PHASE_TWO_REQUIRED_INDEXES,
  "companyos_knowledge.knowledge_change_stream_genesis_idx",
  "companyos_knowledge.knowledge_change_stream_previous_idx",
  "companyos_knowledge.knowledge_change_stream_source_idx",
  "companyos_knowledge.knowledge_source_acl_object_idx",
  "companyos_knowledge.knowledge_source_events_object_idx",
  "companyos_knowledge.knowledge_source_events_queue_idx",
  "companyos_knowledge.knowledge_source_lifecycle_due_idx",
  "companyos_knowledge.knowledge_source_pipeline_receipts_source_idx",
  "companyos_knowledge.knowledge_session_lifecycle_receipts_session_idx",
] as const;

const PHASE_FOUR_REQUIRED_INDEXES = [
  ...PHASE_THREE_REQUIRED_INDEXES,
  "companyos_knowledge.knowledge_source_sync_leases_due_idx",
] as const;

const PHASE_FIVE_REQUIRED_INDEXES = [
  ...PHASE_FOUR_REQUIRED_INDEXES,
  "companyos_knowledge.knowledge_claim_grading_requests_queue_idx",
  "companyos_knowledge.knowledge_claim_pair_proposals_queue_idx",
  "companyos_knowledge.knowledge_compounding_leases_due_idx",
  "companyos_knowledge.knowledge_compounding_receipts_cycle_idx",
] as const;

const PHASE_SIX_REQUIRED_INDEXES = [
  ...PHASE_FIVE_REQUIRED_INDEXES,
  "companyos_knowledge.knowledge_model_execution_ledger_spend_idx",
  "companyos_knowledge.knowledge_model_spend_reservations_budget_idx",
  "companyos_knowledge.knowledge_model_task_results_policy_idx",
] as const;

const REQUIRED_INDEXES = [
  ...PHASE_SIX_REQUIRED_INDEXES,
  "companyos_knowledge.knowledge_benchmark_runs_suite_idx",
  "companyos_knowledge.knowledge_one_active_retrieval_projection_idx",
  "companyos_knowledge.knowledge_productization_receipts_kind_idx",
  "companyos_knowledge.knowledge_retrieval_projection_status_idx",
  "companyos_knowledge.knowledge_retrieval_units_parent_idx",
  "companyos_knowledge.knowledge_retrieval_units_policy_idx",
  "companyos_knowledge.knowledge_retrieval_units_search_idx",
  "companyos_knowledge.knowledge_shadow_comparisons_status_idx",
] as const;

const PHASE_TWO_REQUIRED_CONSTRAINTS = [
  "companyos_knowledge.knowledge_claim_evidence_page_version_fk",
  "companyos_knowledge.knowledge_claim_evidence_access_policy_fk",
  "companyos_knowledge.knowledge_pages_current_version_fk",
  "companyos_knowledge.knowledge_pages_current_version_page_fk",
  "companyos_knowledge.knowledge_raw_assets_access_policy_fk",
  "companyos_knowledge.knowledge_source_objects_access_policy_fk",
  "companyos_knowledge.knowledge_sources_access_policy_fk",
  "companyos_knowledge.knowledge_syntheses_current_version_fk",
  "companyos_knowledge.knowledge_syntheses_current_version_parent_fk",
] as const;

const REQUIRED_CONSTRAINTS = [
  ...PHASE_TWO_REQUIRED_CONSTRAINTS,
  "companyos_knowledge.knowledge_source_events_event_fk",
  "companyos_knowledge.knowledge_source_object_payload_state_check",
] as const;

const CORE_PAGE_TYPE_KEYS = BASE_BRAIN_PAGE_TYPES.map((entry) => entry.key).sort();

const RECORDS_TABLES = [
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

const RECORDS_REQUIRED_INDEXES = [
  "companyos_records.records_access_decisions_principal_idx",
  "companyos_records.records_callback_replay_expiry_idx",
  "companyos_records.records_connector_echo_expiry_idx",
  "companyos_records.records_durable_timers_due_idx",
  "companyos_records.records_object_versions_object_idx",
  "companyos_records.records_projection_rows_values_idx",
  "companyos_records.records_source_events_object_idx",
  "companyos_records.records_sync_leases_due_idx",
] as const;

export const COMPANY_DATABASE_MANIFEST_V1 = Object.freeze({
  schemaVersion: 1,
  id: "companyos-postgres",
  version: "1.0.0",
  schemas: Object.freeze({
    companyos: Object.freeze({ tables: CONTROL_TABLES }),
    companyos_knowledge: Object.freeze({ tables: FOUNDATION_KNOWLEDGE_TABLES }),
  }),
  requiredIndexes: Object.freeze([
    "companyos.chat_lists_key_sequence_idx",
    "companyos.chat_queue_thread_sequence_idx",
    "companyos_knowledge.knowledge_claims_current_idx",
    "companyos_knowledge.knowledge_claims_holder_idx",
    "companyos_knowledge.knowledge_entity_members_entity_idx",
    "companyos_knowledge.knowledge_entity_proposals_queue_idx",
    "companyos_knowledge.knowledge_fragments_search_idx",
    "companyos_knowledge.knowledge_graph_edges_to_idx",
    "companyos_knowledge.knowledge_observations_status_idx",
    "companyos_knowledge.knowledge_one_active_snapshot_idx",
    "companyos_knowledge.knowledge_page_versions_observed_idx",
    "companyos_knowledge.knowledge_source_receipts_source_idx",
  ]),
  requiredConstraints: Object.freeze([
    "companyos_knowledge.knowledge_claim_evidence_page_version_fk",
    "companyos_knowledge.knowledge_pages_current_version_fk",
    "companyos_knowledge.knowledge_pages_current_version_page_fk",
  ]),
  corePageTypes: Object.freeze(CORE_PAGE_TYPE_KEYS),
  optionalFeatures: Object.freeze(["vector"]),
});

export const COMPANY_DATABASE_MANIFEST_V1_DIGEST = createHash("sha256")
  .update(JSON.stringify(COMPANY_DATABASE_MANIFEST_V1))
  .digest("hex");

export const COMPANY_DATABASE_MANIFEST_PHASE_ONE = Object.freeze({
  schemaVersion: 1,
  id: "companyos-postgres",
  version: "1.1.0",
  predecessorVersion: COMPANY_DATABASE_MANIFEST_V1.version,
  migrationMode: "additive",
  schemas: Object.freeze({
    companyos: Object.freeze({ tables: CONTROL_TABLES }),
    companyos_knowledge: Object.freeze({ tables: Object.freeze(PHASE_ONE_MANIFEST_KNOWLEDGE_TABLES) }),
  }),
  requiredIndexes: Object.freeze(PHASE_TWO_REQUIRED_INDEXES.filter((index) => !index.includes("access_decisions") && !index.includes("principal_group_members"))),
  requiredConstraints: PHASE_TWO_REQUIRED_CONSTRAINTS,
  corePageTypes: Object.freeze(CORE_PAGE_TYPE_KEYS),
  optionalFeatures: Object.freeze(["vector"]),
});

export const COMPANY_DATABASE_MANIFEST_PHASE_ONE_DIGEST = createHash("sha256")
  .update(JSON.stringify(COMPANY_DATABASE_MANIFEST_PHASE_ONE))
  .digest("hex");

export const COMPANY_DATABASE_MANIFEST_PHASE_TWO = Object.freeze({
  schemaVersion: 1,
  id: "companyos-postgres",
  version: "1.2.0",
  predecessorVersion: COMPANY_DATABASE_MANIFEST_PHASE_ONE.version,
  migrationMode: "additive",
  schemas: Object.freeze({
    companyos: Object.freeze({ tables: CONTROL_TABLES }),
    companyos_knowledge: Object.freeze({ tables: Object.freeze(PHASE_TWO_MANIFEST_KNOWLEDGE_TABLES) }),
  }),
  requiredIndexes: PHASE_TWO_REQUIRED_INDEXES,
  requiredConstraints: PHASE_TWO_REQUIRED_CONSTRAINTS,
  corePageTypes: Object.freeze(CORE_PAGE_TYPE_KEYS),
  optionalFeatures: Object.freeze(["vector"]),
});

export const COMPANY_DATABASE_MANIFEST_PHASE_TWO_DIGEST = createHash("sha256")
  .update(JSON.stringify(COMPANY_DATABASE_MANIFEST_PHASE_TWO))
  .digest("hex");

export const COMPANY_DATABASE_MANIFEST_PHASE_THREE = Object.freeze({
  schemaVersion: 1,
  id: "companyos-postgres",
  version: "1.3.0",
  predecessorVersion: COMPANY_DATABASE_MANIFEST_PHASE_TWO.version,
  migrationMode: "additive",
  schemas: Object.freeze({
    companyos: Object.freeze({ tables: CONTROL_TABLES }),
    companyos_knowledge: Object.freeze({ tables: Object.freeze(PHASE_THREE_MANIFEST_KNOWLEDGE_TABLES) }),
  }),
  requiredIndexes: PHASE_THREE_REQUIRED_INDEXES,
  requiredConstraints: REQUIRED_CONSTRAINTS,
  corePageTypes: Object.freeze(CORE_PAGE_TYPE_KEYS),
  optionalFeatures: Object.freeze(["vector"]),
});

export const COMPANY_DATABASE_MANIFEST_PHASE_THREE_DIGEST = createHash("sha256")
  .update(JSON.stringify(COMPANY_DATABASE_MANIFEST_PHASE_THREE))
  .digest("hex");

export const COMPANY_DATABASE_MANIFEST_PHASE_FOUR = Object.freeze({
  schemaVersion: 1,
  id: "companyos-postgres",
  version: "1.4.0",
  predecessorVersion: COMPANY_DATABASE_MANIFEST_PHASE_THREE.version,
  migrationMode: "additive",
  schemas: Object.freeze({
    companyos: Object.freeze({ tables: CONTROL_TABLES }),
    companyos_knowledge: Object.freeze({ tables: Object.freeze(PHASE_FOUR_MANIFEST_KNOWLEDGE_TABLES) }),
  }),
  requiredIndexes: PHASE_FOUR_REQUIRED_INDEXES,
  requiredConstraints: REQUIRED_CONSTRAINTS,
  corePageTypes: Object.freeze(CORE_PAGE_TYPE_KEYS),
  optionalFeatures: Object.freeze(["vector"]),
});

export const COMPANY_DATABASE_MANIFEST_PHASE_FOUR_DIGEST = createHash("sha256")
  .update(JSON.stringify(COMPANY_DATABASE_MANIFEST_PHASE_FOUR))
  .digest("hex");

export const COMPANY_DATABASE_MANIFEST_PHASE_FIVE = Object.freeze({
  schemaVersion: 1,
  id: "companyos-postgres",
  version: "1.5.0",
  predecessorVersion: COMPANY_DATABASE_MANIFEST_PHASE_FOUR.version,
  migrationMode: "additive",
  schemas: Object.freeze({
    companyos: Object.freeze({ tables: CONTROL_TABLES }),
    companyos_knowledge: Object.freeze({ tables: Object.freeze(PHASE_FIVE_MANIFEST_KNOWLEDGE_TABLES) }),
  }),
  requiredIndexes: PHASE_FIVE_REQUIRED_INDEXES,
  requiredConstraints: REQUIRED_CONSTRAINTS,
  corePageTypes: Object.freeze(CORE_PAGE_TYPE_KEYS),
  optionalFeatures: Object.freeze(["vector"]),
});

export const COMPANY_DATABASE_MANIFEST_PHASE_FIVE_DIGEST = createHash("sha256")
  .update(JSON.stringify(COMPANY_DATABASE_MANIFEST_PHASE_FIVE))
  .digest("hex");

export const COMPANY_DATABASE_MANIFEST_PHASE_SIX = Object.freeze({
  schemaVersion: 1,
  id: "companyos-postgres",
  version: "1.6.0",
  predecessorVersion: COMPANY_DATABASE_MANIFEST_PHASE_FIVE.version,
  migrationMode: "additive",
  schemas: Object.freeze({
    companyos: Object.freeze({ tables: CONTROL_TABLES }),
    companyos_knowledge: Object.freeze({ tables: Object.freeze(PHASE_SIX_MANIFEST_KNOWLEDGE_TABLES) }),
  }),
  requiredIndexes: PHASE_SIX_REQUIRED_INDEXES,
  requiredConstraints: REQUIRED_CONSTRAINTS,
  corePageTypes: Object.freeze(CORE_PAGE_TYPE_KEYS),
  optionalFeatures: Object.freeze(["vector"]),
});

export const COMPANY_DATABASE_MANIFEST_PHASE_SIX_DIGEST = createHash("sha256")
  .update(JSON.stringify(COMPANY_DATABASE_MANIFEST_PHASE_SIX))
  .digest("hex");

export const COMPANY_DATABASE_MANIFEST_PHASE_SEVEN = Object.freeze({
  schemaVersion: 1,
  id: "companyos-postgres",
  version: "1.7.0",
  predecessorVersion: COMPANY_DATABASE_MANIFEST_PHASE_SIX.version,
  migrationMode: "additive",
  schemas: Object.freeze({
    companyos: Object.freeze({ tables: CONTROL_TABLES }),
    companyos_knowledge: Object.freeze({ tables: Object.freeze(KNOWLEDGE_TABLES) }),
  }),
  requiredIndexes: REQUIRED_INDEXES,
  requiredConstraints: REQUIRED_CONSTRAINTS,
  corePageTypes: Object.freeze(CORE_PAGE_TYPE_KEYS),
  optionalFeatures: Object.freeze(["vector"]),
});

export const COMPANY_DATABASE_MANIFEST_PHASE_SEVEN_DIGEST = createHash("sha256")
  .update(JSON.stringify(COMPANY_DATABASE_MANIFEST_PHASE_SEVEN))
  .digest("hex");

export const COMPANY_DATABASE_MANIFEST = Object.freeze({
  schemaVersion: 1,
  id: "companyos-postgres",
  version: "1.8.0",
  predecessorVersion: COMPANY_DATABASE_MANIFEST_PHASE_SEVEN.version,
  migrationMode: "additive",
  schemas: Object.freeze({
    companyos: Object.freeze({ tables: CONTROL_TABLES }),
    companyos_knowledge: Object.freeze({ tables: Object.freeze(KNOWLEDGE_TABLES) }),
    companyos_records: Object.freeze({ tables: Object.freeze(RECORDS_TABLES) }),
  }),
  requiredIndexes: Object.freeze([...REQUIRED_INDEXES, ...RECORDS_REQUIRED_INDEXES]),
  requiredConstraints: REQUIRED_CONSTRAINTS,
  corePageTypes: Object.freeze(CORE_PAGE_TYPE_KEYS),
  optionalFeatures: Object.freeze(["vector"]),
});

export const COMPANY_DATABASE_MANIFEST_DIGEST = createHash("sha256")
  .update(JSON.stringify(COMPANY_DATABASE_MANIFEST))
  .digest("hex");

export interface CompanyDatabaseQualificationReceipt {
  receiptVersion: 1;
  status: "qualified";
  manifestId: string;
  manifestVersion: string;
  manifestDigest: string;
  qualifiedAt: string;
  schemas: {
    companyos: { tableCount: number };
    companyosKnowledge: { tableCount: number };
    companyosRecords: { tableCount: number };
  };
  corePageTypeCount: number;
  features: { vector: boolean };
}

export interface CompanyDatabasePreparationReceipt {
  receiptVersion: 1;
  operation: "bootstrap" | "upgrade" | "verify";
  previousManifestVersions: string[];
  qualification: CompanyDatabaseQualificationReceipt;
}

export interface CompanyDatabaseStateInspection {
  schemas: { companyos: boolean; companyosKnowledge: boolean; companyosRecords: boolean };
  tableCounts: { companyos: number; companyosKnowledge: number; companyosRecords: number };
  manifests: Array<{ manifestId: string; manifestVersion: string; manifestDigest: string; appliedAt: string }>;
  vector: boolean;
  retrievalV3: { available: boolean; activeProjectionHash: string | null };
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
  [COMPANY_DATABASE_MANIFEST_V1.version, COMPANY_DATABASE_MANIFEST_V1_DIGEST],
  [COMPANY_DATABASE_MANIFEST_PHASE_ONE.version, COMPANY_DATABASE_MANIFEST_PHASE_ONE_DIGEST],
  [COMPANY_DATABASE_MANIFEST_PHASE_TWO.version, COMPANY_DATABASE_MANIFEST_PHASE_TWO_DIGEST],
  [COMPANY_DATABASE_MANIFEST_PHASE_THREE.version, COMPANY_DATABASE_MANIFEST_PHASE_THREE_DIGEST],
  [COMPANY_DATABASE_MANIFEST_PHASE_FOUR.version, COMPANY_DATABASE_MANIFEST_PHASE_FOUR_DIGEST],
  [COMPANY_DATABASE_MANIFEST_PHASE_FIVE.version, COMPANY_DATABASE_MANIFEST_PHASE_FIVE_DIGEST],
  [COMPANY_DATABASE_MANIFEST_PHASE_SIX.version, COMPANY_DATABASE_MANIFEST_PHASE_SIX_DIGEST],
  [COMPANY_DATABASE_MANIFEST_PHASE_SEVEN.version, COMPANY_DATABASE_MANIFEST_PHASE_SEVEN_DIGEST],
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
    to_regnamespace('companyos_knowledge')::text as knowledge_schema,
    to_regnamespace('companyos_records')::text as records_schema,
    to_regclass('companyos.schema_manifests')::text as manifest_ledger,
    to_regclass('companyos_knowledge.retrieval_projection_runs')::text as retrieval_projection_runs`)[0] ?? {};
  const tableRows = await sql`select schemaname, count(*)::int as table_count from pg_tables
    where schemaname in ('companyos', 'companyos_knowledge', 'companyos_records') group by schemaname order by schemaname`;
  const tableCounts = new Map(tableRows.map((row) => [String(row.schemaname), Number(row.table_count)]));
  const manifestRows = relations.manifest_ledger
    ? await sql`select manifest_id, manifest_version, manifest_digest, applied_at from companyos.schema_manifests order by applied_at, manifest_id, manifest_version`
    : [];
  const activeProjectionRows = relations.retrieval_projection_runs
    ? await sql`select projection_hash from companyos_knowledge.retrieval_projection_runs where status = 'active' limit 1`
    : [];
  const vector = Boolean((await sql`select exists(select 1 from pg_extension where extname = 'vector') as enabled`)[0]?.enabled);
  return {
    schemas: {
      companyos: Boolean(relations.control_schema),
      companyosKnowledge: Boolean(relations.knowledge_schema),
      companyosRecords: Boolean(relations.records_schema),
    },
    tableCounts: {
      companyos: tableCounts.get("companyos") ?? 0,
      companyosKnowledge: tableCounts.get("companyos_knowledge") ?? 0,
      companyosRecords: tableCounts.get("companyos_records") ?? 0,
    },
    manifests: manifestRows.map((row) => ({
      manifestId: String(row.manifest_id),
      manifestVersion: String(row.manifest_version),
      manifestDigest: String(row.manifest_digest),
      appliedAt: postgresTimestampToIso(row.applied_at),
    })),
    vector,
    retrievalV3: { available: Boolean(relations.retrieval_projection_runs), activeProjectionHash: activeProjectionRows[0]?.projection_hash ? String(activeProjectionRows[0].projection_hash) : null },
  };
}

const missing = (expected: readonly string[], actual: readonly string[]): string[] =>
  expected.filter((item) => !actual.includes(item));

const qualificationError = (parts: string[]): Error =>
  new Error(`Company Instance database qualification failed: ${parts.join("; ")}.`);

export function assertCompanyDatabaseQualificationReceipt(value: unknown): asserts value is CompanyDatabaseQualificationReceipt {
  if (!value || typeof value !== "object") throw new Error("Database qualification receipt must be an object.");
  const receipt = value as Partial<CompanyDatabaseQualificationReceipt>;
  if (receipt.receiptVersion !== 1 || receipt.status !== "qualified") throw new Error("Unsupported database qualification receipt.");
  if (receipt.manifestId !== COMPANY_DATABASE_MANIFEST.id || receipt.manifestVersion !== COMPANY_DATABASE_MANIFEST.version) {
    throw new Error("Database qualification receipt does not match the maintained manifest identity.");
  }
  if (receipt.manifestDigest !== COMPANY_DATABASE_MANIFEST_DIGEST) throw new Error("Database qualification receipt has the wrong manifest digest.");
  if (!receipt.qualifiedAt || Number.isNaN(Date.parse(receipt.qualifiedAt))) throw new Error("Database qualification receipt requires an ISO timestamp.");
  if (receipt.schemas?.companyos?.tableCount !== CONTROL_TABLES.length) throw new Error("Database qualification receipt has the wrong companyos table count.");
  const expectedKnowledgeTables = KNOWLEDGE_TABLES.length + (receipt.features?.vector ? 2 : 0);
  if (receipt.schemas?.companyosKnowledge?.tableCount !== expectedKnowledgeTables) throw new Error("Database qualification receipt has the wrong companyos_knowledge table count.");
  if (receipt.schemas?.companyosRecords?.tableCount !== RECORDS_TABLES.length) throw new Error("Database qualification receipt has the wrong companyos_records table count.");
  if (receipt.corePageTypeCount !== CORE_PAGE_TYPE_KEYS.length) throw new Error("Database qualification receipt has the wrong Core Page type count.");
  if (typeof receipt.features?.vector !== "boolean") throw new Error("Database qualification receipt requires explicit vector feature evidence.");
}

export async function qualifyCompanyDatabase(): Promise<CompanyDatabaseQualificationReceipt> {
  const sql = neon(databaseUrl());
  const tableRows = await sql`select schemaname, tablename from pg_tables
    where schemaname in ('companyos', 'companyos_knowledge', 'companyos_records') order by schemaname, tablename`;
  const tables = tableRows.map((row) => `${String(row.schemaname)}.${String(row.tablename)}`);
  const indexRows = await sql`select schemaname, indexname from pg_indexes
    where schemaname in ('companyos', 'companyos_knowledge', 'companyos_records') order by schemaname, indexname`;
  const indexes = indexRows.map((row) => `${String(row.schemaname)}.${String(row.indexname)}`);
  const constraintRows = await sql`select n.nspname as schema_name, c.conname
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where n.nspname in ('companyos', 'companyos_knowledge') order by n.nspname, c.conname`;
  const constraints = constraintRows.map((row) => `${String(row.schema_name)}.${String(row.conname)}`);
  const pageTypeRows = await sql`select type_key from companyos_knowledge.page_type_registry
    where origin = 'core' and lifecycle_status = 'active' order by type_key`;
  const pageTypes = pageTypeRows.map((row) => String(row.type_key));
  const vector = Boolean((await sql`select exists(select 1 from pg_extension where extname = 'vector') as enabled`)[0]?.enabled);
  const manifestRows = await sql`select manifest_digest from companyos.schema_manifests
    where manifest_id = ${COMPANY_DATABASE_MANIFEST.id} and manifest_version = ${COMPANY_DATABASE_MANIFEST.version} limit 1`;

  const expectedTables = [
    ...CONTROL_TABLES.map((name) => `companyos.${name}`),
    ...KNOWLEDGE_TABLES.map((name) => `companyos_knowledge.${name}`),
    ...RECORDS_TABLES.map((name) => `companyos_records.${name}`),
    ...(vector ? ["companyos_knowledge.fragment_embeddings", "companyos_knowledge.retrieval_unit_embeddings"] : []),
  ];
  const expectedIndexes = [...COMPANY_DATABASE_MANIFEST.requiredIndexes, ...(vector ? ["companyos_knowledge.knowledge_fragment_embeddings_hnsw_idx", "companyos_knowledge.knowledge_retrieval_unit_embeddings_hnsw_idx"] : [])];
  const failures: string[] = [];
  const missingTables = missing(expectedTables, tables);
  const missingIndexes = missing(expectedIndexes, indexes);
  const missingConstraints = missing(REQUIRED_CONSTRAINTS, constraints);
  const missingPageTypes = missing(COMPANY_DATABASE_MANIFEST.corePageTypes, pageTypes);
  const unexpectedPageTypes = missing(pageTypes, COMPANY_DATABASE_MANIFEST.corePageTypes);
  if (missingTables.length > 0) failures.push(`missing tables ${missingTables.join(", ")}`);
  if (missingIndexes.length > 0) failures.push(`missing indexes ${missingIndexes.join(", ")}`);
  if (missingConstraints.length > 0) failures.push(`missing constraints ${missingConstraints.join(", ")}`);
  if (missingPageTypes.length > 0) failures.push(`missing Core Page types ${missingPageTypes.join(", ")}`);
  if (unexpectedPageTypes.length > 0) failures.push(`unexpected Core Page types ${unexpectedPageTypes.join(", ")}`);
  if (manifestRows[0]?.manifest_digest !== COMPANY_DATABASE_MANIFEST_DIGEST) failures.push("missing or mismatched schema manifest ledger entry");
  if (failures.length > 0) throw qualificationError(failures);

  const receipt: CompanyDatabaseQualificationReceipt = {
    receiptVersion: 1,
    status: "qualified",
    manifestId: COMPANY_DATABASE_MANIFEST.id,
    manifestVersion: COMPANY_DATABASE_MANIFEST.version,
    manifestDigest: COMPANY_DATABASE_MANIFEST_DIGEST,
    qualifiedAt: new Date().toISOString(),
    schemas: {
      companyos: { tableCount: CONTROL_TABLES.length },
      companyosKnowledge: { tableCount: KNOWLEDGE_TABLES.length + (vector ? 2 : 0) },
      companyosRecords: { tableCount: RECORDS_TABLES.length },
    },
    corePageTypeCount: CORE_PAGE_TYPE_KEYS.length,
    features: { vector },
  };
  assertCompanyDatabaseQualificationReceipt(receipt);
  return receipt;
}

export async function bootstrapCompanyDatabase(): Promise<CompanyDatabaseQualificationReceipt> {
  await ensureCompanyOSSchema();
  const features = await ensureCompanyKnowledgeSchema();
  await ensureCompanyRecordsSchema();
  const sql = neon(databaseUrl());
  const rows = await sql`insert into companyos.schema_manifests
      (manifest_id, manifest_version, manifest_digest, features)
    values (${COMPANY_DATABASE_MANIFEST.id}, ${COMPANY_DATABASE_MANIFEST.version},
      ${COMPANY_DATABASE_MANIFEST_DIGEST}, ${JSON.stringify(features)})
    on conflict (manifest_id, manifest_version) do update set manifest_id = excluded.manifest_id
    where companyos.schema_manifests.manifest_digest = excluded.manifest_digest
      and companyos.schema_manifests.features = excluded.features
    returning manifest_id`;
  if (rows.length === 0) throw new Error("Database manifest identity already exists with different content or features.");
  return qualifyCompanyDatabase();
}

export async function prepareCompanyDatabase(): Promise<CompanyDatabasePreparationReceipt> {
  const sql = neon(databaseUrl());
  const relationRows = await sql`select
    to_regnamespace('companyos')::text as control_schema,
    to_regnamespace('companyos_knowledge')::text as knowledge_schema,
    to_regnamespace('companyos_records')::text as records_schema,
    to_regclass('companyos.schema_manifests')::text as manifest_ledger,
    to_regclass('companyos_knowledge.snapshots')::text as knowledge_snapshots,
    to_regclass('companyos_knowledge.sources')::text as knowledge_sources`;
  const relation = relationRows[0] ?? {};
  const previousManifestVersions = relation.manifest_ledger
    ? assertSupportedCompanyDatabaseManifestHistory(await sql`select manifest_version, manifest_digest from companyos.schema_manifests
        where manifest_id = ${COMPANY_DATABASE_MANIFEST.id} order by manifest_version`)
    : [];
  const hasExistingState = Boolean(relation.control_schema || relation.knowledge_schema || relation.records_schema || relation.manifest_ledger || relation.knowledge_snapshots || relation.knowledge_sources);
  const operation: CompanyDatabasePreparationReceipt["operation"] = previousManifestVersions.includes(COMPANY_DATABASE_MANIFEST.version)
    ? "verify"
    : hasExistingState ? "upgrade" : "bootstrap";
  const qualification = operation === "verify" ? await qualifyCompanyDatabase() : await bootstrapCompanyDatabase();
  return { receiptVersion: 1, operation, previousManifestVersions, qualification };
}
