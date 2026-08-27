import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256 } from "../../runtime/canonical.ts";
import { assertKnowledgeCompatibility, createConnectorOperationalDiagnostic, createKnowledgeOperationMetric, createKnowledgeQualityObservation, createKnowledgeRegressionLedger, createKnowledgeSloAlert, evaluateKnowledgeSlos, qualifyKnowledgeRecovery } from "../../knowledge/operations.ts";

const now = "2026-08-26T12:00:00.000Z";

test("operational metrics are payload-free and SLOs require a real observation window", () => {
  const metrics = Array.from({ length: 20 }, (_, index) => createKnowledgeOperationMetric({ operation: "extraction", outcome: index === 19 ? "failed" : "succeeded", occurredAt: now, durationMs: 100 + index, queueDelayMs: 20, costUsd: 0.01, taskProfile: "reasoning", promptIdentity: "knowledge.claim-extraction@1", schemaIdentity: "knowledge.claim-extraction.output@1", modelRoute: "qualified", sourceKind: "meeting", evidence: { run_count: 1, source_count: 1 } }));
  assert.throws(() => createKnowledgeOperationMetric({ operation: "ingestion", outcome: "succeeded", occurredAt: now, durationMs: 1, evidence: { transcript_content: "secret" } }), /must not contain payloads/i);
  const insufficient = evaluateKnowledgeSlos({ definition: { minimumSamples: 25, maximumFailureRate: 0.1, maximumP95QueueDelayMs: 100, maximumP95DurationMs: 500, maximumSynthesisAgeMs: 86_400_000, minimumHolderResolutionRate: 0.8 }, metrics, window: { from: "2026-08-26T00:00:00Z", to: "2026-08-27T00:00:00Z" }, holderResolved: 9, holderTotal: 10 });
  assert.equal(insufficient.status, "insufficient-evidence");
  const met = evaluateKnowledgeSlos({ definition: { minimumSamples: 20, maximumFailureRate: 0.1, maximumP95QueueDelayMs: 100, maximumP95DurationMs: 500, maximumSynthesisAgeMs: 86_400_000, minimumHolderResolutionRate: 0.8 }, metrics, window: { from: "2026-08-26T00:00:00Z", to: "2026-08-27T00:00:00Z" }, latestSynthesisAt: now, holderResolved: 9, holderTotal: 10 });
  assert.equal(met.status, "met");
});

test("regression ledgers prove deterministic paths issued no model call", () => {
  const ledger = createKnowledgeRegressionLedger({ suite: "deterministic-fast-path", fixtureVersion: "1", fixtureDigest: sha256("fixtures"), implementationDigest: sha256("implementation"), passed: 20, failed: 0, modelCalls: 0, costUsd: 0, recordedAt: now });
  assert.match(ledger.ledgerId, /^[a-f0-9]{64}$/);
  const { ledgerId: _ledgerId, ...ledgerInput } = ledger;
  assert.throws(() => createKnowledgeRegressionLedger({ ...ledgerInput, modelCalls: 1 }), /issued a generative model call/i);
});

test("quality observations measure extraction and contradiction SLOs and emit deterministic alert candidates", () => {
  const metrics = Array.from({ length: 10 }, () => createKnowledgeOperationMetric({ operation: "extraction", outcome: "succeeded", occurredAt: now, durationMs: 100, evidence: { run_count: 1 } }));
  const quality = [createKnowledgeQualityObservation({ observedAt: now, sourceKind: "meeting", extractionCorrect: 7, extractionTotal: 10, contradictionsResolved: 2, contradictionsTotal: 5, evidence: { reviewed_count: 10, contradiction_count: 5 } })];
  const evaluation = evaluateKnowledgeSlos({ definition: { minimumSamples: 10, maximumFailureRate: 0.1, maximumP95QueueDelayMs: 100, maximumP95DurationMs: 500, maximumSynthesisAgeMs: 86_400_000, minimumHolderResolutionRate: 0.8, minimumExtractionAccuracy: 0.9, maximumUnresolvedContradictionRate: 0.2 }, metrics, quality, window: { from: "2026-08-26T00:00:00Z", to: "2026-08-27T00:00:00Z" }, latestSynthesisAt: now, holderResolved: 9, holderTotal: 10 });
  assert.equal(evaluation.status, "breached");
  assert.deepEqual(evaluation.breaches, ["extraction-accuracy", "unresolved-contradictions"]);
  const alert = createKnowledgeSloAlert({ evaluation, severity: "critical", routingKey: "company-knowledge.oncall", createdAt: now });
  assert.deepEqual(alert.breachCodes, ["extraction-accuracy", "unresolved-contradictions"]);
  assert.match(alert.alertId, /^[a-f0-9]{64}$/);
  assert.throws(() => createKnowledgeQualityObservation({ observedAt: now, extractionCorrect: 2, extractionTotal: 1, contradictionsResolved: 0, contradictionsTotal: 0, evidence: {} }), /counts are invalid/i);
});

test("Connector diagnostics and recovery receipts contain bounded non-secret evidence", () => {
  const diagnostic = createConnectorOperationalDiagnostic({ connectorId: "oregano/granola-meeting-source", sourceId: "meetings", kind: "rate-limit", occurredAt: now, reasonCode: "provider-429", attempt: 2, retryAfter: "2026-08-26T12:00:10Z" });
  assert.match(diagnostic.diagnosticId, /^[a-f0-9]{64}$/);
  assert.throws(() => createConnectorOperationalDiagnostic({ connectorId: "connector", sourceId: "source", kind: "retry", occurredAt: now, reasonCode: "ghp_abcdefghijklmnopqrstuvwxyz" }), /credential material/i);
  const state = sha256("state");
  const recovery = qualifyKnowledgeRecovery({ backupReceiptId: "backup:1", exportLedgerId: "export:1", coreCommit: "a".repeat(40), workspaceCommit: "b".repeat(40), restoredStateDigest: state, expectedStateDigest: state, rebuiltProjectionDigest: sha256("projection"), legalHoldTestReceiptId: "legal-hold:1", redactionTestReceiptId: "redaction:1", purgeTestReceiptId: "purge:1", recoveredAt: now });
  assert.equal(recovery.status, "qualified");
  const { receiptId: _receiptId, status: _status, ...recoveryInput } = recovery;
  assert.throws(() => qualifyKnowledgeRecovery({ ...recoveryInput, restoredStateDigest: sha256("different") }), /does not match/i);
});

test("compatibility windows reject unknown majors and expired support", () => {
  assert.doesNotThrow(() => assertKnowledgeCompatibility({ window: { contract: "knowledge-retrieval", supportedMajors: [2], deprecationDate: "2027-01-01T00:00:00Z" }, requestedVersion: "2.0.0", now }));
  assert.throws(() => assertKnowledgeCompatibility({ window: { contract: "knowledge-retrieval", supportedMajors: [2] }, requestedVersion: "3.0.0", now }), /Unsupported major/i);
  assert.throws(() => assertKnowledgeCompatibility({ window: { contract: "knowledge-retrieval", supportedMajors: [2], deprecationDate: "2026-01-01T00:00:00Z" }, requestedVersion: "2.0.0", now }), /expired/i);
});
