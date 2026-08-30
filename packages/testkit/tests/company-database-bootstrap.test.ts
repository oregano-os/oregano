import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createNeonBranchDatabaseUrl,
  assertSupportedCompanyDatabaseManifestHistory,
  assertCompanyDatabaseQualificationReceipt,
  bootstrapCompanyDatabase,
  COMPANY_DATABASE_MANIFEST,
  COMPANY_DATABASE_MANIFEST_DIGEST,
  COMPANY_DATABASE_MANIFEST_PHASE_ONE,
  COMPANY_DATABASE_MANIFEST_PHASE_ONE_DIGEST,
  COMPANY_DATABASE_MANIFEST_PHASE_TWO,
  COMPANY_DATABASE_MANIFEST_PHASE_TWO_DIGEST,
  COMPANY_DATABASE_MANIFEST_PHASE_THREE,
  COMPANY_DATABASE_MANIFEST_PHASE_THREE_DIGEST,
  COMPANY_DATABASE_MANIFEST_PHASE_FOUR,
  COMPANY_DATABASE_MANIFEST_PHASE_FOUR_DIGEST,
  COMPANY_DATABASE_MANIFEST_PHASE_FIVE,
  COMPANY_DATABASE_MANIFEST_PHASE_FIVE_DIGEST,
  COMPANY_DATABASE_MANIFEST_PHASE_SIX,
  COMPANY_DATABASE_MANIFEST_PHASE_SIX_DIGEST,
  COMPANY_DATABASE_MANIFEST_V1,
  COMPANY_DATABASE_MANIFEST_V1_DIGEST,
  qualifyCompanyDatabase,
} from "../../state-postgres/database-bootstrap.ts";

const qualification = (vector = false) => ({
  receiptVersion: 1 as const,
  status: "qualified" as const,
  manifestId: COMPANY_DATABASE_MANIFEST.id,
  manifestVersion: COMPANY_DATABASE_MANIFEST.version,
  manifestDigest: COMPANY_DATABASE_MANIFEST_DIGEST,
  qualifiedAt: "2026-08-26T12:00:00.000Z",
  schemas: {
    companyos: { tableCount: COMPANY_DATABASE_MANIFEST.schemas.companyos.tables.length },
    companyosKnowledge: {
      tableCount: COMPANY_DATABASE_MANIFEST.schemas.companyos_knowledge.tables.length + (vector ? 2 : 0),
    },
  },
  corePageTypeCount: COMPANY_DATABASE_MANIFEST.corePageTypes.length,
  features: { vector },
});

test("the Company Instance database manifest is deterministic and credential-free", () => {
  assert.equal(COMPANY_DATABASE_MANIFEST.schemaVersion, 1);
  assert.equal(COMPANY_DATABASE_MANIFEST.id, "companyos-postgres");
  assert.equal(COMPANY_DATABASE_MANIFEST.version, "1.7.0");
  assert.equal(COMPANY_DATABASE_MANIFEST.predecessorVersion, COMPANY_DATABASE_MANIFEST_PHASE_SIX.version);
  assert.equal(COMPANY_DATABASE_MANIFEST.migrationMode, "additive");
  assert.equal(COMPANY_DATABASE_MANIFEST_V1.version, "1.0.0");
  assert.equal(COMPANY_DATABASE_MANIFEST_PHASE_ONE.version, "1.1.0");
  assert.equal(COMPANY_DATABASE_MANIFEST_PHASE_TWO.version, "1.2.0");
  assert.equal(COMPANY_DATABASE_MANIFEST_PHASE_THREE.version, "1.3.0");
  assert.equal(COMPANY_DATABASE_MANIFEST_PHASE_FOUR.version, "1.4.0");
  assert.equal(COMPANY_DATABASE_MANIFEST_PHASE_FIVE.version, "1.5.0");
  assert.equal(COMPANY_DATABASE_MANIFEST_PHASE_SIX.version, "1.6.0");
  assert.equal(COMPANY_DATABASE_MANIFEST_V1_DIGEST, "0bbe79c8c2f5a6f370f35a7e4f09f1aa7440ded33f0548aa5778fad70aa42cc0");
  assert.notEqual(COMPANY_DATABASE_MANIFEST_DIGEST, COMPANY_DATABASE_MANIFEST_V1_DIGEST);
  assert.equal(COMPANY_DATABASE_MANIFEST_PHASE_ONE_DIGEST, "9ffe70ef8836fba556b213b2b55a68a670c347a2ecbd747daf5677f57a9271f0");
  assert.equal(COMPANY_DATABASE_MANIFEST_PHASE_TWO_DIGEST, "c93be83156e9f6333fdc7ce492cee9704ae22184e99a0102d56bb3fac50d40f2");
  assert.equal(COMPANY_DATABASE_MANIFEST_PHASE_THREE_DIGEST, "d8f28c995427de642dd8e923f2cc82035fe4c557d838f99177abbd961e4b17db");
  assert.equal(COMPANY_DATABASE_MANIFEST_PHASE_FOUR_DIGEST, "6c0b3366540c8b1c0a3d889ef8c180c32d15d4e1bb92dbbbd8b10e94ddbce16c");
  assert.equal(COMPANY_DATABASE_MANIFEST_PHASE_FIVE_DIGEST, "bb3dcef272ce2c33ae1a479171a648ea6e79ab01b04ca37dce998a5e0e404cea");
  assert.equal(COMPANY_DATABASE_MANIFEST_PHASE_SIX_DIGEST, "b9ba518e64d39e754e917348dd67b2bad7aa200d533af8343fba0c6f3774c4b1");
  assert.notEqual(COMPANY_DATABASE_MANIFEST_DIGEST, COMPANY_DATABASE_MANIFEST_PHASE_ONE_DIGEST);
  assert.match(COMPANY_DATABASE_MANIFEST_DIGEST, /^[0-9a-f]{64}$/);
  assert.equal(COMPANY_DATABASE_MANIFEST.corePageTypes.length, 19);
  assert.equal(COMPANY_DATABASE_MANIFEST.schemas.companyos_knowledge.tables.length, 67);
  const knowledgeTables = new Set<string>(COMPANY_DATABASE_MANIFEST.schemas.companyos_knowledge.tables);
  for (const requiredTable of ["acl_policies", "raw_assets", "timeline_events", "synthesis_versions", "extraction_runs", "brain_export_ledger", "principal_groups", "principal_group_members", "access_decision_events", "source_events", "source_acl_snapshots", "source_pipeline_receipts", "source_watermarks", "source_sync_leases", "source_lifecycle_requests", "session_lifecycle_receipts", "knowledge_change_stream", "compounding_leases", "compounding_receipts", "claim_pair_proposals", "claim_grading_requests", "model_task_results", "model_spend_reservations", "model_execution_ledger", "retrieval_projection_runs", "retrieval_units", "knowledge_benchmark_runs", "knowledge_shadow_comparisons", "knowledge_productization_receipts"]) {
    assert.equal(knowledgeTables.has(requiredTable), true);
  }
  for (const requiredIndex of [
    "companyos_knowledge.knowledge_acl_entries_subject_idx",
    "companyos_knowledge.knowledge_edges_from_idx",
    "companyos_knowledge.knowledge_session_corpus_expiry_idx",
    "companyos_knowledge.knowledge_extraction_runs_status_idx",
    "companyos_knowledge.knowledge_access_decisions_principal_idx",
    "companyos_knowledge.knowledge_principal_group_members_principal_idx",
    "companyos_knowledge.knowledge_source_events_queue_idx",
    "companyos_knowledge.knowledge_source_acl_object_idx",
    "companyos_knowledge.knowledge_change_stream_previous_idx",
    "companyos_knowledge.knowledge_source_lifecycle_due_idx",
    "companyos_knowledge.knowledge_session_lifecycle_receipts_session_idx",
    "companyos_knowledge.knowledge_source_sync_leases_due_idx",
    "companyos_knowledge.knowledge_compounding_leases_due_idx",
    "companyos_knowledge.knowledge_compounding_receipts_cycle_idx",
    "companyos_knowledge.knowledge_claim_pair_proposals_queue_idx",
    "companyos_knowledge.knowledge_claim_grading_requests_queue_idx",
    "companyos_knowledge.knowledge_model_task_results_policy_idx",
    "companyos_knowledge.knowledge_model_spend_reservations_budget_idx",
    "companyos_knowledge.knowledge_model_execution_ledger_spend_idx",
    "companyos_knowledge.knowledge_retrieval_units_search_idx",
    "companyos_knowledge.knowledge_one_active_retrieval_projection_idx",
    "companyos_knowledge.knowledge_benchmark_runs_suite_idx",
  ]) assert.equal(new Set<string>(COMPANY_DATABASE_MANIFEST.requiredIndexes).has(requiredIndex), true);
  for (const requiredConstraint of [
    "companyos_knowledge.knowledge_sources_access_policy_fk",
    "companyos_knowledge.knowledge_raw_assets_access_policy_fk",
    "companyos_knowledge.knowledge_syntheses_current_version_parent_fk",
    "companyos_knowledge.knowledge_source_events_event_fk",
    "companyos_knowledge.knowledge_source_object_payload_state_check",
  ]) assert.equal(new Set<string>(COMPANY_DATABASE_MANIFEST.requiredConstraints).has(requiredConstraint), true);
  assert.deepEqual([...COMPANY_DATABASE_MANIFEST.corePageTypes].sort(), [...COMPANY_DATABASE_MANIFEST.corePageTypes]);
  assert.doesNotMatch(JSON.stringify(COMPANY_DATABASE_MANIFEST), /DATABASE_URL|postgres(?:ql)?:\/\//i);
});

test("database qualification receipts fail closed on identity, count, or feature drift", () => {
  assert.doesNotThrow(() => assertCompanyDatabaseQualificationReceipt(qualification()));
  assert.doesNotThrow(() => assertCompanyDatabaseQualificationReceipt(qualification(true)));
  assert.throws(() => assertCompanyDatabaseQualificationReceipt({
    ...qualification(),
    manifestDigest: "0".repeat(64),
  }), /manifest digest/);
  assert.throws(() => assertCompanyDatabaseQualificationReceipt({
    ...qualification(),
    corePageTypeCount: 18,
  }), /Page type count/);
});

test("database preparation rejects unknown or conflicting manifest history before mutation", () => {
  assert.deepEqual(assertSupportedCompanyDatabaseManifestHistory([
    { manifest_version: COMPANY_DATABASE_MANIFEST_PHASE_TWO.version, manifest_digest: COMPANY_DATABASE_MANIFEST_PHASE_TWO_DIGEST },
    { manifest_version: COMPANY_DATABASE_MANIFEST_PHASE_THREE.version, manifest_digest: COMPANY_DATABASE_MANIFEST_PHASE_THREE_DIGEST },
    { manifest_version: COMPANY_DATABASE_MANIFEST_PHASE_FOUR.version, manifest_digest: COMPANY_DATABASE_MANIFEST_PHASE_FOUR_DIGEST },
    { manifest_version: COMPANY_DATABASE_MANIFEST_PHASE_FIVE.version, manifest_digest: COMPANY_DATABASE_MANIFEST_PHASE_FIVE_DIGEST },
    { manifest_version: COMPANY_DATABASE_MANIFEST_PHASE_SIX.version, manifest_digest: COMPANY_DATABASE_MANIFEST_PHASE_SIX_DIGEST },
    { manifest_version: COMPANY_DATABASE_MANIFEST.version, manifest_digest: COMPANY_DATABASE_MANIFEST_DIGEST },
  ]), ["1.2.0", "1.3.0", "1.4.0", "1.5.0", "1.6.0", "1.7.0"]);
  assert.throws(() => assertSupportedCompanyDatabaseManifestHistory([{ manifest_version: "9.0.0", manifest_digest: "0".repeat(64) }]), /unsupported manifest version/i);
  assert.throws(() => assertSupportedCompanyDatabaseManifestHistory([{ manifest_version: COMPANY_DATABASE_MANIFEST.version, manifest_digest: "0".repeat(64) }]), /conflicting content/i);
});

test("Neon branch qualification changes only the in-memory host binding", () => {
  const production = new URL("postgresql://company:example-password@ep-production-pooler.c-5.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require");
  const branch = new URL(createNeonBranchDatabaseUrl(production.toString(), "ep-rehearsal-pooler.c-5.eu-central-1.aws.neon.tech"));
  assert.equal(branch.hostname, "ep-rehearsal-pooler.c-5.eu-central-1.aws.neon.tech");
  assert.equal(branch.username, production.username);
  assert.equal(branch.password, production.password);
  assert.equal(branch.pathname, production.pathname);
  assert.equal(branch.search, production.search);
  assert.equal(production.hostname, "ep-production-pooler.c-5.eu-central-1.aws.neon.tech");
  assert.throws(() => createNeonBranchDatabaseUrl(production.toString(), production.hostname), /must differ/i);
  assert.throws(() => createNeonBranchDatabaseUrl(production.toString(), "database.example.com"), /host is invalid/i);
});

test("qualification is read-only and bootstrap owns both schema initializers and the manifest ledger", () => {
  const qualificationSource = qualifyCompanyDatabase.toString();
  assert.doesNotMatch(qualificationSource, /sql`\s*(?:create|alter|insert|update|delete|drop|truncate)\b/i);
  const bootstrapSource = bootstrapCompanyDatabase.toString();
  assert.match(bootstrapSource, /ensureCompanyOSSchema/);
  assert.match(bootstrapSource, /ensureCompanyKnowledgeSchema/);
  assert.match(bootstrapSource, /insert into companyos\.schema_manifests/);
  assert.doesNotMatch(bootstrapSource, /delete\s+from\s+companyos\.schema_manifests/i);
  const migration = readFileSync(new URL("../../state-postgres/migrate.ts", import.meta.url), "utf8");
  const schema = readFileSync(new URL("../../state-postgres/schema.sql", import.meta.url), "utf8");
  assert.match(migration, /create table if not exists companyos\.schema_manifests/);
  assert.match(schema, /create table if not exists companyos\.schema_manifests/);
  assert.doesNotMatch(schema, /database_url|postgres(?:ql)?:\/\//i);
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
