import { sha256 } from "../runtime/canonical.ts";
import type { KnowledgeBenchComparison, KnowledgeBenchReport } from "./knowledge-bench.ts";
import type { KnowledgeRolloutQualificationReceipt } from "./productization.ts";
import type { KnowledgeRetrievalProjectionMetadataV3 } from "./retrieval-v3.ts";

export const KNOWLEDGE_DOCTOR_CONTRACT_VERSION = "1.0.0" as const;

export interface KnowledgeDoctorCheck {
  checkId: string;
  status: "pass" | "warn" | "fail";
  summary: string;
  evidenceIds: string[];
  remediation?: string;
}

export interface KnowledgeDoctorSourceStatus {
  sourceId: string;
  bindingId: string;
  bindingState: "qualified" | "active" | "inactive" | "revoked" | "error";
  health: "healthy" | "stale" | "error" | "unknown";
  qualificationReceiptId?: string;
  lastSuccessfulSyncAt?: string;
}

export interface KnowledgeDoctorReport {
  contractVersion: typeof KNOWLEDGE_DOCTOR_CONTRACT_VERSION;
  reportId: string;
  status: "ready-for-explicit-activation" | "degraded" | "blocked";
  score: number;
  checks: KnowledgeDoctorCheck[];
  generatedAt: string;
}

const evidence = (values: Array<string | undefined>): string[] => [...new Set(values.filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim()))].sort();

export function runKnowledgeDoctor(input: {
  environment?: KnowledgeRolloutQualificationReceipt;
  rolloutPhase?: "pre-activation" | "post-activation";
  database?: { qualified: boolean; manifestVersion: string; receiptId?: string };
  projection?: KnowledgeRetrievalProjectionMetadataV3;
  benchmark?: KnowledgeBenchReport;
  shadow?: KnowledgeBenchComparison;
  authorizationNegativeTests?: { passed: boolean; leakageCount: number; receiptId?: string };
  citationRegression?: { passed: boolean; invalidCount: number; receiptId?: string };
  sources: readonly KnowledgeDoctorSourceStatus[];
  currentBriefs?: { total: number; potentiallyStale: number; oldestSynthesisAt?: string };
  backupRestoreReceiptId?: string;
  rollbackReceiptId?: string;
  generatedAt: string;
  maximumProjectionAgeMs?: number;
  maximumSourceAgeMs?: number;
  minimumEmbeddingCoverage?: number;
}): KnowledgeDoctorReport {
  const generatedAt = new Date(input.generatedAt).toISOString();
  const now = Date.parse(generatedAt);
  const maximumProjectionAgeMs = input.maximumProjectionAgeMs ?? 24 * 60 * 60 * 1_000;
  const maximumSourceAgeMs = input.maximumSourceAgeMs ?? 24 * 60 * 60 * 1_000;
  const minimumEmbeddingCoverage = input.minimumEmbeddingCoverage ?? 0;
  if (![maximumProjectionAgeMs, maximumSourceAgeMs].every((value) => Number.isFinite(value) && value > 0) || !Number.isFinite(minimumEmbeddingCoverage) || minimumEmbeddingCoverage < 0 || minimumEmbeddingCoverage > 1) throw new Error("Knowledge Doctor thresholds are invalid.");
  const checks: KnowledgeDoctorCheck[] = [];
  const add = (checkId: string, status: KnowledgeDoctorCheck["status"], summary: string, evidenceIds: Array<string | undefined> = [], remediation?: string) => checks.push({ checkId, status, summary, evidenceIds: evidence(evidenceIds), ...(remediation ? { remediation } : {}) });

  const rolloutQualified = input.environment?.status === "qualified" || input.environment?.status === "qualified-for-production-canary";
  add("rollout-lane", rolloutQualified ? "pass" : "fail",
    input.environment?.status === "qualified"
      ? "Non-production environment isolation is qualified."
      : input.environment?.status === "qualified-for-production-canary"
        ? "Internal-only production canary controls are qualified."
        : "No qualified Knowledge rollout lane evidence is available.",
    [input.environment?.receiptId], "Qualify either the strict isolated non-production lane or the internal-only production-canary lane with its branch rehearsal, backup, shadow, and V2 fallback controls.");

  const compatibleDatabaseManifests = new Set(["1.8.0", "1.9.0"]);
  const databaseReady = Boolean(input.database?.qualified) && compatibleDatabaseManifests.has(input.database?.manifestVersion ?? "");
  add("database-manifest", databaseReady ? "pass" : "fail",
    databaseReady ? `Compatible database manifest ${input.database!.manifestVersion} is qualified.` : input.database?.qualified ? `Database manifest ${input.database.manifestVersion} is qualified but is not a compatible Retrieval V3 target.` : "Database manifest qualification is missing or failed.",
    [input.database?.receiptId], "Run the secret-bound additive database prepare operation and record a compatible 1.8.0 or 1.9.0 qualification receipt.");

  const requiredProjectionStatus = input.rolloutPhase === "post-activation" ? "active" : "verified";
  const projectionReady = input.projection && (input.projection.status === "active" || (requiredProjectionStatus === "verified" && input.projection.status === "verified"));
  if (!input.projection || !projectionReady) add("retrieval-projection", "fail", requiredProjectionStatus === "active" ? "No active verified Retrieval V3 projection is available." : "No verified Retrieval V3 projection is available for pre-activation qualification.", [], "Build and verify one derived Retrieval V3 projection, run the qualification gates, and activate it only after the pre-activation Doctor passes.");
  else {
    const referenceTime = input.projection.activatedAt ?? input.projection.verifiedAt ?? input.projection.createdAt;
    const age = Math.max(0, now - Date.parse(referenceTime));
    add("retrieval-projection", age <= maximumProjectionAgeMs && input.projection.unitCount > 0 ? "pass" : "fail",
      input.projection.unitCount === 0 ? "Retrieval V3 projection contains no units." : age <= maximumProjectionAgeMs ? `${input.projection.status === "active" ? "Active" : "Verified"} Retrieval V3 projection is populated and fresh.` : "Retrieval V3 projection is stale.",
      [input.projection.projectionHash], "Rebuild from the current Handbook and durable Brain frontier, verify counts, and rerun KnowledgeBench.");
    const coverage = input.projection.unitCount === 0 ? 0 : (input.projection.embeddingProfile?.embeddedUnitCount ?? 0) / input.projection.unitCount;
    const embeddingStatus: KnowledgeDoctorCheck["status"] = minimumEmbeddingCoverage === 0 && !input.projection.embeddingProfile ? "warn" : coverage >= minimumEmbeddingCoverage ? "pass" : "warn";
    add("embedding-coverage", embeddingStatus, input.projection.embeddingProfile ? `Retrieval embedding coverage is ${(coverage * 100).toFixed(1)}%.` : "Retrieval is lexical-only; this is safe but degraded.", [input.projection.embeddingProfile ? `${input.projection.embeddingProfile.adapterId}@${input.projection.embeddingProfile.adapterVersion}` : undefined], "Qualify one allowed embedding profile and rebuild embeddings; keep lexical fallback enabled.");
  }

  add("knowledge-bench", input.benchmark?.status === "passed" ? "pass" : "fail",
    input.benchmark ? `KnowledgeBench status is ${input.benchmark.status} with ${input.benchmark.sampleSize} cases.` : "KnowledgeBench evidence is missing.",
    [input.benchmark?.reportId], "Run the exact staging suite and meet recall, rank, authority, citation, degradation, and zero-leak gates.");

  add("shadow-comparison", input.shadow?.status === "promotable" ? "pass" : "fail",
    input.shadow ? `Shadow comparison is ${input.shadow.status}.` : "Retrieval V2 versus V3 shadow comparison evidence is missing.",
    [input.shadow?.comparisonId], "Run V2 and V3 on the same authorized fixture set and block activation on any security, citation, authority, recall, or rank regression.");

  const authorizationPass = Boolean(input.authorizationNegativeTests?.passed) && input.authorizationNegativeTests?.leakageCount === 0;
  add("authorization-negative-tests", authorizationPass ? "pass" : "fail",
    input.authorizationNegativeTests ? `Authorization negative tests reported ${input.authorizationNegativeTests.leakageCount} leak(s).` : "Authorization negative-test evidence is missing.",
    [input.authorizationNegativeTests?.receiptId], "Prove inaccessible units remain absent from exact, lexical, semantic, graph, Current Brief, citation, and answer paths.");

  const citationsPass = Boolean(input.citationRegression?.passed) && input.citationRegression?.invalidCount === 0;
  add("citation-membership", citationsPass ? "pass" : "fail",
    input.citationRegression ? `Citation regression reported ${input.citationRegression.invalidCount} invalid citation(s).` : "Citation regression evidence is missing.",
    [input.citationRegression?.receiptId], "Require every answer citation and claim to match one exact authorized context identity and digest.");

  if (input.sources.length === 0) add("source-bindings", "fail", "No qualified Source binding evidence is available.", [], "Qualify at least one read-only Source binding in non-production.");
  else {
    const unhealthy = input.sources.filter((source) => !["qualified", "active"].includes(source.bindingState) || source.health === "error" || !source.qualificationReceiptId);
    const stale = input.sources.filter((source) => !source.lastSuccessfulSyncAt || now - Date.parse(source.lastSuccessfulSyncAt) > maximumSourceAgeMs);
    add("source-bindings", unhealthy.length > 0 ? "fail" : stale.length > 0 ? "warn" : "pass",
      unhealthy.length > 0 ? `${unhealthy.length} Source binding(s) are unqualified or unhealthy.` : stale.length > 0 ? `${stale.length} Source binding(s) are stale.` : "All Source bindings are qualified and fresh.",
      input.sources.flatMap((source) => [source.qualificationReceiptId]), "Repair or revoke unhealthy bindings, reconcile them, and record fresh qualification receipts.");
  }

  const briefTotal = input.currentBriefs?.total ?? 0;
  const staleBriefs = input.currentBriefs?.potentiallyStale ?? 0;
  add("current-brief-freshness", briefTotal === 0 ? "warn" : staleBriefs === 0 ? "pass" : "warn",
    briefTotal === 0 ? "No Current Brief has been generated yet." : staleBriefs === 0 ? "All observed Current Briefs are current." : `${staleBriefs} of ${briefTotal} Current Briefs are potentially stale.`,
    [input.currentBriefs?.oldestSynthesisAt], "Refresh only materially changed Working Syntheses; preserve immutable prior versions and citations.");

  add("backup-restore", input.backupRestoreReceiptId ? "pass" : "fail", input.backupRestoreReceiptId ? "Backup restoration is qualified." : "Backup restoration evidence is missing.", [input.backupRestoreReceiptId], "Restore the exact staging backup, rebuild derived projections, and compare durable state digests.");
  add("rollback", input.rollbackReceiptId ? "pass" : "fail", input.rollbackReceiptId ? "Runtime and retrieval rollback is qualified." : "Rollback evidence is missing.", [input.rollbackReceiptId], "Exercise rollback to the prior immutable Artifact and verified retrieval projection.");

  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  const score = checks.length === 0 ? 0 : Number((100 * checks.reduce((sum, check) => sum + (check.status === "pass" ? 1 : check.status === "warn" ? 0.5 : 0), 0) / checks.length).toFixed(1));
  const base = { contractVersion: KNOWLEDGE_DOCTOR_CONTRACT_VERSION, status: failures > 0 ? "blocked" as const : warnings > 0 ? "degraded" as const : "ready-for-explicit-activation" as const, score, checks, generatedAt };
  return { reportId: sha256(base), ...base };
}
