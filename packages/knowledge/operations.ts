import { canonicalJson, sha256 } from "../runtime/canonical.ts";

export type KnowledgeOperationKind = "ingestion" | "extraction" | "holder-resolution" | "retrieval" | "synthesis" | "review" | "compounding" | "cleanup" | "recovery";
export type KnowledgeOperationOutcome = "succeeded" | "failed" | "deferred" | "denied" | "degraded";

export interface KnowledgeOperationMetric {
  metricId: string;
  operation: KnowledgeOperationKind;
  outcome: KnowledgeOperationOutcome;
  occurredAt: string;
  durationMs: number;
  queueDelayMs?: number;
  costUsd?: number;
  taskProfile?: string;
  promptIdentity?: string;
  schemaIdentity?: string;
  modelRoute?: string;
  sourceKind?: string;
  reasonCode?: string;
  evidenceDigest: string;
}

export function createKnowledgeOperationMetric(input: Omit<KnowledgeOperationMetric, "metricId" | "evidenceDigest"> & { evidence: Record<string, string | number | boolean | null> }): KnowledgeOperationMetric {
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0 || (input.queueDelayMs !== undefined && (!Number.isFinite(input.queueDelayMs) || input.queueDelayMs < 0)) || (input.costUsd !== undefined && (!Number.isFinite(input.costUsd) || input.costUsd < 0))) throw new Error("Knowledge operation metric contains an invalid duration or cost.");
  if (Number.isNaN(Date.parse(input.occurredAt))) throw new Error("Knowledge operation metric requires an ISO timestamp.");
  const forbidden = /(?:content|query|excerpt|prompt_text|secret|token|password|database_url)/i;
  if (Object.keys(input.evidence).some((key) => forbidden.test(key)) || /postgres(?:ql)?:\/\/|(?:sk|ghp|whsec)_[A-Za-z0-9_-]{12,}/i.test(canonicalJson(input.evidence))) throw new Error("Knowledge operation metrics must not contain payloads or credentials.");
  const evidenceDigest = sha256(input.evidence);
  const base = { operation: input.operation, outcome: input.outcome, occurredAt: new Date(input.occurredAt).toISOString(), durationMs: input.durationMs, ...(input.queueDelayMs === undefined ? {} : { queueDelayMs: input.queueDelayMs }), ...(input.costUsd === undefined ? {} : { costUsd: input.costUsd }), ...(input.taskProfile ? { taskProfile: input.taskProfile } : {}), ...(input.promptIdentity ? { promptIdentity: input.promptIdentity } : {}), ...(input.schemaIdentity ? { schemaIdentity: input.schemaIdentity } : {}), ...(input.modelRoute ? { modelRoute: input.modelRoute } : {}), ...(input.sourceKind ? { sourceKind: input.sourceKind } : {}), ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}), evidenceDigest };
  return { metricId: sha256(base), ...base };
}

export interface KnowledgeSloDefinition {
  minimumSamples: number;
  maximumFailureRate: number;
  maximumP95QueueDelayMs: number;
  maximumP95DurationMs: number;
  maximumSynthesisAgeMs: number;
  minimumHolderResolutionRate: number;
  minimumExtractionAccuracy?: number;
  maximumUnresolvedContradictionRate?: number;
}

export interface KnowledgeQualityObservation {
  observationId: string;
  observedAt: string;
  sourceKind?: string;
  extractionCorrect: number;
  extractionTotal: number;
  contradictionsResolved: number;
  contradictionsTotal: number;
  evidenceDigest: string;
}

export function createKnowledgeQualityObservation(input: Omit<KnowledgeQualityObservation, "observationId" | "evidenceDigest"> & { evidence: Record<string, string | number | boolean | null> }): KnowledgeQualityObservation {
  const counts = [input.extractionCorrect, input.extractionTotal, input.contradictionsResolved, input.contradictionsTotal];
  if (counts.some((value) => !Number.isInteger(value) || value < 0) || input.extractionCorrect > input.extractionTotal || input.contradictionsResolved > input.contradictionsTotal) throw new Error("Knowledge quality observation counts are invalid.");
  const observedAt = new Date(input.observedAt).toISOString();
  const serialized = canonicalJson(input.evidence);
  if (/(?:content|query|excerpt|prompt_text|secret|token|password|database_url)/i.test(Object.keys(input.evidence).join(" ")) || /postgres(?:ql)?:\/\/|(?:sk|ghp|whsec)_[A-Za-z0-9_-]{12,}/i.test(serialized)) throw new Error("Knowledge quality observations must not contain payloads or credentials.");
  const evidenceDigest = sha256(input.evidence);
  const base = { observedAt, ...(input.sourceKind ? { sourceKind: input.sourceKind } : {}), extractionCorrect: input.extractionCorrect, extractionTotal: input.extractionTotal, contradictionsResolved: input.contradictionsResolved, contradictionsTotal: input.contradictionsTotal, evidenceDigest };
  return { observationId: sha256(base), ...base };
}

export interface KnowledgeSloEvaluation {
  evaluationId: string;
  status: "met" | "breached" | "insufficient-evidence";
  window: { from: string; to: string };
  sampleCount: number;
  measurements?: { failureRate: number; p95QueueDelayMs: number; p95DurationMs: number; synthesisAgeMs: number; holderResolutionRate: number; extractionAccuracy?: number; unresolvedContradictionRate?: number };
  breaches: string[];
}

const percentile95 = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? 0;

export function evaluateKnowledgeSlos(input: { definition: KnowledgeSloDefinition; metrics: KnowledgeOperationMetric[]; quality?: KnowledgeQualityObservation[]; window: { from: string; to: string }; latestSynthesisAt?: string; holderResolved: number; holderTotal: number }): KnowledgeSloEvaluation {
  const from = new Date(input.window.from).toISOString(); const to = new Date(input.window.to).toISOString();
  const metrics = input.metrics.filter((metric) => Date.parse(metric.occurredAt) >= Date.parse(from) && Date.parse(metric.occurredAt) <= Date.parse(to));
  const quality = (input.quality ?? []).filter((item) => Date.parse(item.observedAt) >= Date.parse(from) && Date.parse(item.observedAt) <= Date.parse(to));
  const extractionTotal = quality.reduce((sum, item) => sum + item.extractionTotal, 0);
  const contradictionTotal = quality.reduce((sum, item) => sum + item.contradictionsTotal, 0);
  const base = { window: { from, to }, sampleCount: metrics.length };
  if (metrics.length < input.definition.minimumSamples || !input.latestSynthesisAt || input.holderTotal <= 0 || (input.definition.minimumExtractionAccuracy !== undefined && extractionTotal === 0) || (input.definition.maximumUnresolvedContradictionRate !== undefined && contradictionTotal === 0)) {
    const value = { ...base, status: "insufficient-evidence" as const, breaches: [] as string[] };
    return { evaluationId: sha256(value), ...value };
  }
  const measurements = { failureRate: metrics.filter((entry) => entry.outcome === "failed").length / metrics.length, p95QueueDelayMs: percentile95(metrics.map((entry) => entry.queueDelayMs ?? 0)), p95DurationMs: percentile95(metrics.map((entry) => entry.durationMs)), synthesisAgeMs: Math.max(0, Date.parse(to) - Date.parse(input.latestSynthesisAt)), holderResolutionRate: input.holderResolved / input.holderTotal, ...(extractionTotal > 0 ? { extractionAccuracy: quality.reduce((sum, item) => sum + item.extractionCorrect, 0) / extractionTotal } : {}), ...(contradictionTotal > 0 ? { unresolvedContradictionRate: (contradictionTotal - quality.reduce((sum, item) => sum + item.contradictionsResolved, 0)) / contradictionTotal } : {}) };
  const breaches: string[] = [];
  if (measurements.failureRate > input.definition.maximumFailureRate) breaches.push("failure-rate");
  if (measurements.p95QueueDelayMs > input.definition.maximumP95QueueDelayMs) breaches.push("queue-delay-p95");
  if (measurements.p95DurationMs > input.definition.maximumP95DurationMs) breaches.push("duration-p95");
  if (measurements.synthesisAgeMs > input.definition.maximumSynthesisAgeMs) breaches.push("synthesis-freshness");
  if (measurements.holderResolutionRate < input.definition.minimumHolderResolutionRate) breaches.push("holder-resolution");
  if (input.definition.minimumExtractionAccuracy !== undefined && (measurements.extractionAccuracy ?? 0) < input.definition.minimumExtractionAccuracy) breaches.push("extraction-accuracy");
  if (input.definition.maximumUnresolvedContradictionRate !== undefined && (measurements.unresolvedContradictionRate ?? 1) > input.definition.maximumUnresolvedContradictionRate) breaches.push("unresolved-contradictions");
  const value = { ...base, status: breaches.length ? "breached" as const : "met" as const, measurements, breaches };
  return { evaluationId: sha256(value), ...value };
}

export interface KnowledgeSloAlert {
  alertId: string;
  evaluationId: string;
  severity: "warning" | "critical";
  routingKey: string;
  breachCodes: string[];
  createdAt: string;
  status: "open";
}

export function createKnowledgeSloAlert(input: { evaluation: KnowledgeSloEvaluation; severity: "warning" | "critical"; routingKey: string; createdAt: string }): KnowledgeSloAlert {
  if (input.evaluation.status !== "breached" || input.evaluation.breaches.length === 0) throw new Error("Only a breached Knowledge SLO evaluation can create an alert.");
  const routingKey = input.routingKey.trim();
  if (!/^[a-z][a-z0-9._:-]{1,127}$/.test(routingKey)) throw new Error("Knowledge SLO alert routing key is invalid.");
  const base = { evaluationId: input.evaluation.evaluationId, severity: input.severity, routingKey, breachCodes: [...new Set(input.evaluation.breaches)].sort(), createdAt: new Date(input.createdAt).toISOString(), status: "open" as const };
  return { alertId: sha256(base), ...base };
}

export interface KnowledgeRegressionLedger {
  ledgerId: string;
  suite: "prompt" | "schema" | "citation-membership" | "model-routing" | "deterministic-fast-path" | "authorization" | "recovery";
  fixtureVersion: string;
  fixtureDigest: string;
  implementationDigest: string;
  passed: number;
  failed: number;
  modelCalls: number;
  costUsd: number;
  recordedAt: string;
}

export function createKnowledgeRegressionLedger(input: Omit<KnowledgeRegressionLedger, "ledgerId">): KnowledgeRegressionLedger {
  if (input.passed < 0 || input.failed < 0 || input.modelCalls < 0 || input.costUsd < 0 || !Number.isInteger(input.passed) || !Number.isInteger(input.failed) || !Number.isInteger(input.modelCalls)) throw new Error("Knowledge regression counts are invalid.");
  if (input.suite === "deterministic-fast-path" && input.modelCalls !== 0) throw new Error("Deterministic fast-path regression issued a generative model call.");
  if (!/^[a-f0-9]{64}$/.test(input.fixtureDigest) || !/^[a-f0-9]{64}$/.test(input.implementationDigest)) throw new Error("Knowledge regression ledger requires exact fixture and implementation digests.");
  const base = { ...input, recordedAt: new Date(input.recordedAt).toISOString() };
  return { ledgerId: sha256(base), ...base };
}

export interface ConnectorOperationalDiagnostic {
  diagnosticId: string;
  connectorId: string;
  sourceId: string;
  kind: "rate-limit" | "retry" | "acl-drift" | "authorization-denial";
  occurredAt: string;
  reasonCode: string;
  attempt?: number;
  retryAfter?: string;
  expectedDigest?: string;
  observedDigest?: string;
}

export function createConnectorOperationalDiagnostic(input: Omit<ConnectorOperationalDiagnostic, "diagnosticId">): ConnectorOperationalDiagnostic {
  const text = canonicalJson(input);
  if (/postgres(?:ql)?:\/\/|(?:sk|ghp|whsec)_[A-Za-z0-9_-]{12,}|transcript|message.body|email.body/i.test(text)) throw new Error("Connector diagnostic contains payload or credential material.");
  if (Number.isNaN(Date.parse(input.occurredAt)) || (input.retryAfter && Number.isNaN(Date.parse(input.retryAfter)))) throw new Error("Connector diagnostic requires valid timestamps.");
  const base = { ...input, occurredAt: new Date(input.occurredAt).toISOString(), ...(input.retryAfter ? { retryAfter: new Date(input.retryAfter).toISOString() } : {}) };
  return { diagnosticId: sha256(base), ...base };
}

export interface KnowledgeRecoveryQualification {
  receiptId: string;
  backupReceiptId: string;
  exportLedgerId: string;
  coreCommit: string;
  workspaceCommit: string;
  restoredStateDigest: string;
  expectedStateDigest: string;
  rebuiltProjectionDigest: string;
  legalHoldTestReceiptId: string;
  redactionTestReceiptId: string;
  purgeTestReceiptId: string;
  recoveredAt: string;
  status: "qualified";
}

export function qualifyKnowledgeRecovery(input: Omit<KnowledgeRecoveryQualification, "receiptId" | "status">): KnowledgeRecoveryQualification {
  for (const [key, value] of Object.entries(input)) if (typeof value !== "string" || !value.trim()) throw new Error(`Recovery evidence '${key}' is missing.`);
  if (input.restoredStateDigest !== input.expectedStateDigest) throw new Error("Restored Brain state does not match the deterministic export state.");
  if (![input.restoredStateDigest, input.expectedStateDigest, input.rebuiltProjectionDigest].every((value) => /^[a-f0-9]{64}$/.test(value))) throw new Error("Recovery state digests are invalid.");
  const base = { ...input, recoveredAt: new Date(input.recoveredAt).toISOString(), status: "qualified" as const };
  return { receiptId: sha256(base), ...base };
}

export interface KnowledgeCompatibilityWindow {
  contract: string;
  supportedMajors: number[];
  deprecationDate?: string;
}

export function assertKnowledgeCompatibility(input: { window: KnowledgeCompatibilityWindow; requestedVersion: string; now?: string }): void {
  const match = input.requestedVersion.match(/^(\d+)\./); if (!match) throw new Error("Knowledge contract version must use semantic versioning.");
  if (!input.window.supportedMajors.includes(Number(match[1]))) throw new Error(`Unsupported major version '${match[1]}' for '${input.window.contract}'.`);
  if (input.window.deprecationDate && Date.parse(input.now ?? new Date().toISOString()) >= Date.parse(input.window.deprecationDate)) throw new Error(`Compatibility window for '${input.window.contract}' has expired.`);
}
