import { sha256 } from "../runtime/canonical.ts";
import type { KnowledgeAccessSubject } from "./contracts.ts";
import type { KnowledgeAuthorityLayer } from "./retrieval-unit.ts";

export const KNOWLEDGE_BENCH_CONTRACT_VERSION = "1.0.0" as const;

export interface KnowledgeBenchCase {
  caseId: string;
  query: string;
  subject?: KnowledgeAccessSubject;
  expectedUnitIds: string[];
  forbiddenUnitIds?: string[];
  expectedAuthority?: Record<string, KnowledgeAuthorityLayer>;
  limit?: number;
  mode?: "lexical" | "hybrid";
}

export interface KnowledgeBenchHit {
  unitId: string;
  contentDigest: string;
  authorityLayer: KnowledgeAuthorityLayer;
  citation: { unitId: string; contentDigest: string };
}

export interface KnowledgeBenchSearchResult {
  hits: KnowledgeBenchHit[];
  degradations: string[];
}

export interface KnowledgeBenchGates {
  minimumMeanRecallAtK: number;
  minimumMeanReciprocalRank: number;
  minimumAuthorityAccuracy: number;
  minimumCitationMembership: number;
  maximumAuthorizationLeakage: number;
  maximumDegradationRate: number;
}

export interface KnowledgeBenchCaseResult {
  caseId: string;
  queryDigest: string;
  expectedCount: number;
  returnedCount: number;
  matchedCount: number;
  recallAtK: number;
  reciprocalRank: number;
  authorityCorrect: number;
  authorityTotal: number;
  citationCorrect: number;
  citationTotal: number;
  authorizationLeakage: number;
  degradationCount: number;
  expectedIdentityDigests: string[];
  returnedIdentityDigests: string[];
}

export interface KnowledgeBenchReport {
  contractVersion: typeof KNOWLEDGE_BENCH_CONTRACT_VERSION;
  reportId: string;
  suiteId: string;
  implementationId: string;
  status: "passed" | "failed" | "insufficient-evidence";
  sampleSize: number;
  metrics: {
    meanRecallAtK: number;
    meanReciprocalRank: number;
    authorityAccuracy: number;
    citationMembership: number;
    authorizationLeakage: number;
    degradationRate: number;
  };
  gates: KnowledgeBenchGates;
  failures: string[];
  cases: KnowledgeBenchCaseResult[];
  recordedAt: string;
}

const boundedRate = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between zero and one.`);
  return value;
};

const rate = (numerator: number, denominator: number, empty = 1): number => denominator === 0 ? empty : numerator / denominator;
const mean = (values: number[]): number => values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
const fixed = (value: number): number => Number(value.toFixed(8));
const identityDigest = (identity: string): string => sha256({ identity });

const normalizeGates = (input: KnowledgeBenchGates): KnowledgeBenchGates => ({
  minimumMeanRecallAtK: boundedRate(input.minimumMeanRecallAtK, "KnowledgeBench recall gate"),
  minimumMeanReciprocalRank: boundedRate(input.minimumMeanReciprocalRank, "KnowledgeBench reciprocal-rank gate"),
  minimumAuthorityAccuracy: boundedRate(input.minimumAuthorityAccuracy, "KnowledgeBench authority gate"),
  minimumCitationMembership: boundedRate(input.minimumCitationMembership, "KnowledgeBench citation gate"),
  maximumAuthorizationLeakage: (() => {
    if (!Number.isInteger(input.maximumAuthorizationLeakage) || input.maximumAuthorizationLeakage < 0) throw new Error("KnowledgeBench authorization-leakage gate must be a non-negative integer.");
    return input.maximumAuthorizationLeakage;
  })(),
  maximumDegradationRate: boundedRate(input.maximumDegradationRate, "KnowledgeBench degradation gate"),
});

const assertCase = (input: KnowledgeBenchCase): KnowledgeBenchCase => {
  const caseId = input.caseId.trim();
  const query = input.query.trim();
  if (!caseId || !query || caseId.length > 200 || query.length > 4_000) throw new Error("KnowledgeBench case identity or query is invalid.");
  const expectedUnitIds = [...new Set(input.expectedUnitIds.map((value) => value.trim()).filter(Boolean))].sort();
  if (expectedUnitIds.length === 0 || expectedUnitIds.length !== input.expectedUnitIds.length) throw new Error(`KnowledgeBench case '${caseId}' requires distinct expected identities.`);
  const forbiddenUnitIds = [...new Set((input.forbiddenUnitIds ?? []).map((value) => value.trim()).filter(Boolean))].sort();
  if (forbiddenUnitIds.length !== (input.forbiddenUnitIds ?? []).length) throw new Error(`KnowledgeBench case '${caseId}' has duplicate forbidden identities.`);
  if (forbiddenUnitIds.some((identity) => expectedUnitIds.includes(identity))) throw new Error(`KnowledgeBench case '${caseId}' cannot expect and forbid the same identity.`);
  const expectedAuthority = { ...(input.expectedAuthority ?? {}) };
  if (Object.keys(expectedAuthority).some((identity) => !expectedUnitIds.includes(identity))) throw new Error(`KnowledgeBench case '${caseId}' labels a non-expected identity.`);
  return { ...input, caseId, query, expectedUnitIds, forbiddenUnitIds, expectedAuthority, limit: Math.max(1, Math.min(input.limit ?? 5, 50)), mode: input.mode ?? "hybrid" };
};

export async function runKnowledgeBench(input: {
  suiteId: string;
  implementationId: string;
  cases: readonly KnowledgeBenchCase[];
  gates: KnowledgeBenchGates;
  search: (input: { query: string; subject?: KnowledgeAccessSubject; limit: number; mode: "lexical" | "hybrid" }) => Promise<KnowledgeBenchSearchResult>;
  recordedAt: string;
}): Promise<KnowledgeBenchReport> {
  const suiteId = input.suiteId.trim();
  const implementationId = input.implementationId.trim();
  if (!suiteId || !implementationId) throw new Error("KnowledgeBench requires suite and implementation identities.");
  const gates = normalizeGates(input.gates);
  const cases = [...input.cases].map(assertCase).sort((left, right) => left.caseId.localeCompare(right.caseId));
  if (new Set(cases.map((entry) => entry.caseId)).size !== cases.length) throw new Error("KnowledgeBench case identities must be unique.");
  const results: KnowledgeBenchCaseResult[] = [];
  for (const entry of cases) {
    const searched = await input.search({ query: entry.query, subject: entry.subject, limit: entry.limit!, mode: entry.mode! });
    const hits = searched.hits.slice(0, entry.limit);
    const actual = hits.map((hit) => hit.unitId);
    const matched = entry.expectedUnitIds.filter((identity) => actual.includes(identity));
    const firstRank = hits.findIndex((hit) => entry.expectedUnitIds.includes(hit.unitId));
    const authority = Object.entries(entry.expectedAuthority ?? {});
    const authorityCorrect = authority.filter(([identity, layer]) => hits.find((hit) => hit.unitId === identity)?.authorityLayer === layer).length;
    const citationCorrect = hits.filter((hit) => hit.citation.unitId === hit.unitId && hit.citation.contentDigest === hit.contentDigest).length;
    const authorizationLeakage = hits.filter((hit) => entry.forbiddenUnitIds?.includes(hit.unitId)).length;
    results.push({
      caseId: entry.caseId,
      queryDigest: sha256(entry.query),
      expectedCount: entry.expectedUnitIds.length,
      returnedCount: hits.length,
      matchedCount: matched.length,
      recallAtK: fixed(rate(matched.length, entry.expectedUnitIds.length, 0)),
      reciprocalRank: firstRank < 0 ? 0 : fixed(1 / (firstRank + 1)),
      authorityCorrect,
      authorityTotal: authority.length,
      citationCorrect,
      citationTotal: hits.length,
      authorizationLeakage,
      degradationCount: searched.degradations.length,
      expectedIdentityDigests: entry.expectedUnitIds.map(identityDigest).sort(),
      returnedIdentityDigests: actual.map(identityDigest),
    });
  }
  const authorityCorrect = results.reduce((sum, entry) => sum + entry.authorityCorrect, 0);
  const authorityTotal = results.reduce((sum, entry) => sum + entry.authorityTotal, 0);
  const citationCorrect = results.reduce((sum, entry) => sum + entry.citationCorrect, 0);
  const citationTotal = results.reduce((sum, entry) => sum + entry.citationTotal, 0);
  const metrics = {
    meanRecallAtK: fixed(mean(results.map((entry) => entry.recallAtK))),
    meanReciprocalRank: fixed(mean(results.map((entry) => entry.reciprocalRank))),
    authorityAccuracy: fixed(rate(authorityCorrect, authorityTotal)),
    citationMembership: fixed(rate(citationCorrect, citationTotal)),
    authorizationLeakage: results.reduce((sum, entry) => sum + entry.authorizationLeakage, 0),
    degradationRate: fixed(rate(results.filter((entry) => entry.degradationCount > 0).length, results.length, 0)),
  };
  const failures: string[] = [];
  if (results.length > 0) {
    if (metrics.meanRecallAtK < gates.minimumMeanRecallAtK) failures.push("recall-at-k");
    if (metrics.meanReciprocalRank < gates.minimumMeanReciprocalRank) failures.push("reciprocal-rank");
    if (metrics.authorityAccuracy < gates.minimumAuthorityAccuracy) failures.push("authority-labeling");
    if (metrics.citationMembership < gates.minimumCitationMembership) failures.push("citation-membership");
    if (metrics.authorizationLeakage > gates.maximumAuthorizationLeakage) failures.push("authorization-leakage");
    if (metrics.degradationRate > gates.maximumDegradationRate) failures.push("degradation-rate");
  }
  const recordedAt = new Date(input.recordedAt).toISOString();
  const base = {
    contractVersion: KNOWLEDGE_BENCH_CONTRACT_VERSION,
    suiteId,
    implementationId,
    status: results.length === 0 ? "insufficient-evidence" as const : failures.length === 0 ? "passed" as const : "failed" as const,
    sampleSize: results.length,
    metrics,
    gates,
    failures,
    cases: results,
    recordedAt,
  };
  return { reportId: sha256(base), ...base };
}

export interface KnowledgeBenchComparison {
  comparisonId: string;
  baselineReportId: string;
  candidateReportId: string;
  status: "promotable" | "blocked";
  deltas: {
    meanRecallAtK: number;
    meanReciprocalRank: number;
    authorityAccuracy: number;
    citationMembership: number;
    authorizationLeakage: number;
    degradationRate: number;
  };
  blockers: string[];
  comparedAt: string;
}

export function compareKnowledgeBench(input: { baseline: KnowledgeBenchReport; candidate: KnowledgeBenchReport; comparedAt: string }): KnowledgeBenchComparison {
  if (input.baseline.suiteId !== input.candidate.suiteId || input.baseline.sampleSize !== input.candidate.sampleSize) throw new Error("KnowledgeBench comparison requires the same suite and sample size.");
  const deltas = {
    meanRecallAtK: fixed(input.candidate.metrics.meanRecallAtK - input.baseline.metrics.meanRecallAtK),
    meanReciprocalRank: fixed(input.candidate.metrics.meanReciprocalRank - input.baseline.metrics.meanReciprocalRank),
    authorityAccuracy: fixed(input.candidate.metrics.authorityAccuracy - input.baseline.metrics.authorityAccuracy),
    citationMembership: fixed(input.candidate.metrics.citationMembership - input.baseline.metrics.citationMembership),
    authorizationLeakage: input.candidate.metrics.authorizationLeakage - input.baseline.metrics.authorizationLeakage,
    degradationRate: fixed(input.candidate.metrics.degradationRate - input.baseline.metrics.degradationRate),
  };
  const blockers: string[] = [];
  if (input.candidate.status !== "passed") blockers.push("candidate-gates");
  if (input.candidate.metrics.authorizationLeakage > 0 || deltas.authorizationLeakage > 0) blockers.push("authorization-regression");
  if (input.candidate.metrics.citationMembership < 1 || deltas.citationMembership < 0) blockers.push("citation-regression");
  if (deltas.meanRecallAtK < 0) blockers.push("recall-regression");
  if (deltas.meanReciprocalRank < 0) blockers.push("ranking-regression");
  if (deltas.authorityAccuracy < 0) blockers.push("authority-regression");
  const comparedAt = new Date(input.comparedAt).toISOString();
  const base = { baselineReportId: input.baseline.reportId, candidateReportId: input.candidate.reportId, status: blockers.length === 0 ? "promotable" as const : "blocked" as const, deltas, blockers, comparedAt };
  return { comparisonId: sha256(base), ...base };
}
