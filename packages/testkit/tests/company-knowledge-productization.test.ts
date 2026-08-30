import assert from "node:assert/strict";
import { test } from "node:test";
import { compareKnowledgeBench, runKnowledgeBench } from "../../knowledge/knowledge-bench.ts";
import { createKnowledgeOperationalGateReceipt, qualifyKnowledgeProductizationActivation, qualifyNonProductionKnowledgeEnvironment, qualifyProductionKnowledgeCanary } from "../../knowledge/productization.ts";
import { createKnowledgeRetrievalProjectionV3, createKnowledgeRetrievalUnitV3 } from "../../knowledge/retrieval-unit.ts";
import { createExtractiveKnowledgeAnswerV3, InMemoryKnowledgeRetrievalCandidateStoreV3, KnowledgeRetrievalServiceV3, KNOWLEDGE_RETRIEVAL_V3_CONTRACT_VERSION, validateKnowledgeAnswerEnvelopeV3 } from "../../knowledge/retrieval-v3.ts";
import { sha256 } from "../../runtime/canonical.ts";

const now = "2026-08-30T12:00:00.000Z";

const production = {
  environmentId: "oregano-production",
  environmentClass: "production" as const,
  state: { provider: "neon", projectId: "neon-company", branchId: "branch-production" },
  runtime: { provider: "vercel", projectId: "runtime-production", deploymentScope: "production" },
  secretNamespaceId: "secrets-production",
  communicationBindingId: "slack-production",
  sourceBindingIds: ["granola-production"],
  modelBudget: { period: "utc-day" as const, maximumUsd: 25 },
};

const staging = {
  environmentId: "oregano-staging",
  environmentClass: "non-production" as const,
  state: { provider: "neon", projectId: "neon-company", branchId: "branch-staging" },
  runtime: { provider: "vercel", projectId: "runtime-staging", deploymentScope: "preview" },
  secretNamespaceId: "secrets-staging",
  communicationBindingId: "slack-staging",
  sourceBindingIds: ["granola-staging"],
  modelBudget: { period: "utc-day" as const, maximumUsd: 2 },
};

test("Neon branches are valid non-production isolation only with separate runtime and bindings", () => {
  const receipt = qualifyNonProductionKnowledgeEnvironment({ candidate: staging, production, qualifiedAt: now });
  assert.equal(receipt.status, "qualified");
  assert.equal(receipt.isolation.stateBranch, true);
  assert.match(receipt.receiptId, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(receipt), /postgres(?:ql)?:\/\/|DATABASE_URL/i);
  assert.throws(() => qualifyNonProductionKnowledgeEnvironment({ candidate: { ...staging, state: production.state }, production, qualifiedAt: now }), /StateStore.*distinct/i);
  assert.throws(() => qualifyNonProductionKnowledgeEnvironment({ candidate: { ...staging, secretNamespaceId: production.secretNamespaceId }, production, qualifiedAt: now }), /secrets.*distinct/i);
  assert.throws(() => qualifyNonProductionKnowledgeEnvironment({ candidate: { ...staging, sourceBindingIds: production.sourceBindingIds }, production, qualifiedAt: now }), /Source bindings.*distinct/i);

  const activation = qualifyKnowledgeProductizationActivation({
    rolloutReceipt: receipt,
    qualifiedAt: now,
    evidence: {
      rolloutQualificationReceiptId: receipt.receiptId,
      databaseQualificationReceiptId: "database:1.7.0",
      retrievalProjectionReceiptId: "projection:verified",
      knowledgeBenchReceiptId: "bench:passed",
      authorizationNegativeTestReceiptId: "acl:passed",
      citationRegressionReceiptId: "citations:passed",
      sourceQualificationReceiptIds: ["source:granola:qualified"],
      backupRestoreReceiptId: "restore:passed",
      rollbackReceiptId: "rollback:passed",
      shadowComparisonReceiptId: "shadow:promotable",
      operatorApprovalReceiptId: "operator:approved",
    },
  });
  assert.equal(activation.status, "qualified-for-explicit-activation");
  assert.notEqual(activation.receiptId, receipt.receiptId);
});

test("Oregano HQ can use an explicit internal-only production canary without weakening non-production isolation", () => {
  const receipt = qualifyProductionKnowledgeCanary({
    production,
    qualifiedAt: now,
    canaryScope: { companyInstanceId: "oregano-hq", allowedAgentIds: ["oregano"], maximumTrafficPercent: 100, servesExternalTraffic: false },
    evidence: {
      stateBranchRehearsalReceiptId: "neon-branch:rehearsed",
      databaseBackupReceiptId: "neon-backup:available",
      v2FallbackReceiptId: "runtime:v2-fallback-tested",
      shadowModeReceiptId: "shadow:v2-served",
      operatorRiskAcceptanceReceiptId: "operator:approved",
    },
  });
  assert.equal(receipt.status, "qualified-for-production-canary");
  assert.deepEqual(receipt.canaryScope.allowedAgentIds, ["oregano"]);
  assert.throws(() => qualifyProductionKnowledgeCanary({
    production,
    qualifiedAt: now,
    canaryScope: { companyInstanceId: "oregano-hq", allowedAgentIds: ["oregano"], maximumTrafficPercent: 100, servesExternalTraffic: true },
    evidence: receipt.evidence,
  }), /internal dogfood/i);

  const activation = qualifyKnowledgeProductizationActivation({
    rolloutReceipt: receipt,
    qualifiedAt: now,
    evidence: {
      rolloutQualificationReceiptId: receipt.receiptId,
      databaseQualificationReceiptId: "database:1.7.0",
      retrievalProjectionReceiptId: sha256("projection:verified"),
      knowledgeBenchReceiptId: "bench:passed",
      authorizationNegativeTestReceiptId: "acl:passed",
      citationRegressionReceiptId: "citations:passed",
      sourceQualificationReceiptIds: ["source:granola:qualified"],
      backupRestoreReceiptId: "restore:passed",
      rollbackReceiptId: "rollback:passed",
      shadowComparisonReceiptId: "shadow:promotable",
      operatorApprovalReceiptId: "operator:approved",
    },
  });
  assert.equal(activation.status, "qualified-for-explicit-activation");
});

test("production gate receipts persist only bounded payload-free metrics", () => {
  const receipt = createKnowledgeOperationalGateReceipt({
    gateId: "authorization-negative-tests",
    passed: true,
    metrics: { leakageCount: 0, exactPathChecked: true },
    evidenceIds: [sha256("projection")],
    recordedAt: now,
  });
  assert.equal(receipt.status, "passed");
  assert.match(receipt.receiptId, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(receipt), /query|excerpt|postgres(?:ql)?:\/\//i);
  assert.throws(() => createKnowledgeOperationalGateReceipt({
    gateId: "authorization-negative-tests",
    passed: false,
    metrics: { invalid: Number.NaN },
    recordedAt: now,
  }), /metric.*invalid/i);
});

const unit = (unitId: string, text: string, policyId: string, authorityLayer: "official" | "attributed" = "attributed") => createKnowledgeRetrievalUnitV3({
  unitId,
  parentId: unitId,
  kind: authorityLayer === "official" ? "handbook-fragment" : "claim",
  authorityLayer,
  state: "active",
  title: unitId === "claim:strategy" ? "Company strategy" : "Private board plan",
  aliases: unitId === "claim:strategy" ? ["strategy"] : ["board plan"],
  text,
  contentDigest: sha256(text),
  accessPolicyId: policyId,
  sourceIds: ["source:meeting"],
  observedAt: now,
  graphNeighbors: [],
});

const companyUnit = createKnowledgeRetrievalUnitV3({ ...unit("claim:strategy", "The current strategy focuses on enterprise DACH.", "policy:company"), graphNeighbors: ["claim:board"] });
const privateUnit = unit("claim:board", "The confidential board scenario considers an acquisition.", "policy:board");
const projection = createKnowledgeRetrievalProjectionV3({ units: [companyUnit, privateUnit], sourceSnapshotIds: ["brain:1"], createdAt: now });
const policies = [
  { policyId: "policy:company", policyVersion: 1, visibility: "company" as const, sourceRoot: true, status: "active" as const, entries: [] },
  { policyId: "policy:board", policyVersion: 1, visibility: "restricted_group" as const, sourceRoot: true, status: "active" as const, entries: [{ subjectKind: "group" as const, subjectId: "group:board", permission: "read" as const, effect: "allow" as const }] },
];
const store = new InMemoryKnowledgeRetrievalCandidateStoreV3({ projection: { projectionHash: projection.projectionHash, sourceSnapshotIds: projection.sourceSnapshotIds, unitCount: projection.units.length, status: "active", createdAt: now, verifiedAt: now, activatedAt: now }, units: projection.units, policies });

test("Retrieval V3 authorizes policy identities before candidates and binds answer claims to context", async () => {
  const service = new KnowledgeRetrievalServiceV3({ store });
  const employee = { principalId: "person:employee", principalType: "human" as const, status: "active" as const, groupIds: ["company:active"] };
  const result = await service.search({ query: "strategy acquisition", subject: employee, mode: "lexical" });
  assert.deepEqual(result.hits.map((hit) => hit.unitId), ["claim:strategy"]);
  assert.equal(await service.get({ unitId: privateUnit.unitId, subject: employee }), undefined);
  assert.deepEqual((await service.get({ unitId: companyUnit.unitId, subject: employee }))?.graphNeighbors, [], "exact reads must not disclose unauthorized adjacency");
  const context = await service.contextPack({ query: "company strategy", subject: employee, authorizationContextDigest: sha256("employee-context"), mode: "lexical", createdAt: now });
  assert.ok(context);
  const fallback = createExtractiveKnowledgeAnswerV3({ context });
  assert.equal(fallback.status, "extractive-fallback");
  assert.equal(fallback.citations[0]?.unitId, "claim:strategy");
  assert.throws(() => validateKnowledgeAnswerEnvelopeV3({ context, envelope: { ...fallback, contractVersion: KNOWLEDGE_RETRIEVAL_V3_CONTRACT_VERSION, claims: [{ text: "Unsupported acquisition claim", citationUnitIds: ["claim:board"] }] } }), /exact envelope context/i);
});

test("KnowledgeBench is payload-free and blocks authorization, citation, or ranking regressions", async () => {
  const service = new KnowledgeRetrievalServiceV3({ store });
  const subject = { principalId: "person:employee", principalType: "human" as const, status: "active" as const, groupIds: ["company:active"] };
  const report = await runKnowledgeBench({
    suiteId: "company-knowledge-v1",
    implementationId: "retrieval-v3",
    recordedAt: now,
    gates: { minimumMeanRecallAtK: 1, minimumMeanReciprocalRank: 1, minimumAuthorityAccuracy: 1, minimumCitationMembership: 1, maximumAuthorizationLeakage: 0, maximumDegradationRate: 0 },
    cases: [{ caseId: "strategy", query: "company strategy", subject, expectedUnitIds: [companyUnit.unitId], forbiddenUnitIds: [privateUnit.unitId], expectedAuthority: { [companyUnit.unitId]: "attributed" }, mode: "lexical" }],
    search: async (request) => {
      const result = await service.search(request);
      return { hits: result.hits.map((hit) => ({ unitId: hit.unitId, contentDigest: hit.contentDigest, authorityLayer: hit.authorityLayer, citation: { unitId: hit.unitId, contentDigest: hit.contentDigest } })), degradations: result.degradations };
    },
  });
  assert.equal(report.status, "passed");
  assert.equal(report.metrics.authorizationLeakage, 0);
  assert.doesNotMatch(JSON.stringify(report), /company strategy/i);
  const comparison = compareKnowledgeBench({ baseline: report, candidate: { ...report, reportId: sha256({ ...report, reportId: undefined }) } as typeof report, comparedAt: now });
  assert.equal(comparison.status, "promotable");
});
