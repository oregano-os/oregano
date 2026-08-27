import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  BASE_BRAIN_PAGE_TYPES,
  CORE_BRAIN_PAGE_TAXONOMY,
  assertBrainPageTypeRegistry,
  createBrainClaim,
  createClaimResolutionProposal,
  resolveBrainPageType,
  type BrainPageTypeDefinition,
  type ClaimEvidence,
  type EpistemicHolder,
  type TakeClaimInput,
} from "../../knowledge/brain-contracts.ts";
import { COMPANY_BRAIN_PHASE_ONE_SCHEMA_STATEMENTS } from "../../state-postgres/knowledge-schema-phase-one.ts";

const holder: EpistemicHolder = {
  holderId: "person:peter",
  holderType: "person",
  displayName: "Peter",
};

const evidence = (overrides: Partial<ClaimEvidence> = {}): ClaimEvidence => ({
  evidenceId: "evidence:meeting:1:42",
  sourceId: "source:meetings",
  providerObjectId: "meeting:1",
  providerVersion: "v1",
  contentDigest: "a".repeat(64),
  observedAt: "2026-08-26T10:00:00.000Z",
  locator: { kind: "timestamp", startMs: 42_000, endMs: 45_000 },
  ...overrides,
});

test("the versioned Core Brain taxonomy contains 19 unique extensible Page types", () => {
  assert.equal(BASE_BRAIN_PAGE_TYPES.length, 19);
  assert.equal(new Set(BASE_BRAIN_PAGE_TYPES.map((entry) => entry.key)).size, 19);
  assert.equal(BASE_BRAIN_PAGE_TYPES.some((entry) => entry.key === "note"), true);
  assert.doesNotThrow(() => assertBrainPageTypeRegistry(CORE_BRAIN_PAGE_TAXONOMY));

  const extension: BrainPageTypeDefinition = {
    key: "customer-interview",
    taxonomyVersion: "workspace:1.0.0",
    displayLabel: "Customer interview",
    aliases: ["user-interview"],
    parentKey: "conversation",
    extractionProfile: "transcript",
    origin: "extension",
    status: "active",
  };
  const registry = [...CORE_BRAIN_PAGE_TAXONOMY, extension];
  assert.equal(resolveBrainPageType("customer-interview", registry).matchedBy, "key");
  assert.deepEqual(resolveBrainPageType("USER-INTERVIEW", registry), {
    key: "customer-interview",
    matchedBy: "alias",
    definition: extension,
  });
  assert.equal(resolveBrainPageType("not-registered", registry).key, "note");
  assert.equal(resolveBrainPageType("not-registered", registry).matchedBy, "fallback");
});

test("the Postgres Brain foundation is additive and seeds the same taxonomy idempotently", () => {
  const schema = readFileSync(join(import.meta.dirname, "../../state-postgres/knowledge-schema.sql"), "utf8");
  const migration = readFileSync(join(import.meta.dirname, "../../state-postgres/knowledge-migrate.ts"), "utf8");
  const tables = [
    "page_type_registry",
    "page_type_aliases",
    "pages",
    "page_versions",
    "holders",
    "claims",
    "claim_evidence",
    "claim_relations",
    "claim_consolidations",
    "claim_resolution_proposals",
  ];
  for (const table of tables) {
    const statement = `create table if not exists companyos_knowledge.${table}`;
    assert.equal(schema.includes(statement), true, `${table} is additive in the SQL migration`);
    assert.equal(migration.includes(statement), true, `${table} is additive in the runtime migration`);
  }
  for (const pageType of BASE_BRAIN_PAGE_TYPES) {
    assert.equal(schema.includes(`('${pageType.key}', '1.0.0'`), true, `${pageType.key} is seeded in SQL`);
    assert.equal(migration.includes(`('${pageType.key}', '1.0.0'`), true, `${pageType.key} is seeded at runtime`);
  }
  assert.match(schema, /on conflict \(type_key\) do nothing/);
  assert.match(migration, /on conflict \(type_key\) do nothing/);
  assert.doesNotMatch(schema, /create\s+type\s+.+page.+enum/i);
});

test("the complete Phase 1 schema is additive, fail-closed, and mirrored by the standalone SQL", () => {
  const schema = readFileSync(join(import.meta.dirname, "../../state-postgres/knowledge-schema.sql"), "utf8");
  const runtimeStatements = COMPANY_BRAIN_PHASE_ONE_SCHEMA_STATEMENTS.join("\n");
  const tables = [
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
  ];
  for (const table of tables) {
    const statement = `create table if not exists companyos_knowledge.${table}`;
    assert.equal(schema.includes(statement), true, `${table} exists in standalone SQL`);
    assert.equal(runtimeStatements.includes(statement), true, `${table} exists in runtime upgrade`);
  }
  for (const source of [schema, runtimeStatements]) {
    assert.match(source, /policy:quarantine/);
    assert.match(source, /unresolved-legacy-policy/);
    assert.match(source, /sources[\s\S]+access_policy_id text not null default 'policy:quarantine'/);
    assert.match(source, /source_object_versions[\s\S]+access_policy_id text not null default 'policy:quarantine'/);
    assert.match(source, /claim_evidence[\s\S]+access_policy_id text not null default 'policy:quarantine'/);
  }
  assert.doesNotMatch(runtimeStatements, /\b(?:drop|truncate|delete\s+from)\b/i);
});

test("Facts are principal-scoped, evidence-bound, active, and retry-idempotent", () => {
  const input = {
    memoryClass: "fact" as const,
    claimKind: "commitment" as const,
    claimText: "Prepare the launch brief by Friday.",
    ownerPrincipalId: "principal:peter",
    scope: { kind: "session" as const, sessionId: "session:launch" },
    observedAt: "2026-08-26T10:00:00Z",
    evidence: [evidence()],
    extractionConfidence: 0.9,
    epistemicWeight: 0.75,
    accessPolicyId: "policy:launch-team",
    createdBy: "agent:oregano",
  };
  const first = createBrainClaim(input);
  const retried = createBrainClaim(structuredClone(input));
  assert.equal(first.status, "active");
  assert.equal(first.derivation, "principal-memory");
  assert.equal(first.claimId, retried.claimId);

  assert.throws(() => createBrainClaim({ ...input, ownerPrincipalId: "" }), /owner principal ID is required/);
  assert.throws(() => createBrainClaim({ ...input, evidence: [], unresolvedEvidenceReason: "" }), /exact evidence/);
  assert.throws(() => createBrainClaim({
    ...input,
    evidence: [{ ...evidence(), pageId: "page:one" }],
  }), /requires both pageId and pageVersionId/);
});

test("source-literal Takes activate only with exact evidence and a resolved Holder", () => {
  const active = createBrainClaim({
    memoryClass: "take",
    claimKind: "bet",
    claimText: "The conversion rate will exceed five percent.",
    primaryHolder: holder,
    derivation: "source-literal",
    observedAt: "2026-08-26T10:00:00Z",
    evidence: [evidence()],
    extractionConfidence: 0.95,
    epistemicWeight: 0.8,
    accessPolicyId: "policy:leadership",
    createdBy: "agent:oregano",
  });
  assert.equal(active.status, "active");
  assert.equal(active.primaryHolder?.holderId, holder.holderId);

  const unresolved = createBrainClaim({
    memoryClass: "take",
    claimKind: "take",
    claimText: "The launch should move to September.",
    primaryHolder: { holderId: "unresolved:speaker-2", holderType: "unresolved", displayName: "Unknown speaker" },
    derivation: "source-literal",
    observedAt: "2026-08-26T10:00:00Z",
    evidence: [evidence()],
    extractionConfidence: 0.8,
    epistemicWeight: 0.5,
    accessPolicyId: "policy:launch-team",
    createdBy: "agent:oregano",
  });
  assert.equal(unresolved.status, "proposed");
});

test("model-derived Takes remain proposals and consolidated Takes require receipts", () => {
  const modelTakeInput: TakeClaimInput = {
    memoryClass: "take",
    claimKind: "hunch",
    claimText: "The customer may prefer annual billing.",
    primaryHolder: { holderId: "system:extraction", holderType: "system", displayName: "CompanyOS extraction" },
    derivation: "model-derived",
    observedAt: "2026-08-26T10:00:00Z",
    evidence: [evidence()],
    extractionConfidence: 1,
    epistemicWeight: 0.95,
    accessPolicyId: "policy:deal-team",
    createdBy: "model:extractor",
    modelProvenance: { model: "fixture-model", promptVersion: "1", extractionRunId: "run:1" },
  };
  const modelTake = createBrainClaim(modelTakeInput);
  assert.equal(modelTake.status, "proposed");
  assert.throws(() => createBrainClaim({
    ...modelTakeInput,
    modelProvenance: undefined,
  }), /requires model, prompt, and extraction-run provenance/);

  const consolidatedBase = {
    memoryClass: "take" as const,
    claimKind: "fact" as const,
    claimText: "The launch brief is due Friday.",
    primaryHolder: holder,
    derivation: "fact-consolidation" as const,
    observedAt: "2026-08-26T10:00:00Z",
    evidence: [evidence()],
    extractionConfidence: 0.9,
    epistemicWeight: 0.8,
    accessPolicyId: "policy:launch-team",
    createdBy: "rule:fact-consolidation",
  };
  assert.throws(() => createBrainClaim(consolidatedBase), /consolidation receipt/);
  assert.equal(createBrainClaim({ ...consolidatedBase, consolidationReceiptId: "receipt:consolidation:1" }).status, "active");
});

test("Claim grading creates evidence-bound non-applicable resolution proposals", () => {
  const claim = createBrainClaim({
    memoryClass: "take",
    claimKind: "bet",
    claimText: "The launch will happen before September.",
    primaryHolder: holder,
    derivation: "source-literal",
    observedAt: "2026-08-20T10:00:00Z",
    evidence: [evidence({ observedAt: "2026-08-20T10:00:00Z" })],
    extractionConfidence: 0.95,
    epistemicWeight: 0.8,
    accessPolicyId: "policy:leadership",
    createdBy: "agent:oregano",
  });
  const proposal = createClaimResolutionProposal({
    claim,
    outcome: "correct",
    outcomeEvidence: [evidence({
      evidenceId: "evidence:calendar:launch",
      sourceId: "source:calendar",
      providerObjectId: "event:launch",
      providerVersion: "v3",
      observedAt: "2026-08-30T18:00:00Z",
    })],
    proposedBy: "model:grader",
    proposedAt: "2026-08-30T18:05:00Z",
    judgeReceiptId: "receipt:grader:1",
  });
  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.autoApplicable, false);

  assert.throws(() => createClaimResolutionProposal({
    claim,
    outcome: "incorrect",
    outcomeEvidence: [evidence({ observedAt: "2026-08-19T10:00:00Z" })],
    proposedBy: "model:grader",
    proposedAt: "2026-08-30T18:05:00Z",
    judgeReceiptId: "receipt:grader:2",
  }), /must postdate/);

  assert.throws(() => createClaimResolutionProposal({
    claim,
    outcome: "correct",
    outcomeEvidence: [evidence({
      evidenceId: "evidence:meeting:1:new-version",
      providerVersion: "v2",
      observedAt: "2026-08-30T18:00:00Z",
    })],
    proposedBy: "model:grader",
    proposedAt: "2026-08-30T18:05:00Z",
    judgeReceiptId: "receipt:grader:3",
  }), /independent from the Claim's own source Page/);
});
