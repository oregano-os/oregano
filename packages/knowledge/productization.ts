import { canonicalJson, sha256 } from "../runtime/canonical.ts";

export const KNOWLEDGE_PRODUCTIZATION_QUALIFICATION_VERSION = "1.1.0" as const;

export interface KnowledgeEnvironmentIdentity {
  environmentId: string;
  environmentClass: "non-production" | "production";
  state: { provider: string; projectId: string; branchId: string };
  runtime: { provider: string; projectId: string; deploymentScope: string };
  secretNamespaceId: string;
  communicationBindingId: string;
  sourceBindingIds: string[];
  modelBudget: { period: "utc-day" | "cycle"; maximumUsd: number };
}

export interface KnowledgeNonProductionQualificationReceipt {
  contractVersion: typeof KNOWLEDGE_PRODUCTIZATION_QUALIFICATION_VERSION;
  receiptId: string;
  status: "qualified";
  candidateEnvironmentId: string;
  productionEnvironmentId: string;
  isolation: {
    stateBranch: true;
    runtimeScope: true;
    secretNamespace: true;
    communicationBinding: true;
    sourceBindings: true;
    boundedModelBudget: true;
  };
  evidenceDigest: string;
  qualifiedAt: string;
}

export interface KnowledgeProductionCanaryQualificationReceipt {
  contractVersion: typeof KNOWLEDGE_PRODUCTIZATION_QUALIFICATION_VERSION;
  receiptId: string;
  status: "qualified-for-production-canary";
  productionEnvironmentId: string;
  canaryScope: {
    companyInstanceId: string;
    allowedAgentIds: string[];
    maximumTrafficPercent: number;
    servesExternalTraffic: false;
  };
  controls: {
    stateBranchRehearsal: true;
    databaseBackup: true;
    v2Fallback: true;
    shadowMode: true;
    operatorRiskAcceptance: true;
  };
  evidence: {
    stateBranchRehearsalReceiptId: string;
    databaseBackupReceiptId: string;
    v2FallbackReceiptId: string;
    shadowModeReceiptId: string;
    operatorRiskAcceptanceReceiptId: string;
  };
  evidenceDigest: string;
  qualifiedAt: string;
}

export type KnowledgeRolloutQualificationReceipt =
  | KnowledgeNonProductionQualificationReceipt
  | KnowledgeProductionCanaryQualificationReceipt;

export interface KnowledgeLiveShadowObservationReceipt {
  contractVersion: typeof KNOWLEDGE_PRODUCTIZATION_QUALIFICATION_VERSION;
  receiptId: string;
  status: "recorded";
  mode: "v2-served-v3-shadowed";
  queryDigest: string;
  authorizationContextDigest: string;
  baselineSnapshotHash: string | null;
  candidateProjectionHash: string | null;
  comparison: {
    baselineResultCount: number;
    candidateResultCount: number;
    sharedContentDigestCount: number;
    topContentDigestMatch: boolean;
    candidateFailed: boolean;
    candidateFailureDigest?: string;
  };
  observedAt: string;
}

export type KnowledgeOperationalGateId =
  | "authorization-negative-tests"
  | "citation-regression"
  | "v2-fallback"
  | "database-qualification"
  | "source-qualification"
  | "runtime-live-verification";

export interface KnowledgeOperationalGateReceipt {
  contractVersion: typeof KNOWLEDGE_PRODUCTIZATION_QUALIFICATION_VERSION;
  receiptId: string;
  status: "passed" | "failed";
  gateId: KnowledgeOperationalGateId;
  metrics: Record<string, number | boolean | string>;
  evidenceIds: string[];
  evidenceDigest: string;
  recordedAt: string;
}

export interface KnowledgeProductizationActivationEvidence {
  rolloutQualificationReceiptId: string;
  databaseQualificationReceiptId: string;
  retrievalProjectionReceiptId: string;
  knowledgeBenchReceiptId: string;
  authorizationNegativeTestReceiptId: string;
  citationRegressionReceiptId: string;
  sourceQualificationReceiptIds: string[];
  backupRestoreReceiptId: string;
  rollbackReceiptId: string;
  shadowComparisonReceiptId: string;
  operatorApprovalReceiptId: string;
}

export interface KnowledgeProductizationActivationReceipt {
  contractVersion: typeof KNOWLEDGE_PRODUCTIZATION_QUALIFICATION_VERSION;
  receiptId: string;
  status: "qualified-for-explicit-activation";
  evidence: KnowledgeProductizationActivationEvidence;
  qualifiedAt: string;
}

const forbidden = /(?:postgres(?:ql)?:\/\/|(?:sk|ghp|whsec)_[A-Za-z0-9_-]{12,}|password|database_url|secret_value|access_token|refresh_token)/i;

const required = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > 1_000 || /[\0-\x08\x0b\x0c\x0e-\x1f]/.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
};

const identities = (values: readonly string[], label: string, allowEmpty = false): string[] => {
  if (!Array.isArray(values) || values.length > 200) throw new Error(`${label} exceeds its bounded size.`);
  const normalized = values.map((value) => required(value, label));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must contain distinct identities.`);
  if (!allowEmpty && normalized.length === 0) throw new Error(`${label} requires at least one identity.`);
  return [...normalized].sort();
};

const normalizeEnvironment = (input: KnowledgeEnvironmentIdentity): KnowledgeEnvironmentIdentity => {
  if (!Number.isFinite(input.modelBudget.maximumUsd) || input.modelBudget.maximumUsd <= 0 || input.modelBudget.maximumUsd > 1_000_000) {
    throw new Error("Knowledge environment model budget must be a positive bounded amount.");
  }
  const value: KnowledgeEnvironmentIdentity = {
    environmentId: required(input.environmentId, "Knowledge environment ID"),
    environmentClass: input.environmentClass,
    state: {
      provider: required(input.state.provider, "Knowledge StateStore provider"),
      projectId: required(input.state.projectId, "Knowledge StateStore project ID"),
      branchId: required(input.state.branchId, "Knowledge StateStore branch ID"),
    },
    runtime: {
      provider: required(input.runtime.provider, "Knowledge runtime provider"),
      projectId: required(input.runtime.projectId, "Knowledge runtime project ID"),
      deploymentScope: required(input.runtime.deploymentScope, "Knowledge runtime deployment scope"),
    },
    secretNamespaceId: required(input.secretNamespaceId, "Knowledge secret namespace ID"),
    communicationBindingId: required(input.communicationBindingId, "Knowledge communication binding ID"),
    sourceBindingIds: identities(input.sourceBindingIds, "Knowledge Source binding"),
    modelBudget: { period: input.modelBudget.period, maximumUsd: Number(input.modelBudget.maximumUsd.toFixed(8)) },
  };
  if (!new Set(["non-production", "production"]).has(value.environmentClass)) throw new Error("Knowledge environment class is invalid.");
  if (!new Set(["utc-day", "cycle"]).has(value.modelBudget.period)) throw new Error("Knowledge model budget period is invalid.");
  if (forbidden.test(canonicalJson(value))) throw new Error("Knowledge environment evidence contains a credential or secret value.");
  return value;
};

export function qualifyNonProductionKnowledgeEnvironment(input: {
  candidate: KnowledgeEnvironmentIdentity;
  production: KnowledgeEnvironmentIdentity;
  qualifiedAt: string;
}): KnowledgeNonProductionQualificationReceipt {
  const candidate = normalizeEnvironment(input.candidate);
  const production = normalizeEnvironment(input.production);
  if (candidate.environmentClass !== "non-production" || production.environmentClass !== "production") {
    throw new Error("Knowledge isolation qualification requires non-production and production environment identities.");
  }
  if (candidate.environmentId === production.environmentId) throw new Error("Knowledge non-production environment identity is not isolated from production.");
  if (candidate.state.projectId === production.state.projectId && candidate.state.branchId === production.state.branchId) {
    throw new Error("Knowledge non-production StateStore must use a distinct branch or project.");
  }
  if (candidate.runtime.projectId === production.runtime.projectId && candidate.runtime.deploymentScope === production.runtime.deploymentScope) {
    throw new Error("Knowledge non-production runtime scope is not isolated from production.");
  }
  if (candidate.secretNamespaceId === production.secretNamespaceId) throw new Error("Knowledge non-production secrets must use a distinct namespace.");
  if (candidate.communicationBindingId === production.communicationBindingId) throw new Error("Knowledge non-production communication binding must be distinct.");
  if (candidate.sourceBindingIds.some((identity) => production.sourceBindingIds.includes(identity))) {
    throw new Error("Knowledge non-production Source bindings must be distinct from production bindings.");
  }
  const qualifiedAt = new Date(input.qualifiedAt).toISOString();
  const evidence = { candidate, production };
  const evidenceDigest = sha256(evidence);
  const base = {
    contractVersion: KNOWLEDGE_PRODUCTIZATION_QUALIFICATION_VERSION,
    status: "qualified" as const,
    candidateEnvironmentId: candidate.environmentId,
    productionEnvironmentId: production.environmentId,
    isolation: {
      stateBranch: true as const,
      runtimeScope: true as const,
      secretNamespace: true as const,
      communicationBinding: true as const,
      sourceBindings: true as const,
      boundedModelBudget: true as const,
    },
    evidenceDigest,
    qualifiedAt,
  };
  return { receiptId: sha256(base), ...base };
}

export function qualifyProductionKnowledgeCanary(input: {
  production: KnowledgeEnvironmentIdentity;
  canaryScope: {
    companyInstanceId: string;
    allowedAgentIds: string[];
    maximumTrafficPercent: number;
    servesExternalTraffic: boolean;
  };
  evidence: {
    stateBranchRehearsalReceiptId: string;
    databaseBackupReceiptId: string;
    v2FallbackReceiptId: string;
    shadowModeReceiptId: string;
    operatorRiskAcceptanceReceiptId: string;
  };
  qualifiedAt: string;
}): KnowledgeProductionCanaryQualificationReceipt {
  const production = normalizeEnvironment(input.production);
  if (production.environmentClass !== "production") throw new Error("Knowledge production canary requires a production environment identity.");
  if (input.canaryScope.servesExternalTraffic) throw new Error("Knowledge production canary is restricted to internal dogfood traffic.");
  if (!Number.isFinite(input.canaryScope.maximumTrafficPercent) || input.canaryScope.maximumTrafficPercent <= 0 || input.canaryScope.maximumTrafficPercent > 100) {
    throw new Error("Knowledge production canary traffic percentage must be greater than zero and at most 100.");
  }
  const canaryScope = {
    companyInstanceId: required(input.canaryScope.companyInstanceId, "Knowledge production canary Company Instance ID"),
    allowedAgentIds: identities(input.canaryScope.allowedAgentIds, "Knowledge production canary Agent"),
    maximumTrafficPercent: Number(input.canaryScope.maximumTrafficPercent.toFixed(4)),
    servesExternalTraffic: false as const,
  };
  const controlEntries = Object.entries(input.evidence) as Array<[keyof typeof input.evidence, string]>;
  const evidence = Object.fromEntries(controlEntries.map(([key, value]) => [key, required(value, `Knowledge production canary evidence '${key}'`)])) as typeof input.evidence;
  if (forbidden.test(canonicalJson({ production, canaryScope, evidence }))) throw new Error("Knowledge production canary evidence contains a credential or secret value.");
  const qualifiedAt = new Date(input.qualifiedAt).toISOString();
  const evidenceDigest = sha256({ production, canaryScope, evidence });
  const base = {
    contractVersion: KNOWLEDGE_PRODUCTIZATION_QUALIFICATION_VERSION,
    status: "qualified-for-production-canary" as const,
    productionEnvironmentId: production.environmentId,
    canaryScope,
    controls: {
      stateBranchRehearsal: true as const,
      databaseBackup: true as const,
      v2Fallback: true as const,
      shadowMode: true as const,
      operatorRiskAcceptance: true as const,
    },
    evidence,
    evidenceDigest,
    qualifiedAt,
  };
  return { receiptId: sha256(base), ...base };
}

export function createKnowledgeLiveShadowObservation(input: {
  query: string;
  authorizationContext: unknown;
  baselineSnapshotHash: string | null;
  candidateProjectionHash: string | null;
  baselineContentDigests: string[];
  candidateContentDigests: string[];
  candidateFailure?: unknown;
  observedAt: string;
}): KnowledgeLiveShadowObservationReceipt {
  const query = input.query.trim();
  if (!query || query.length > 4_000) throw new Error("Knowledge live shadow query is invalid.");
  const orderedDigests = (values: string[], label: string): string[] => {
    if (!Array.isArray(values) || values.length > 200) throw new Error(`${label} exceeds its bounded size.`);
    return values.map((value) => required(value, label));
  };
  const baseline = orderedDigests(input.baselineContentDigests, "Knowledge live shadow baseline digest");
  const candidate = orderedDigests(input.candidateContentDigests, "Knowledge live shadow candidate digest");
  for (const digest of [...baseline, ...candidate]) if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Knowledge live shadow content digest is invalid.");
  const candidateFailureDigest = input.candidateFailure === undefined ? undefined : sha256(input.candidateFailure instanceof Error ? input.candidateFailure.message : String(input.candidateFailure));
  const candidateSet = new Set(candidate);
  const comparison = {
    baselineResultCount: baseline.length,
    candidateResultCount: candidate.length,
    sharedContentDigestCount: baseline.filter((digest) => candidateSet.has(digest)).length,
    topContentDigestMatch: Boolean(baseline[0] && baseline[0] === candidate[0]),
    candidateFailed: Boolean(candidateFailureDigest),
    ...(candidateFailureDigest ? { candidateFailureDigest } : {}),
  };
  const base = {
    contractVersion: KNOWLEDGE_PRODUCTIZATION_QUALIFICATION_VERSION,
    status: "recorded" as const,
    mode: "v2-served-v3-shadowed" as const,
    queryDigest: sha256(query),
    authorizationContextDigest: sha256(input.authorizationContext),
    baselineSnapshotHash: input.baselineSnapshotHash,
    candidateProjectionHash: input.candidateProjectionHash,
    comparison,
    observedAt: new Date(input.observedAt).toISOString(),
  };
  if (forbidden.test(canonicalJson(base))) throw new Error("Knowledge live shadow evidence contains a credential or secret value.");
  return { receiptId: sha256(base), ...base };
}

export function createKnowledgeOperationalGateReceipt(input: {
  gateId: KnowledgeOperationalGateId;
  passed: boolean;
  metrics: Record<string, number | boolean | string>;
  evidenceIds?: string[];
  recordedAt: string;
}): KnowledgeOperationalGateReceipt {
  const gateId = required(input.gateId, "Knowledge operational gate ID");
  if (!new Set<KnowledgeOperationalGateId>([
    "authorization-negative-tests",
    "citation-regression",
    "v2-fallback",
    "database-qualification",
    "source-qualification",
    "runtime-live-verification",
  ]).has(gateId as KnowledgeOperationalGateId)) throw new Error("Knowledge operational gate ID is invalid.");
  const metrics = Object.fromEntries(Object.entries(input.metrics).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => {
    const normalizedKey = required(key, "Knowledge operational gate metric key");
    if (normalizedKey.length > 200) throw new Error("Knowledge operational gate metric key is invalid.");
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`Knowledge operational gate metric '${normalizedKey}' is invalid.`);
    if (typeof value === "string") required(value, `Knowledge operational gate metric '${normalizedKey}'`);
    return [normalizedKey, value];
  }));
  const evidenceIds = identities(input.evidenceIds ?? [], "Knowledge operational gate evidence", true);
  const recordedAt = new Date(input.recordedAt).toISOString();
  const evidenceDigest = sha256({ gateId, metrics, evidenceIds });
  const base = {
    contractVersion: KNOWLEDGE_PRODUCTIZATION_QUALIFICATION_VERSION,
    status: input.passed ? "passed" as const : "failed" as const,
    gateId: gateId as KnowledgeOperationalGateId,
    metrics,
    evidenceIds,
    evidenceDigest,
    recordedAt,
  };
  if (forbidden.test(canonicalJson(base))) throw new Error("Knowledge operational gate evidence contains a credential or secret value.");
  return { receiptId: sha256(base), ...base };
}

export function qualifyKnowledgeProductizationActivation(input: {
  evidence: KnowledgeProductizationActivationEvidence;
  rolloutReceipt: KnowledgeRolloutQualificationReceipt;
  qualifiedAt: string;
}): KnowledgeProductizationActivationReceipt {
  if (!["qualified", "qualified-for-production-canary"].includes(input.rolloutReceipt.status)
    || input.rolloutReceipt.contractVersion !== KNOWLEDGE_PRODUCTIZATION_QUALIFICATION_VERSION) {
    throw new Error("Knowledge productization requires a qualified rollout receipt.");
  }
  const sourceQualificationReceiptIds = identities(input.evidence.sourceQualificationReceiptIds, "Knowledge Source qualification receipt");
  const scalarEvidence = Object.entries(input.evidence).filter(([, value]) => typeof value === "string") as Array<[string, string]>;
  for (const [field, value] of scalarEvidence) required(value, `Knowledge activation evidence '${field}'`);
  if (input.evidence.rolloutQualificationReceiptId !== input.rolloutReceipt.receiptId) {
    throw new Error("Knowledge activation evidence does not match its rollout qualification receipt.");
  }
  const evidence = { ...input.evidence, sourceQualificationReceiptIds };
  if (forbidden.test(canonicalJson(evidence))) throw new Error("Knowledge activation evidence contains a credential or secret value.");
  const base = {
    contractVersion: KNOWLEDGE_PRODUCTIZATION_QUALIFICATION_VERSION,
    status: "qualified-for-explicit-activation" as const,
    evidence,
    qualifiedAt: new Date(input.qualifiedAt).toISOString(),
  };
  return { receiptId: sha256(base), ...base };
}
