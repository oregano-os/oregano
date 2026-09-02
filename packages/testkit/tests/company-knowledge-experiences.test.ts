import assert from "node:assert/strict";
import { test } from "node:test";
import { createCurrentBriefView } from "../../knowledge/current-brief.ts";
import { runKnowledgeDoctor } from "../../knowledge/knowledge-doctor.ts";
import { createMeetingPrepView, createOpenLoopsView, OpenLoopsService } from "../../knowledge/knowledge-experiences.ts";
import { qualifyNonProductionKnowledgeEnvironment } from "../../knowledge/productization.ts";
import type { KnowledgeRetrievalHitV3 } from "../../knowledge/retrieval-v3.ts";
import { sha256 } from "../../runtime/canonical.ts";

const now = "2026-08-30T12:00:00.000Z";

test("Open Loops and Meeting Prep are deterministic cited views, never official authority", () => {
  const openLoops = createOpenLoopsView({
    generatedAt: now,
    candidates: [{
      claimId: "claim:follow-up",
      loopKind: "follow-up",
      text: "Send the revised enterprise proposal.",
      state: "open",
      ownerPrincipalId: "person:alice",
      dueAt: "2026-08-29T12:00:00.000Z",
      observedAt: "2026-08-25T12:00:00.000Z",
      authorityLayer: "attributed",
      evidence: [{ unitId: "claim:follow-up", contentDigest: sha256("Send the revised enterprise proposal.") }],
      accessPolicyId: "policy:sales",
    }, {
      claimId: "claim:done",
      loopKind: "commitment",
      text: "Archive the old deck.",
      state: "resolved",
      observedAt: "2026-08-20T12:00:00.000Z",
      authorityLayer: "attributed",
      evidence: [{ unitId: "claim:done", contentDigest: sha256("Archive the old deck.") }],
      accessPolicyId: "policy:sales",
    }],
  });
  assert.equal(openLoops.authorityLayer, "synthesized");
  assert.equal(openLoops.items.length, 1);
  assert.equal(openLoops.items[0]?.urgency, "overdue");
  assert.equal(openLoops.items[0]?.citations[0]?.unitId, "claim:follow-up");

  const content = "# Current Account State\n\nThe enterprise proposal is under review.";
  const brief = createCurrentBriefView({
    synthesisId: "synthesis:account",
    currentVersionId: "synthesis-version:2",
    synthesisVersionId: "synthesis-version:2",
    versionNumber: 2,
    subjectType: "company",
    subjectId: "acme",
    content,
    contentDigest: sha256(content),
    supportingClaimIds: ["claim:follow-up"],
    contestedClaimIds: [],
    supersededClaimIds: [],
    gaps: ["Final budget approval is missing."],
    accessPolicyId: "policy:sales",
    synthesizedAt: now,
  });
  const evidence: KnowledgeRetrievalHitV3 = {
    unitId: "claim:follow-up", parentId: "page:meeting", kind: "claim", authorityLayer: "attributed", state: "active",
    title: "Follow-up", excerpt: "Send the revised enterprise proposal.", contentDigest: sha256("Send the revised enterprise proposal."),
    accessPolicyId: "policy:sales", sourceIds: ["source:meeting"], score: 1, ranks: { lexical: 1 }, explanation: ["rrf"],
  };
  const prep = createMeetingPrepView({ meeting: { identity: "meeting:acme", title: "Acme review", startsAt: "2026-08-31T10:00:00.000Z", attendeeIdentities: ["person:alice", "person:bob"] }, currentBriefs: [brief], openLoops, recentEvidence: [evidence], generatedAt: now });
  assert.equal(prep.authorityLayer, "synthesized");
  assert.equal(prep.currentBriefs[0]?.citation.contentDigest, brief.contentDigest);
  assert.deepEqual(prep.headsUp, ["Final budget approval is missing.", "overdue-open-loops"]);
  assert.equal(createMeetingPrepView({ meeting: prep.meeting, currentBriefs: [brief], openLoops, recentEvidence: [evidence], generatedAt: now }).prepId, prep.prepId);
});

test("Knowledge Doctor blocks production readiness until every critical proof exists", () => {
  const environment = qualifyNonProductionKnowledgeEnvironment({
    qualifiedAt: now,
    candidate: { environmentId: "staging", environmentClass: "non-production", state: { provider: "neon", projectId: "neon", branchId: "staging" }, runtime: { provider: "vercel", projectId: "staging", deploymentScope: "preview" }, secretNamespaceId: "staging", communicationBindingId: "slack:staging", sourceBindingIds: ["source:staging"], modelBudget: { period: "utc-day", maximumUsd: 2 } },
    production: { environmentId: "production", environmentClass: "production", state: { provider: "neon", projectId: "neon", branchId: "production" }, runtime: { provider: "vercel", projectId: "production", deploymentScope: "production" }, secretNamespaceId: "production", communicationBindingId: "slack:production", sourceBindingIds: ["source:production"], modelBudget: { period: "utc-day", maximumUsd: 20 } },
  });
  const report = runKnowledgeDoctor({
    environment,
    database: { qualified: true, manifestVersion: "1.8.0", receiptId: "database:qualified" },
    projection: { projectionHash: sha256("projection"), sourceSnapshotIds: ["brain:1"], unitCount: 2, status: "active", embeddingProfile: { adapterId: "local", adapterVersion: "1", dimensions: 256, embeddedUnitCount: 2 }, createdAt: now, verifiedAt: now, activatedAt: now },
    benchmark: { contractVersion: "1.0.0", reportId: "bench:passed", suiteId: "suite", implementationId: "v3", status: "passed", sampleSize: 10, metrics: { meanRecallAtK: 1, meanReciprocalRank: 1, authorityAccuracy: 1, citationMembership: 1, authorizationLeakage: 0, degradationRate: 0 }, gates: { minimumMeanRecallAtK: 1, minimumMeanReciprocalRank: 1, minimumAuthorityAccuracy: 1, minimumCitationMembership: 1, maximumAuthorizationLeakage: 0, maximumDegradationRate: 0 }, failures: [], cases: [], recordedAt: now },
    shadow: { comparisonId: "shadow:passed", baselineReportId: "v2", candidateReportId: "v3", status: "promotable", deltas: { meanRecallAtK: 0, meanReciprocalRank: 0, authorityAccuracy: 0, citationMembership: 0, authorizationLeakage: 0, degradationRate: 0 }, blockers: [], comparedAt: now },
    authorizationNegativeTests: { passed: true, leakageCount: 0, receiptId: "acl:passed" },
    citationRegression: { passed: true, invalidCount: 0, receiptId: "citation:passed" },
    sources: [{ sourceId: "granola", bindingId: "granola:staging", bindingState: "active", health: "healthy", qualificationReceiptId: "source:qualified", lastSuccessfulSyncAt: now }],
    currentBriefs: { total: 1, potentiallyStale: 0, oldestSynthesisAt: now },
    backupRestoreReceiptId: "restore:passed",
    rollbackReceiptId: "rollback:passed",
    generatedAt: now,
    minimumEmbeddingCoverage: 1,
  });
  assert.equal(report.status, "ready-for-explicit-activation");
  assert.equal(report.score, 100);
  const blocked = runKnowledgeDoctor({ sources: [], generatedAt: now });
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.checks.some((check) => check.checkId === "authorization-negative-tests" && check.status === "fail"));
});

test("Open Loops service authorizes policies before loading commitment content", async () => {
  const requestedPolicies: string[][] = [];
  const service = new OpenLoopsService({ store: {
    policies: async () => [
      { policyId: "policy:company", policyVersion: 1, visibility: "company", sourceRoot: true, status: "active", entries: [] },
      { policyId: "policy:board", policyVersion: 1, visibility: "restricted_group", sourceRoot: true, status: "active", entries: [{ subjectKind: "group", subjectId: "group:board", permission: "read", effect: "allow" }] },
    ],
    loadOpenLoops: async ({ authorizedPolicyIds }) => {
      requestedPolicies.push(authorizedPolicyIds);
      return [{ claimId: "company-loop", loopKind: "commitment", text: "Prepare the launch review.", state: "open", observedAt: now, authorityLayer: "attributed", evidence: [{ unitId: "claim:company-loop", contentDigest: sha256("Prepare the launch review.") }], accessPolicyId: "policy:company" }];
    },
  } });
  const view = await service.get({ subject: { principalId: "person:employee", principalType: "human", status: "active", groupIds: ["company:active"] }, generatedAt: now });
  assert.deepEqual(requestedPolicies, [["policy:company"]]);
  assert.equal(view.items.length, 1);
});
