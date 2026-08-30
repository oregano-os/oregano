import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { COMPANY_KNOWLEDGE_PHASE_SEVEN_SCHEMA_STATEMENTS } from "../../state-postgres/knowledge-schema-phase-seven.ts";

const storeSource = readFileSync(new URL("../../state-postgres/knowledge-retrieval-v3-store.ts", import.meta.url), "utf8");
const productizationStoreSource = readFileSync(new URL("../../state-postgres/knowledge-productization-store.ts", import.meta.url), "utf8");
const productionQualificationSource = readFileSync(new URL("../../state-postgres/knowledge-production-qualification.ts", import.meta.url), "utf8");
const migrationSource = readFileSync(new URL("../../state-postgres/knowledge-migrate.ts", import.meta.url), "utf8");
const schema = COMPANY_KNOWLEDGE_PHASE_SEVEN_SCHEMA_STATEMENTS.join("\n");

test("Retrieval V3 schema is additive, projection-scoped, policy-bound, and independently activatable", () => {
  for (const table of ["retrieval_projection_runs", "retrieval_units", "knowledge_benchmark_runs", "knowledge_shadow_comparisons", "knowledge_productization_receipts"]) assert.match(schema, new RegExp(`create table if not exists companyos_knowledge\\.${table}`));
  assert.match(schema, /access_policy_id text not null references companyos_knowledge\.acl_policies\(policy_id\)/);
  assert.match(schema, /primary key \(projection_hash, unit_id\)/);
  assert.match(schema, /where status = 'active'/);
  assert.match(schema, /unit_kind = 'handbook-fragment' and authority_layer = 'official'/);
  assert.doesNotMatch(schema, /drop table|truncate|delete from/i);
  assert.match(migrationSource, /COMPANY_KNOWLEDGE_PHASE_SEVEN_SCHEMA_STATEMENTS/);
  assert.match(migrationSource, /retrieval_unit_embeddings/);
});

test("Postgres candidate SQL receives authorized policy identities before lexical, semantic, exact, and Current Brief hydration", () => {
  const filters = storeSource.match(/access_policy_id in \(select jsonb_array_elements_text/g) ?? [];
  assert.ok(filters.length >= 5, "all read paths must carry pre-authorized policy sets into SQL");
  assert.match(storeSource, /lexicalCandidates[\s\S]*authorizedPolicyIds\.length === 0[\s\S]*search_vector @@/);
  assert.match(storeSource, /semanticCandidates[\s\S]*authorizedPolicyIds\.length === 0[\s\S]*retrieval_unit_embeddings[\s\S]*u\.access_policy_id in/);
  assert.match(storeSource, /getUnitsByIds[\s\S]*unitIds\.length === 0 \|\| input\.authorizedPolicyIds\.length === 0[\s\S]*access_policy_id in/);
  assert.match(storeSource, /loadCurrent[\s\S]*authorizedPolicyIds\.length === 0[\s\S]*s\.access_policy_id in[\s\S]*v\.access_policy_id in/);
  assert.match(storeSource, /loadCurrent[\s\S]*claim_evidence[\s\S]*page\.current_version_id = evidence\.page_version_id[\s\S]*evidence\.page_id = s\.subject_id/);
  assert.match(productionQualificationSource, /currentBriefStatus[\s\S]*claim_evidence[\s\S]*evidence\.page_id = syntheses\.subject_id[\s\S]*claim\.observed_at > versions\.synthesized_at/);
});

test("Production shadow reads require one exact verified projection and activation requires persisted qualification", () => {
  assert.match(storeSource, /allowVerifiedReadProjection[\s\S]*verified shadow reads require one exact projection hash/i);
  assert.match(storeSource, /projection_hash = \$\{this\.#readProjectionHash\}[\s\S]*status in \('verified','active'\)/);
  assert.match(storeSource, /activateQualifiedProjection[\s\S]*activation-qualification[\s\S]*qualified-for-explicit-activation[\s\S]*retrievalProjectionReceiptId/);
  assert.match(productizationStoreSource, /status === "qualified-for-explicit-activation"[\s\S]*"activation-qualification"[\s\S]*"environment-qualification"/);
  assert.doesNotMatch(productizationStoreSource, /"production-canary-qualification"|"live-shadow-observation"/);
});

test("Retrieval projection activation requires verification and retains an explicit rollback target", () => {
  assert.match(storeSource, /verifyProjection[\s\S]*createKnowledgeRetrievalProjectionV3[\s\S]*rebuilt\.projectionHash !== projectionHash/);
  assert.match(storeSource, /activateProjection[\s\S]*status = 'retired'[\s\S]*verified_at is not null[\s\S]*status = 'active'/);
  assert.match(storeSource, /rebuildPostgresKnowledgeRetrievalProjectionV3[\s\S]*activate\?: boolean/);
  assert.match(storeSource, /return input\.activate \? store\.activateProjection\(verified\.projectionHash\) : verified/);
});
