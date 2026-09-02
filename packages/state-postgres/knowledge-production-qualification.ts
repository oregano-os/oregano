import { neon } from "@neondatabase/serverless";
import { KnowledgeAuthorizer } from "../knowledge/access-control.ts";
import { compareKnowledgeBench, runKnowledgeBench, type KnowledgeBenchHit, type KnowledgeBenchReport } from "../knowledge/knowledge-bench.ts";
import { runKnowledgeDoctor, type KnowledgeDoctorSourceStatus } from "../knowledge/knowledge-doctor.ts";
import {
  createKnowledgeOperationalGateReceipt,
  qualifyKnowledgeProductizationActivation,
  qualifyProductionKnowledgeCanary,
  type KnowledgeOperationalGateReceipt,
} from "../knowledge/productization.ts";
import { CurrentBriefService } from "../knowledge/current-brief.ts";
import { LocalHashEmbeddingAdapter } from "../knowledge/embedding.ts";
import {
  createExtractiveKnowledgeAnswerV3,
  KnowledgeRetrievalServiceV3,
  validateKnowledgeAnswerEnvelopeV3,
} from "../knowledge/retrieval-v3.ts";
import type { KnowledgeAccessSubject, KnowledgeProvider, KnowledgeSearchHit } from "../knowledge/contracts.ts";
import type { KnowledgeAuthorityLayer, KnowledgeRetrievalUnitV3 } from "../knowledge/retrieval-unit.ts";
import { createUnifiedKnowledgeProvider } from "../knowledge/unified-provider.ts";
import { sha256 } from "../runtime/canonical.ts";
import { PostgresBrainKnowledgeProjectionStore } from "./brain-retrieval-store.ts";
import { qualifyCompanyDatabase } from "./database-bootstrap.ts";
import { PostgresKnowledgeAccessAuditor, enrichPostgresKnowledgeSubject } from "./knowledge-access-store.ts";
import {
  createPostgresKnowledgeCanaryProvider,
  createPostgresKnowledgeProviderV3,
  resolveKnowledgeRetrievalRuntimeSelection,
  type KnowledgeRetrievalRuntimeSelection,
} from "./knowledge-canary-provider.ts";
import { PostgresKnowledgeProductizationStore } from "./knowledge-productization-store.ts";
import { PostgresKnowledgeRetrievalV3Store } from "./knowledge-retrieval-v3-store.ts";
import { createPostgresKnowledgeProvider } from "./knowledge-store.ts";
import { postgresTimestampToIso } from "./postgres-values.ts";

type Row = Record<string, unknown>;

const connection = () => {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is not set — production Knowledge qualification requires the existing Company Instance database.");
  return neon(value);
};

const activeCompanySubject = (agentId: string): KnowledgeAccessSubject => ({
  principalId: `service:${agentId}`,
  principalType: "service",
  status: "active",
  groupIds: ["company:active"],
});

const unresolvedSubject: KnowledgeAccessSubject = {
  principalId: "service:knowledge-qualification-unresolved",
  principalType: "service",
  status: "unresolved",
  groupIds: [],
};

const compactQuery = (value: string): string => value.replace(/[\0-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);

const queryForUnit = (unit: KnowledgeRetrievalUnitV3, titleCounts: ReadonlyMap<string, number>, aliasCounts: ReadonlyMap<string, number>): string => {
  const aliases = unit.aliases.map(compactQuery).filter((value) => value.length >= 6 && value.length <= 160);
  const uniqueAlias = aliases.find((value) => aliasCounts.get(value.toLocaleLowerCase()) === 1);
  if (uniqueAlias) return uniqueAlias;
  const title = compactQuery(unit.title);
  if (title.length >= 6 && titleCounts.get(title.toLocaleLowerCase()) === 1) return title;
  return compactQuery(unit.text.split(/\s+/).slice(0, 12).join(" "));
};

type QualificationSample = {
  unit: KnowledgeRetrievalUnitV3;
  query: string;
  relevance: "exact-unit" | "same-timeline";
};

const relevanceForUnit = (unit: KnowledgeRetrievalUnitV3): QualificationSample["relevance"] =>
  unit.kind === "timeline-event" && unit.parentId ? "same-timeline" : "exact-unit";

const relevanceIdentity = (sample: QualificationSample): string =>
  sample.relevance === "same-timeline" ? sample.unit.parentId : sample.unit.unitId;

const selectQualificationUnits = (units: readonly KnowledgeRetrievalUnitV3[], authorizedPolicyIds: ReadonlySet<string>, maximum = 18): QualificationSample[] => {
  const eligible = units.filter((unit) => authorizedPolicyIds.has(unit.accessPolicyId) && !["expired", "superseded"].includes(unit.state));
  const count = (values: string[]) => values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map<string, number>());
  const titleCounts = count(eligible.map((unit) => compactQuery(unit.title).toLocaleLowerCase()));
  const aliasCounts = count(eligible.flatMap((unit) => unit.aliases.map((alias) => compactQuery(alias).toLocaleLowerCase()).filter(Boolean)));
  const scored = eligible.map((unit) => ({
    unit,
    query: queryForUnit(unit, titleCounts, aliasCounts),
    score: unit.signals.authority + unit.signals.confidence + unit.signals.freshness + unit.signals.expectedValue,
  })).filter((entry) => entry.query.length >= 6)
    .sort((left, right) => right.score - left.score || right.unit.observedAt.localeCompare(left.unit.observedAt) || left.unit.unitId.localeCompare(right.unit.unitId));
  const selected: typeof scored = [];
  const perKind = new Map<string, number>();
  for (const entry of scored) {
    if ((perKind.get(entry.unit.kind) ?? 0) >= 3) continue;
    selected.push(entry);
    perKind.set(entry.unit.kind, (perKind.get(entry.unit.kind) ?? 0) + 1);
    if (selected.length >= maximum) break;
  }
  if (selected.length < Math.min(8, eligible.length)) {
    for (const entry of scored) {
      if (selected.some((value) => value.unit.unitId === entry.unit.unitId)) continue;
      selected.push(entry);
      if (selected.length >= Math.min(maximum, Math.max(8, eligible.length))) break;
    }
  }
  return selected.map(({ unit, query }) => ({ unit, query, relevance: relevanceForUnit(unit) }));
};

const authorityByUnit = (units: readonly KnowledgeRetrievalUnitV3[]): Map<string, KnowledgeAuthorityLayer> =>
  new Map(units.map((unit) => [unit.unitId, unit.authorityLayer]));

const benchmarkHit = (hit: KnowledgeSearchHit, unitId: string, authorities: ReadonlyMap<string, KnowledgeAuthorityLayer>): KnowledgeBenchHit => ({
  unitId,
  contentDigest: hit.citation.digest,
  authorityLayer: authorities.get(unitId) ?? "evidence",
  citation: { unitId, contentDigest: hit.citation.digest },
});

const benchmarkSearch = (input: {
  provider: KnowledgeProvider;
  authorities: ReadonlyMap<string, KnowledgeAuthorityLayer>;
  resolveUnitId: (hit: KnowledgeSearchHit, query: string) => string | undefined;
}) => async (request: { query: string; subject?: KnowledgeAccessSubject; limit: number; mode: "lexical" | "hybrid" }) => {
  const result = await input.provider.search(request);
  return {
    hits: result.hits.flatMap((hit) => {
      const unitId = input.resolveUnitId(hit, request.query);
      return unitId ? [benchmarkHit(hit, unitId, input.authorities)] : [];
    }),
    degradations: result.degradations,
  };
};

const sourceQualification = async (input: {
  units: readonly KnowledgeRetrievalUnitV3[];
  recordedAt: string;
  evidenceStore: PostgresKnowledgeProductizationStore;
}): Promise<{ sourceBindingIds: string[]; statuses: KnowledgeDoctorSourceStatus[]; receiptIds: string[] }> => {
  const rows = await connection()`select source_id, connector_id, connector_version, binding, status, last_successful_sync
    from companyos_knowledge.sources order by source_id`;
  const counts = new Map<string, number>();
  for (const unit of input.units) for (const sourceId of unit.sourceIds) counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1);
  const statuses: KnowledgeDoctorSourceStatus[] = [];
  const receiptIds: string[] = [];
  const sourceBindingIds: string[] = [];
  for (const row of rows as Row[]) {
    const sourceId = String(row.source_id);
    const sourceStatus = String(row.status);
    const unitCount = counts.get(sourceId) ?? 0;
    // Historical or superseded Source registrations that contribute no unit to
    // the exact verified projection are outside this rollout's Source frontier.
    if (unitCount === 0) continue;
    const passed = !["error", "revoked"].includes(sourceStatus) && unitCount > 0;
    const bindingId = `binding:${sha256({ sourceId, connectorId: row.connector_id, connectorVersion: row.connector_version, binding: row.binding })}`;
    const receipt = createKnowledgeOperationalGateReceipt({
      gateId: "source-qualification",
      passed,
      metrics: { sourceStatus, unitCount, lastSuccessfulSyncRecorded: Boolean(row.last_successful_sync) },
      evidenceIds: [sourceId, bindingId],
      recordedAt: input.recordedAt,
    });
    await input.evidenceStore.recordQualification(receipt);
    receiptIds.push(receipt.receiptId);
    sourceBindingIds.push(bindingId);
    statuses.push({
      sourceId,
      bindingId,
      bindingState: sourceStatus === "revoked" ? "revoked" : sourceStatus === "error" ? "error" : passed ? "qualified" : "inactive",
      health: sourceStatus === "healthy" ? "healthy" : sourceStatus === "stale" ? "stale" : sourceStatus === "error" || sourceStatus === "revoked" ? "error" : "unknown",
      qualificationReceiptId: receipt.receiptId,
      ...(row.last_successful_sync ? { lastSuccessfulSyncAt: postgresTimestampToIso(row.last_successful_sync) } : {}),
    });
  }
  return { sourceBindingIds: [...new Set(sourceBindingIds)].sort(), statuses, receiptIds: receiptIds.sort() };
};

const currentBriefStatus = async (): Promise<{ total: number; potentiallyStale: number; oldestSynthesisAt?: string }> => {
  const rows = await connection()`select count(*)::integer as total,
      count(*) filter (where exists (
        select 1 from companyos_knowledge.claims claim
        join companyos_knowledge.claim_evidence evidence on evidence.claim_id = claim.claim_id
        join companyos_knowledge.pages page on page.page_id = evidence.page_id
          and page.current_version_id = evidence.page_version_id
        where syntheses.subject_type = 'page' and evidence.page_id = syntheses.subject_id
          and claim.access_policy_id = versions.access_policy_id
          and claim.observed_at > versions.synthesized_at
      ))::integer as potentially_stale,
      min(versions.synthesized_at) as oldest_synthesis_at
    from companyos_knowledge.syntheses syntheses
    join companyos_knowledge.synthesis_versions versions on versions.synthesis_version_id = syntheses.current_version_id
    where syntheses.lifecycle_status = 'active'`;
  const row = rows[0] as Row | undefined;
  return {
    total: Number(row?.total ?? 0),
    potentiallyStale: Number(row?.potentially_stale ?? 0),
    ...(row?.oldest_synthesis_at ? { oldestSynthesisAt: postgresTimestampToIso(row.oldest_synthesis_at) } : {}),
  };
};

const strategyCurrentBriefStatus = async (): Promise<{
  matchingPages: number;
  withCurrentBrief: number;
  current: number;
  potentiallyStale: number;
  latestSynthesizedAt?: string;
}> => {
  const rows = await connection()`select count(distinct page.page_id)::integer as matching_pages,
      count(distinct synthesis.synthesis_id)::integer as with_current_brief,
      count(distinct synthesis.synthesis_id) filter (where synthesis.synthesis_id is not null and not exists (
        select 1 from companyos_knowledge.claims claim
        join companyos_knowledge.claim_evidence evidence on evidence.claim_id = claim.claim_id
        where evidence.page_id = page.page_id and evidence.page_version_id = page.current_version_id
          and claim.access_policy_id = version.access_policy_id
          and claim.observed_at > version.synthesized_at
      ))::integer as current,
      count(distinct synthesis.synthesis_id) filter (where synthesis.synthesis_id is not null and exists (
        select 1 from companyos_knowledge.claims claim
        join companyos_knowledge.claim_evidence evidence on evidence.claim_id = claim.claim_id
        where evidence.page_id = page.page_id and evidence.page_version_id = page.current_version_id
          and claim.access_policy_id = version.access_policy_id
          and claim.observed_at > version.synthesized_at
      ))::integer as potentially_stale,
      max(version.synthesized_at) as latest_synthesized_at
    from companyos_knowledge.pages page
    join companyos_knowledge.page_versions page_version on page_version.page_version_id = page.current_version_id
    left join companyos_knowledge.syntheses synthesis on synthesis.subject_type = 'page'
      and synthesis.subject_id = page.page_id and synthesis.lifecycle_status = 'active'
    left join companyos_knowledge.synthesis_versions version on version.synthesis_version_id = synthesis.current_version_id
    where page.lifecycle_status = 'active'
      and lower(page_version.title || ' ' || coalesce(page_version.summary, '') || ' ' || page_version.body) like '%strateg%'`;
  const row = rows[0] as Row | undefined;
  return {
    matchingPages: Number(row?.matching_pages ?? 0),
    withCurrentBrief: Number(row?.with_current_brief ?? 0),
    current: Number(row?.current ?? 0),
    potentiallyStale: Number(row?.potentially_stale ?? 0),
    ...(row?.latest_synthesized_at ? { latestSynthesizedAt: postgresTimestampToIso(row.latest_synthesized_at) } : {}),
  };
};

export interface PostgresKnowledgeProductionCanaryQualificationInput {
  projectionHash: string;
  environmentId: string;
  companyInstanceId: string;
  allowedAgentId: string;
  stateProjectId: string;
  stateBranchId: string;
  runtimeProjectId: string;
  stateBranchRehearsalReceiptId: string;
  databaseBackupReceiptId: string;
  operatorApprovalReceiptId: string;
  maximumTrafficPercent?: number;
  modelBudgetMaximumUsd?: number;
  qualifiedAt?: string;
}

export interface PostgresKnowledgeProductionCanaryQualificationResult {
  ok: boolean;
  projectionHash: string;
  sampleSize: number;
  benchmark: { baselineReportId: string; candidateReportId: string; candidateStatus: KnowledgeBenchReport["status"]; candidateMetrics: KnowledgeBenchReport["metrics"] };
  shadow: { comparisonId: string; status: "promotable" | "blocked"; observations: number; blockers: string[] };
  gates: { authorizationReceiptId: string; citationReceiptId: string; fallbackReceiptId: string; databaseReceiptId: string };
  rolloutQualificationReceiptId: string;
  doctor: { reportId: string; status: "ready-for-explicit-activation" | "degraded" | "blocked"; score: number; failedChecks: string[]; warningChecks: string[] };
  activationQualificationReceiptId?: string;
}

export async function qualifyPostgresKnowledgeProductionCanary(input: PostgresKnowledgeProductionCanaryQualificationInput): Promise<PostgresKnowledgeProductionCanaryQualificationResult> {
  const qualifiedAt = new Date(input.qualifiedAt ?? new Date().toISOString()).toISOString();
  const evidenceStore = new PostgresKnowledgeProductizationStore();
  const projectionStore = new PostgresKnowledgeRetrievalV3Store({ readProjectionHash: input.projectionHash, allowVerifiedReadProjection: true });
  const projection = await projectionStore.projection(input.projectionHash);
  if (!projection || !["verified", "active"].includes(projection.status)) throw new Error("Production Knowledge qualification requires the exact verified Retrieval V3 projection.");
  const units = await projectionStore.qualificationUnits(input.projectionHash);
  if (units.length !== projection.unitCount) throw new Error("Production Knowledge qualification projection count does not match its verified metadata.");

  const subject = activeCompanySubject(input.allowedAgentId);
  const policies = await projectionStore.policies();
  const authorizer = new KnowledgeAuthorizer(policies);
  const authorizedPolicyIds = new Set<string>();
  for (const policy of policies) {
    if (await authorizer.authorize({ subject, permission: "read", policyIds: [policy.policyId], objectType: "policy", objectId: policy.policyId })) authorizedPolicyIds.add(policy.policyId);
  }
  const samples = selectQualificationUnits(units, authorizedPolicyIds);
  if (samples.length < 8) throw new Error("Production Knowledge qualification requires at least eight diverse authorized Retrieval Units.");

  const handbook = createPostgresKnowledgeProvider();
  const brainStore = new PostgresBrainKnowledgeProjectionStore();
  const brainProjection = await brainStore.load();
  const baseline = createUnifiedKnowledgeProvider({ handbook, brain: brainStore, accessAuditor: new PostgresKnowledgeAccessAuditor() });
  const candidate = createPostgresKnowledgeProviderV3({ baseline, projectionHash: input.projectionHash, allowVerifiedProjection: true });
  const authorities = authorityByUnit(units);
  const unitsById = new Map(units.map((unit) => [unit.unitId, unit]));
  const timelineQueries = new Set(samples.filter((sample) => sample.relevance === "same-timeline").map((sample) => sample.query));
  const normalizeBenchmarkIdentity = (unitId: string, query: string): string =>
    timelineQueries.has(query) ? (unitsById.get(unitId)?.parentId ?? unitId) : unitId;
  const brainCitationUnits = new Map(Object.entries(brainProjection.citations).map(([unitId, citation]) => [`${citation.path}\0${citation.fragmentId}`, unitId]));
  const baselineUnit = (hit: KnowledgeSearchHit, query: string): string | undefined => {
    const unitId = brainCitationUnits.get(`${hit.citation.path}\0${hit.citation.fragmentId}`)
      ?? (hit.citation.path ? `handbook:${hit.citation.path}#${hit.citation.fragmentId}` : undefined);
    return unitId ? normalizeBenchmarkIdentity(unitId, query) : undefined;
  };
  const candidateUnit = (hit: KnowledgeSearchHit, query: string): string | undefined =>
    authorities.has(hit.citation.path) ? normalizeBenchmarkIdentity(hit.citation.path, query) : undefined;
  const suiteId = `production-canary:${input.projectionHash}`;
  const cases = samples.map((sample, index) => {
    const expectedIdentity = relevanceIdentity(sample);
    return {
      caseId: `production-sample-${String(index + 1).padStart(2, "0")}`,
      query: sample.query,
      subject,
      expectedUnitIds: [expectedIdentity],
      ...(sample.relevance === "exact-unit" ? { expectedAuthority: { [expectedIdentity]: sample.unit.authorityLayer } } : {}),
      limit: 10,
      mode: "hybrid" as const,
    };
  });
  const gates = {
    minimumMeanRecallAtK: 0.75,
    minimumMeanReciprocalRank: 0.5,
    // Authority accuracy is evaluated over the same expected identities as
    // recall. Keep its initial canary threshold aligned with bounded recall so
    // a missing hit is not effectively gated twice at different thresholds.
    minimumAuthorityAccuracy: 0.8,
    minimumCitationMembership: 1,
    maximumAuthorizationLeakage: 0,
    maximumDegradationRate: 0,
  };
  const baselineReport = await runKnowledgeBench({
    suiteId,
    implementationId: "retrieval-v2-production",
    cases,
    gates: { ...gates, maximumDegradationRate: 1 },
    search: benchmarkSearch({ provider: baseline, authorities, resolveUnitId: baselineUnit }),
    recordedAt: qualifiedAt,
  });
  const candidateReport = await runKnowledgeBench({
    suiteId,
    implementationId: `retrieval-v3:${input.projectionHash}`,
    cases,
    gates,
    search: benchmarkSearch({ provider: candidate, authorities, resolveUnitId: candidateUnit }),
    recordedAt: qualifiedAt,
  });
  await evidenceStore.recordBenchmark(baselineReport);
  await evidenceStore.recordBenchmark(candidateReport);
  const comparison = compareKnowledgeBench({ baseline: baselineReport, candidate: candidateReport, comparedAt: qualifiedAt });
  await evidenceStore.recordShadowComparison(comparison);

  const shadowReceipts: string[] = [];
  const shadowSelection: KnowledgeRetrievalRuntimeSelection = {
    requestedMode: "v3-shadow",
    effectiveMode: "v3-shadow",
    selectedAgentId: input.allowedAgentId,
    allowedAgentIds: [input.allowedAgentId],
    projectionHash: input.projectionHash,
  };
  const shadow = createPostgresKnowledgeCanaryProvider({
    baseline,
    candidate,
    selection: shadowSelection,
    now: () => qualifiedAt,
    evidenceStore: {
      recordQualification: async (receipt) => {
        shadowReceipts.push("receiptId" in receipt ? receipt.receiptId : receipt.reportId);
        return evidenceStore.recordQualification(receipt);
      },
    },
  });
  for (const testCase of cases) await shadow.search(testCase);

  const service = new KnowledgeRetrievalServiceV3({
    store: projectionStore,
    auditor: new PostgresKnowledgeAccessAuditor(),
    resolveSubject: enrichPostgresKnowledgeSubject,
    embeddingAdapter: new LocalHashEmbeddingAdapter(),
    embeddingPolicy: { mode: "local", allowExternalDataEgress: false },
  });
  const inaccessibleUnits = units.filter((unit) => !authorizedPolicyIds.has(unit.accessPolicyId));
  let leakageCount = 0;
  let negativeChecks = 0;
  for (const sample of samples.slice(0, 3)) {
    for (const mode of ["lexical", "hybrid"] as const) {
      const result = await service.search({ query: sample.query, subject: unresolvedSubject, limit: 10, mode });
      leakageCount += result.hits.length;
      negativeChecks += 1;
    }
    if (await service.get({ unitId: sample.unit.unitId, subject: unresolvedSubject })) leakageCount += 1;
    negativeChecks += 1;
  }
  const protectedSample = inaccessibleUnits[0];
  if (protectedSample) {
    const protectedQuery = queryForUnit(protectedSample, new Map(), new Map());
    const protectedResult = await service.search({ query: protectedQuery, subject, limit: 20, mode: "hybrid" });
    leakageCount += protectedResult.hits.filter((hit) => hit.unitId === protectedSample.unitId).length;
    if (await service.get({ unitId: protectedSample.unitId, subject })) leakageCount += 1;
    negativeChecks += 2;
  }
  const candidateGraph = await candidate.traverse({ path: samples[0]!.unit.unitId, subject: unresolvedSubject, maxDepth: 2, maxNodes: 20 });
  leakageCount += candidateGraph.paths.length;
  negativeChecks += 1;
  const briefRows = await connection()`select subject_type, subject_id from companyos_knowledge.syntheses where lifecycle_status = 'active' order by synthesis_id limit 1`;
  if (briefRows[0]) {
    const brief = await new CurrentBriefService({ store: projectionStore, auditor: new PostgresKnowledgeAccessAuditor(), resolveSubject: enrichPostgresKnowledgeSubject }).get({
      subjectType: String(briefRows[0].subject_type),
      subjectId: String(briefRows[0].subject_id),
      subject: unresolvedSubject,
      now: qualifiedAt,
    });
    if (brief) leakageCount += 1;
    negativeChecks += 1;
  }
  const emptyContext = await service.contextPack({ query: samples[0]!.query, subject: unresolvedSubject, authorizationContextDigest: sha256(unresolvedSubject), createdAt: qualifiedAt });
  if (!emptyContext || emptyContext.hits.length > 0 || createExtractiveKnowledgeAnswerV3({ context: emptyContext }).status !== "unavailable") leakageCount += 1;
  negativeChecks += 1;
  const authorizationReceipt = createKnowledgeOperationalGateReceipt({
    gateId: "authorization-negative-tests",
    passed: leakageCount === 0,
    metrics: { leakageCount, negativeChecks, protectedUnitAvailable: Boolean(protectedSample), currentBriefNegativePathChecked: Boolean(briefRows[0]) },
    evidenceIds: [input.projectionHash],
    recordedAt: qualifiedAt,
  });
  await evidenceStore.recordQualification(authorizationReceipt);

  let invalidCitationCount = 0;
  let citationContexts = 0;
  let forgeryRejected = false;
  for (const sample of samples.slice(0, 6)) {
    const context = await service.contextPack({ query: sample.query, subject, authorizationContextDigest: sha256(subject), maximumUnits: 8, createdAt: qualifiedAt });
    if (!context || context.hits.length === 0) { invalidCitationCount += 1; continue; }
    citationContexts += 1;
    try { validateKnowledgeAnswerEnvelopeV3({ context, envelope: createExtractiveKnowledgeAnswerV3({ context }) }); }
    catch { invalidCitationCount += 1; }
    if (!forgeryRejected) {
      const valid = createExtractiveKnowledgeAnswerV3({ context });
      try {
        validateKnowledgeAnswerEnvelopeV3({ context, envelope: { ...valid, citations: [{ unitId: context.hits[0]!.unitId, contentDigest: sha256("forged") }] } });
      } catch { forgeryRejected = true; }
    }
  }
  if (!forgeryRejected) invalidCitationCount += 1;
  const citationReceipt = createKnowledgeOperationalGateReceipt({
    gateId: "citation-regression",
    passed: invalidCitationCount === 0 && citationContexts > 0 && forgeryRejected,
    metrics: { invalidCitationCount, citationContexts, forgeryRejected },
    evidenceIds: [candidateReport.reportId, input.projectionHash],
    recordedAt: qualifiedAt,
  });
  await evidenceStore.recordQualification(citationReceipt);

  const fallbackCandidate: KnowledgeProvider = {
    ...candidate,
    search: async () => { throw new Error("qualification-induced-v3-failure"); },
  };
  const fallbackProvider = createPostgresKnowledgeCanaryProvider({
    baseline,
    candidate: fallbackCandidate,
    selection: { ...shadowSelection, requestedMode: "v3-canary", effectiveMode: "v3-canary" },
  });
  const fallbackResult = await fallbackProvider.search(cases[0]!);
  const fallbackPassed = fallbackResult.degradations.includes("retrieval-v3-canary-fallback") && fallbackResult.snapshotHash !== null;
  const fallbackReceipt = createKnowledgeOperationalGateReceipt({
    gateId: "v2-fallback",
    passed: fallbackPassed,
    metrics: { fallbackPassed, returnedCount: fallbackResult.hits.length },
    evidenceIds: [baselineReport.reportId, input.projectionHash],
    recordedAt: qualifiedAt,
  });
  await evidenceStore.recordQualification(fallbackReceipt);

  const database = await qualifyCompanyDatabase();
  const databaseReceipt = createKnowledgeOperationalGateReceipt({
    gateId: "database-qualification",
    passed: database.status === "qualified" && database.manifestVersion === "1.9.0",
    metrics: { qualified: database.status === "qualified", manifestVersion: database.manifestVersion, vector: database.features.vector },
    evidenceIds: [database.manifestDigest],
    recordedAt: qualifiedAt,
  });
  await evidenceStore.recordQualification(databaseReceipt);

  const sources = await sourceQualification({ units, recordedAt: qualifiedAt, evidenceStore });
  if (sources.sourceBindingIds.length === 0) throw new Error("Production Knowledge qualification requires at least one persisted Source binding.");
  const currentBriefs = await currentBriefStatus();
  const rolloutReceipt = qualifyProductionKnowledgeCanary({
    production: {
      environmentId: input.environmentId,
      environmentClass: "production",
      state: { provider: "neon", projectId: input.stateProjectId, branchId: input.stateBranchId },
      runtime: { provider: "vercel", projectId: input.runtimeProjectId, deploymentScope: "production" },
      secretNamespaceId: `vercel:${input.runtimeProjectId}:production`,
      communicationBindingId: `slack:${input.companyInstanceId}:production`,
      sourceBindingIds: sources.sourceBindingIds,
      modelBudget: { period: "utc-day", maximumUsd: input.modelBudgetMaximumUsd ?? 25 },
    },
    canaryScope: {
      companyInstanceId: input.companyInstanceId,
      allowedAgentIds: [input.allowedAgentId],
      maximumTrafficPercent: input.maximumTrafficPercent ?? 100,
      servesExternalTraffic: false,
    },
    evidence: {
      stateBranchRehearsalReceiptId: input.stateBranchRehearsalReceiptId,
      databaseBackupReceiptId: input.databaseBackupReceiptId,
      v2FallbackReceiptId: fallbackReceipt.receiptId,
      shadowModeReceiptId: comparison.comparisonId,
      operatorRiskAcceptanceReceiptId: input.operatorApprovalReceiptId,
    },
    qualifiedAt,
  });
  await evidenceStore.recordQualification(rolloutReceipt);

  const doctor = runKnowledgeDoctor({
    environment: rolloutReceipt,
    rolloutPhase: "pre-activation",
    database: { qualified: databaseReceipt.status === "passed", manifestVersion: database.manifestVersion, receiptId: databaseReceipt.receiptId },
    projection,
    benchmark: candidateReport,
    shadow: comparison,
    authorizationNegativeTests: { passed: authorizationReceipt.status === "passed", leakageCount, receiptId: authorizationReceipt.receiptId },
    citationRegression: { passed: citationReceipt.status === "passed", invalidCount: invalidCitationCount, receiptId: citationReceipt.receiptId },
    sources: sources.statuses,
    currentBriefs,
    backupRestoreReceiptId: input.databaseBackupReceiptId,
    rollbackReceiptId: fallbackReceipt.receiptId,
    generatedAt: qualifiedAt,
    minimumEmbeddingCoverage: 1,
  });
  await evidenceStore.recordQualification(doctor);

  const failedChecks = doctor.checks.filter((check) => check.status === "fail").map((check) => check.checkId);
  const warningChecks = doctor.checks.filter((check) => check.status === "warn").map((check) => check.checkId);
  const gatePassed = candidateReport.status === "passed"
    && comparison.status === "promotable"
    && authorizationReceipt.status === "passed"
    && citationReceipt.status === "passed"
    && fallbackReceipt.status === "passed"
    && databaseReceipt.status === "passed"
    && sources.statuses.every((source) => !["error", "revoked", "inactive"].includes(source.bindingState))
    && doctor.status !== "blocked";
  let activationReceiptId: string | undefined;
  if (gatePassed) {
    const activation = qualifyKnowledgeProductizationActivation({
      rolloutReceipt,
      evidence: {
        rolloutQualificationReceiptId: rolloutReceipt.receiptId,
        databaseQualificationReceiptId: databaseReceipt.receiptId,
        retrievalProjectionReceiptId: input.projectionHash,
        knowledgeBenchReceiptId: candidateReport.reportId,
        authorizationNegativeTestReceiptId: authorizationReceipt.receiptId,
        citationRegressionReceiptId: citationReceipt.receiptId,
        sourceQualificationReceiptIds: sources.receiptIds,
        backupRestoreReceiptId: input.databaseBackupReceiptId,
        rollbackReceiptId: fallbackReceipt.receiptId,
        shadowComparisonReceiptId: comparison.comparisonId,
        operatorApprovalReceiptId: input.operatorApprovalReceiptId,
      },
      qualifiedAt,
    });
    await evidenceStore.recordQualification(activation);
    activationReceiptId = activation.receiptId;
  }
  return {
    ok: gatePassed,
    projectionHash: input.projectionHash,
    sampleSize: samples.length,
    benchmark: {
      baselineReportId: baselineReport.reportId,
      candidateReportId: candidateReport.reportId,
      candidateStatus: candidateReport.status,
      candidateMetrics: candidateReport.metrics,
    },
    shadow: { comparisonId: comparison.comparisonId, status: comparison.status, observations: shadowReceipts.length, blockers: comparison.blockers },
    gates: {
      authorizationReceiptId: authorizationReceipt.receiptId,
      citationReceiptId: citationReceipt.receiptId,
      fallbackReceiptId: fallbackReceipt.receiptId,
      databaseReceiptId: databaseReceipt.receiptId,
    },
    rolloutQualificationReceiptId: rolloutReceipt.receiptId,
    doctor: { reportId: doctor.reportId, status: doctor.status, score: doctor.score, failedChecks, warningChecks },
    ...(activationReceiptId ? { activationQualificationReceiptId: activationReceiptId } : {}),
  };
}

export async function verifyPostgresKnowledgeCanaryLive(input: { projectionHash: string; agentId: string; verifiedAt?: string }): Promise<{
  ok: boolean;
  effectiveMode: string;
  projectionHash: string | null;
  authorizedResultCount: number;
  unauthorizedResultCount: number;
  fallbackObserved: boolean;
  receiptId: string;
}> {
  const verifiedAt = new Date(input.verifiedAt ?? new Date().toISOString()).toISOString();
  const selection = resolveKnowledgeRetrievalRuntimeSelection({ environment: process.env, selectedAgentId: input.agentId });
  const store = new PostgresKnowledgeRetrievalV3Store();
  const projection = await store.activeProjection();
  if (!projection || projection.projectionHash !== input.projectionHash) throw new Error("Live Knowledge verification requires the exact active Retrieval V3 projection.");
  const units = await store.qualificationUnits(input.projectionHash);
  const subject = activeCompanySubject(input.agentId);
  const authorizer = new KnowledgeAuthorizer(await store.policies());
  const authorizedPolicyIds = new Set<string>();
  for (const policy of await store.policies()) {
    if (await authorizer.authorize({ subject, permission: "read", policyIds: [policy.policyId], objectType: "policy", objectId: policy.policyId })) authorizedPolicyIds.add(policy.policyId);
  }
  const sample = selectQualificationUnits(units, authorizedPolicyIds, 1)[0];
  if (!sample) throw new Error("Live Knowledge verification could not select an authorized production sample.");
  const baseline = createUnifiedKnowledgeProvider({
    handbook: createPostgresKnowledgeProvider(),
    brain: new PostgresBrainKnowledgeProjectionStore(),
    accessAuditor: new PostgresKnowledgeAccessAuditor(),
  });
  const provider = createPostgresKnowledgeCanaryProvider({ baseline, selection });
  const authorized = await provider.search({ query: sample.query, subject, limit: 10, mode: "hybrid" });
  const unauthorized = await provider.search({ query: sample.query, subject: unresolvedSubject, limit: 10, mode: "hybrid" });
  const health = await provider.health();
  const fallbackObserved = authorized.degradations.includes("retrieval-v3-canary-fallback");
  const passed = selection.effectiveMode === "v3-canary"
    && selection.projectionHash === input.projectionHash
    && authorized.snapshotHash === input.projectionHash
    && authorized.hits.length > 0
    && unauthorized.hits.length === 0
    && !fallbackObserved
    && health.ok
    && health.activeSnapshotHash === input.projectionHash;
  const receipt = createKnowledgeOperationalGateReceipt({
    gateId: "runtime-live-verification",
    passed,
    metrics: {
      effectiveMode: selection.effectiveMode,
      authorizedResultCount: authorized.hits.length,
      unauthorizedResultCount: unauthorized.hits.length,
      fallbackObserved,
      providerHealthy: health.ok,
    },
    evidenceIds: [input.projectionHash, input.agentId],
    recordedAt: verifiedAt,
  });
  await new PostgresKnowledgeProductizationStore().recordQualification(receipt);
  return {
    ok: passed,
    effectiveMode: selection.effectiveMode,
    projectionHash: health.activeSnapshotHash,
    authorizedResultCount: authorized.hits.length,
    unauthorizedResultCount: unauthorized.hits.length,
    fallbackObserved,
    receiptId: receipt.receiptId,
  };
}

export async function diagnosePostgresKnowledgeProductionFollowup(input: { projectionHash: string; agentId: string; diagnosedAt?: string }): Promise<{
  ok: true;
  projectionHash: string;
  sources: Array<{
    sourceId: string;
    status: string;
    projectedUnitCount: number;
    lastSuccessfulSyncAt?: string;
    syncAgeHours?: number;
    latestSucceededReceiptAt?: string;
  }>;
  currentBriefs: {
    total: number;
    potentiallyStale: number;
    strategy: Awaited<ReturnType<typeof strategyCurrentBriefStatus>>;
  };
  previousQualification?: {
    productionEnvironmentId: string;
    companyInstanceId: string;
    rolloutQualificationReceiptId: string;
    stateBranchRehearsalReceiptId: string;
    backupRestoreReceiptId: string;
    operatorApprovalReceiptId: string;
  };
  benchmark: {
    sampleSize: number;
    relevanceHitCount: number;
    relevanceRecallAtK: number;
    exactUnitHitCount: number;
    exactUnitRecallAtK: number;
    exactUnitMisses: Array<{
      caseId: string;
      unitIdentityDigest: string;
      kind: KnowledgeRetrievalUnitV3["kind"];
      authorityLayer: KnowledgeAuthorityLayer;
      relevance: QualificationSample["relevance"];
      relevantParentHit: boolean;
      lexicalCandidate: boolean;
      exactCandidate: boolean;
      semanticCandidate: boolean;
      prePoolRank: number | null;
      higherSameParent: number;
      higherSameSource: number;
      cause: "candidate-generation" | "ranking-or-pooling";
    }>;
  };
}> {
  const diagnosedAt = new Date(input.diagnosedAt ?? new Date().toISOString()).toISOString();
  const store = new PostgresKnowledgeRetrievalV3Store({ readProjectionHash: input.projectionHash, allowVerifiedReadProjection: true });
  const projection = await store.projection(input.projectionHash);
  if (!projection || !["verified", "active"].includes(projection.status)) throw new Error("Knowledge follow-up diagnosis requires the exact verified or active projection.");
  const units = await store.qualificationUnits(input.projectionHash);
  const subject = activeCompanySubject(input.agentId);
  const policies = await store.policies();
  const authorizer = new KnowledgeAuthorizer(policies);
  const authorizedPolicyIds: string[] = [];
  for (const policy of policies) {
    if (await authorizer.authorize({ subject, permission: "read", policyIds: [policy.policyId], objectType: "policy", objectId: policy.policyId })) authorizedPolicyIds.push(policy.policyId);
  }
  const authorizedSet = new Set(authorizedPolicyIds);
  const samples = selectQualificationUnits(units, authorizedSet);
  const embedding = new LocalHashEmbeddingAdapter();
  const service = new KnowledgeRetrievalServiceV3({
    store,
    embeddingAdapter: embedding,
    embeddingPolicy: { mode: "local", allowExternalDataEgress: false },
  });
  const exactUnitMisses: Array<{
    caseId: string;
    unitIdentityDigest: string;
    kind: KnowledgeRetrievalUnitV3["kind"];
    authorityLayer: KnowledgeAuthorityLayer;
    relevance: QualificationSample["relevance"];
    relevantParentHit: boolean;
    lexicalCandidate: boolean;
    exactCandidate: boolean;
    semanticCandidate: boolean;
    prePoolRank: number | null;
    higherSameParent: number;
    higherSameSource: number;
    cause: "candidate-generation" | "ranking-or-pooling";
  }> = [];
  let exactUnitHitCount = 0;
  let relevanceHitCount = 0;
  for (const [index, sample] of samples.entries()) {
    const result = await service.search({ query: sample.query, subject, limit: 10, mode: "hybrid" });
    const exactUnitHit = result.hits.some((hit) => hit.unitId === sample.unit.unitId);
    const relevantParentHit = sample.relevance === "same-timeline"
      && result.hits.some((hit) => units.find((unit) => unit.unitId === hit.unitId)?.parentId === sample.unit.parentId);
    if (exactUnitHit) exactUnitHitCount += 1;
    if (exactUnitHit || relevantParentHit) relevanceHitCount += 1;
    if (exactUnitHit) continue;
    const [lexical, vector] = await Promise.all([
      store.lexicalCandidates({ projectionHash: input.projectionHash, query: sample.query, authorizedPolicyIds, limit: 400 }),
      embedding.embed([sample.query]).then(([value]) => store.semanticCandidates({
        projectionHash: input.projectionHash,
        vector: value!,
        adapterId: embedding.id,
        adapterVersion: embedding.version,
        dimensions: embedding.dimensions,
        authorizedPolicyIds,
        limit: 400,
      })),
    ]);
    const lexicalEntry = lexical.find((entry) => entry.unit.unitId === sample.unit.unitId);
    const semanticCandidate = vector.some((entry) => entry.unit.unitId === sample.unit.unitId);
    const fused = new Map<string, { unit: KnowledgeRetrievalUnitV3; score: number }>();
    const addRank = (unit: KnowledgeRetrievalUnitV3, rank: number) => {
      const current = fused.get(unit.unitId) ?? { unit, score: 0 };
      current.score += 1 / (60 + rank);
      fused.set(unit.unitId, current);
    };
    lexical.forEach((entry, candidateIndex) => {
      if (entry.exactRank) addRank(entry.unit, entry.exactRank);
      if (entry.lexicalRank) addRank(entry.unit, entry.lexicalRank ?? candidateIndex + 1);
    });
    vector.forEach((entry, candidateIndex) => addRank(entry.unit, entry.semanticRank ?? candidateIndex + 1));
    const ranked = [...fused.values()].map((entry) => ({
      ...entry,
      score: entry.score + (entry.unit.signals.confidence * 0.03 + entry.unit.signals.authority * 0.04 + entry.unit.signals.freshness * 0.02 + entry.unit.signals.expectedValue * 0.02),
    })).sort((left, right) => right.score - left.score || left.unit.unitId.localeCompare(right.unit.unitId));
    const prePoolIndex = ranked.findIndex((entry) => entry.unit.unitId === sample.unit.unitId);
    const higher = prePoolIndex < 0 ? [] : ranked.slice(0, prePoolIndex);
    const sourceId = sample.unit.sourceIds[0] ?? "unknown";
    exactUnitMisses.push({
      caseId: `production-sample-${String(index + 1).padStart(2, "0")}`,
      unitIdentityDigest: sha256({ unitId: sample.unit.unitId }),
      kind: sample.unit.kind,
      authorityLayer: sample.unit.authorityLayer,
      relevance: sample.relevance,
      relevantParentHit,
      lexicalCandidate: Boolean(lexicalEntry?.lexicalRank),
      exactCandidate: Boolean(lexicalEntry?.exactRank),
      semanticCandidate,
      prePoolRank: prePoolIndex < 0 ? null : prePoolIndex + 1,
      higherSameParent: higher.filter((entry) => entry.unit.parentId === sample.unit.parentId).length,
      higherSameSource: higher.filter((entry) => (entry.unit.sourceIds[0] ?? "unknown") === sourceId).length,
      cause: lexicalEntry || semanticCandidate ? "ranking-or-pooling" : "candidate-generation",
    });
  }
  const sourceRows = await connection()`select sources.source_id, sources.status, sources.last_successful_sync,
      latest.observed_at as latest_succeeded_receipt_at
    from companyos_knowledge.sources sources
    left join lateral (
      select observed_at from companyos_knowledge.source_pipeline_receipts receipts
      where receipts.source_id = sources.source_id and receipts.outcome = 'succeeded'
      order by observed_at desc, receipt_id desc limit 1
    ) latest on true
    order by sources.source_id`;
  const projectedCounts = new Map<string, number>();
  for (const unit of units) for (const sourceId of unit.sourceIds) projectedCounts.set(sourceId, (projectedCounts.get(sourceId) ?? 0) + 1);
  const sources = (sourceRows as Row[]).filter((row) => (projectedCounts.get(String(row.source_id)) ?? 0) > 0).map((row) => {
    const lastSuccessfulSyncAt = row.last_successful_sync ? postgresTimestampToIso(row.last_successful_sync) : undefined;
    return {
      sourceId: String(row.source_id),
      status: String(row.status),
      projectedUnitCount: projectedCounts.get(String(row.source_id)) ?? 0,
      ...(lastSuccessfulSyncAt ? {
        lastSuccessfulSyncAt,
        syncAgeHours: Number(((Date.parse(diagnosedAt) - Date.parse(lastSuccessfulSyncAt)) / 3_600_000).toFixed(2)),
      } : {}),
      ...(row.latest_succeeded_receipt_at ? { latestSucceededReceiptAt: postgresTimestampToIso(row.latest_succeeded_receipt_at) } : {}),
    };
  });
  const [briefs, strategy, qualificationRows] = await Promise.all([
    currentBriefStatus(),
    strategyCurrentBriefStatus(),
    connection()`select activation.receipt as activation_receipt, rollout.receipt as rollout_receipt
      from companyos_knowledge.knowledge_productization_receipts activation
      join companyos_knowledge.knowledge_productization_receipts rollout
        on rollout.receipt_id = activation.receipt->'evidence'->>'rolloutQualificationReceiptId'
      where activation.receipt_kind = 'activation-qualification'
        and activation.status = 'qualified-for-explicit-activation'
        and activation.receipt->'evidence'->>'retrievalProjectionReceiptId' = ${input.projectionHash}
      order by activation.recorded_at desc, activation.receipt_id desc limit 1`,
  ]);
  const previousActivation = qualificationRows[0]?.activation_receipt as Record<string, unknown> | undefined;
  const previousRollout = qualificationRows[0]?.rollout_receipt as Record<string, unknown> | undefined;
  const previousActivationEvidence = previousActivation?.evidence as Record<string, unknown> | undefined;
  const previousRolloutEvidence = previousRollout?.evidence as Record<string, unknown> | undefined;
  const previousCanaryScope = previousRollout?.canaryScope as Record<string, unknown> | undefined;
  const previousQualification = previousActivationEvidence && previousRolloutEvidence ? {
    productionEnvironmentId: String(previousRollout?.productionEnvironmentId),
    companyInstanceId: String(previousCanaryScope?.companyInstanceId),
    rolloutQualificationReceiptId: String(previousActivationEvidence.rolloutQualificationReceiptId),
    stateBranchRehearsalReceiptId: String(previousRolloutEvidence.stateBranchRehearsalReceiptId),
    backupRestoreReceiptId: String(previousActivationEvidence.backupRestoreReceiptId),
    operatorApprovalReceiptId: String(previousActivationEvidence.operatorApprovalReceiptId),
  } : undefined;
  return {
    ok: true,
    projectionHash: input.projectionHash,
    sources,
    currentBriefs: { total: briefs.total, potentiallyStale: briefs.potentiallyStale, strategy },
    ...(previousQualification ? { previousQualification } : {}),
    benchmark: {
      sampleSize: samples.length,
      relevanceHitCount,
      relevanceRecallAtK: samples.length === 0 ? 0 : Number((relevanceHitCount / samples.length).toFixed(8)),
      exactUnitHitCount,
      exactUnitRecallAtK: samples.length === 0 ? 0 : Number((exactUnitHitCount / samples.length).toFixed(8)),
      exactUnitMisses,
    },
  };
}
