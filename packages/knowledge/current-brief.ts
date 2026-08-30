import { sha256 } from "../runtime/canonical.ts";
import { KnowledgeAuthorizer } from "./access-control.ts";
import type { KnowledgeAccessAuditor, KnowledgeAccessPolicy, KnowledgeAccessSubject } from "./contracts.ts";
import { createKnowledgeRetrievalUnitV3, type KnowledgeRetrievalUnitV3 } from "./retrieval-unit.ts";

export const CURRENT_BRIEF_VIEW_CONTRACT_VERSION = "1.0.0" as const;

export interface CurrentBriefVersionInput {
  synthesisId: string;
  currentVersionId: string;
  synthesisVersionId: string;
  versionNumber: number;
  subjectType: string;
  subjectId: string;
  content: string;
  contentDigest: string;
  supportingClaimIds: readonly string[];
  contestedClaimIds: readonly string[];
  supersededClaimIds: readonly string[];
  gaps: readonly string[];
  accessPolicyId: string;
  synthesizedAt: string;
}

export interface CurrentBriefView {
  contractVersion: typeof CURRENT_BRIEF_VIEW_CONTRACT_VERSION;
  identity: string;
  title: string;
  authorityLayer: "synthesized";
  freshnessStatus: "current" | "potentially-stale";
  staleReasons: Array<"new-relevant-evidence" | "age-bound-exceeded">;
  synthesisId: string;
  synthesisVersionId: string;
  versionNumber: number;
  subjectType: string;
  subjectId: string;
  content: string;
  contentDigest: string;
  supportingClaimIds: string[];
  contestedClaimIds: string[];
  supersededClaimIds: string[];
  gaps: string[];
  accessPolicyId: string;
  synthesizedAt: string;
}

export interface CurrentBriefStore {
  policies(): Promise<KnowledgeAccessPolicy[]>;
  loadCurrent(input: { subjectType: string; subjectId: string; authorizedPolicyIds: string[] }): Promise<(CurrentBriefVersionInput & { latestRelevantChangeAt?: string }) | undefined>;
}

const required = (value: string, label: string, maximum = 2_000): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\0-\x08\x0b\x0c\x0e-\x1f]/.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
};

const iso = (value: string, label: string): string => {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(timestamp).toISOString();
};

const unique = (values: readonly string[], label: string): string[] => {
  if (!Array.isArray(values) || values.length > 500) throw new Error(`${label} exceeds its bounded list size.`);
  return [...new Set(values.map((value) => required(value, label, 1_000)))].sort();
};

const titleFrom = (content: string, subjectType: string, subjectId: string): string =>
  content.match(/^#\s+(.+)$/m)?.[1]?.trim() || `Current Brief: ${subjectType}:${subjectId}`;

export function createCurrentBriefView(input: CurrentBriefVersionInput & {
  latestRelevantChangeAt?: string;
  maximumAgeMs?: number;
  now?: string;
}): CurrentBriefView {
  const synthesisId = required(input.synthesisId, "Current Brief synthesis ID");
  const currentVersionId = required(input.currentVersionId, "Current Brief current version ID");
  const synthesisVersionId = required(input.synthesisVersionId, "Current Brief synthesis version ID");
  if (currentVersionId !== synthesisVersionId) throw new Error("Current Brief must render the current immutable Working Synthesis version.");
  if (!Number.isInteger(input.versionNumber) || input.versionNumber < 1) throw new Error("Current Brief version number must be a positive integer.");
  if (!input.content.trim()) throw new Error("Current Brief content is required.");
  if (!/^[a-f0-9]{64}$/.test(input.contentDigest) || input.contentDigest !== sha256(input.content)) throw new Error("Current Brief content digest does not match its exact Working Synthesis content.");
  const subjectType = required(input.subjectType, "Current Brief subject type", 256);
  const subjectId = required(input.subjectId, "Current Brief subject ID");
  const synthesizedAt = iso(input.synthesizedAt, "Current Brief synthesis time");
  const supportingClaimIds = unique(input.supportingClaimIds, "Current Brief supporting Claim ID");
  const contestedClaimIds = unique(input.contestedClaimIds, "Current Brief contested Claim ID");
  const supersededClaimIds = unique(input.supersededClaimIds, "Current Brief superseded Claim ID");
  const classified = [...supportingClaimIds, ...contestedClaimIds, ...supersededClaimIds];
  if (new Set(classified).size !== classified.length) throw new Error("Current Brief Claim classifications must be mutually exclusive.");
  if (classified.length === 0) throw new Error("Current Brief requires at least one exact classified Claim.");
  const staleReasons: CurrentBriefView["staleReasons"] = [];
  if (input.latestRelevantChangeAt && Date.parse(iso(input.latestRelevantChangeAt, "Current Brief latest relevant change time")) > Date.parse(synthesizedAt)) staleReasons.push("new-relevant-evidence");
  if (input.maximumAgeMs !== undefined) {
    if (!Number.isFinite(input.maximumAgeMs) || input.maximumAgeMs <= 0) throw new Error("Current Brief maximum age must be positive.");
    const now = iso(input.now ?? new Date().toISOString(), "Current Brief evaluation time");
    if (Date.parse(now) - Date.parse(synthesizedAt) > input.maximumAgeMs) staleReasons.push("age-bound-exceeded");
  }
  return {
    contractVersion: CURRENT_BRIEF_VIEW_CONTRACT_VERSION,
    identity: `current-brief:${synthesisId}`,
    title: titleFrom(input.content, subjectType, subjectId),
    authorityLayer: "synthesized",
    freshnessStatus: staleReasons.length === 0 ? "current" : "potentially-stale",
    staleReasons,
    synthesisId,
    synthesisVersionId,
    versionNumber: input.versionNumber,
    subjectType,
    subjectId,
    content: input.content,
    contentDigest: input.contentDigest,
    supportingClaimIds,
    contestedClaimIds,
    supersededClaimIds,
    gaps: unique(input.gaps, "Current Brief gap"),
    accessPolicyId: required(input.accessPolicyId, "Current Brief access policy ID"),
    synthesizedAt,
  };
}

const claimIdentity = (value: string): string => value.startsWith("claim:") ? value : `claim:${value}`;

export function currentBriefToRetrievalUnitV3(brief: CurrentBriefView): KnowledgeRetrievalUnitV3 {
  if (brief.contractVersion !== CURRENT_BRIEF_VIEW_CONTRACT_VERSION || brief.authorityLayer !== "synthesized") throw new Error("Current Brief view contract is invalid.");
  return createKnowledgeRetrievalUnitV3({
    unitId: `synthesis:${brief.synthesisId}`,
    parentId: `${brief.subjectType}:${brief.subjectId}`,
    kind: "working-synthesis",
    authorityLayer: "synthesized",
    state: "active",
    title: brief.title,
    aliases: ["current brief", "current state", `${brief.subjectType}:${brief.subjectId}`],
    text: brief.content,
    contentDigest: brief.contentDigest,
    accessPolicyId: brief.accessPolicyId,
    sourceIds: ["brain:synthesis"],
    observedAt: brief.synthesizedAt,
    graphNeighbors: [...brief.supportingClaimIds, ...brief.contestedClaimIds, ...brief.supersededClaimIds].map(claimIdentity),
    signals: {
      confidence: brief.contestedClaimIds.length > 0 ? 0.6 : 0.75,
      authority: 0.45,
      freshness: brief.freshnessStatus === "current" ? 1 : 0.35,
      expectedValue: 0.8,
    },
  });
}

export class CurrentBriefService {
  readonly #store: CurrentBriefStore;
  readonly #auditor?: KnowledgeAccessAuditor;
  readonly #resolveSubject?: (subject?: KnowledgeAccessSubject) => Promise<KnowledgeAccessSubject | undefined>;

  constructor(input: {
    store: CurrentBriefStore;
    auditor?: KnowledgeAccessAuditor;
    resolveSubject?: (subject?: KnowledgeAccessSubject) => Promise<KnowledgeAccessSubject | undefined>;
  }) {
    this.#store = input.store;
    this.#auditor = input.auditor;
    this.#resolveSubject = input.resolveSubject;
  }

  async get(input: { subjectType: string; subjectId: string; subject?: KnowledgeAccessSubject; maximumAgeMs?: number; now?: string }): Promise<CurrentBriefView | undefined> {
    const subjectType = required(input.subjectType, "Current Brief subject type", 256);
    const subjectId = required(input.subjectId, "Current Brief subject ID");
    const resolved = this.#resolveSubject ? await this.#resolveSubject(input.subject) : input.subject;
    const policies = await this.#store.policies();
    const authorizer = new KnowledgeAuthorizer(policies, this.#auditor);
    const authorizedPolicyIds: string[] = [];
    for (const policy of [...policies].sort((left, right) => left.policyId.localeCompare(right.policyId))) {
      if (await authorizer.authorize({ subject: resolved, permission: "read", policyIds: [policy.policyId], objectType: "policy", objectId: policy.policyId })) authorizedPolicyIds.push(policy.policyId);
    }
    if (authorizedPolicyIds.length === 0) return undefined;
    const current = await this.#store.loadCurrent({ subjectType, subjectId, authorizedPolicyIds });
    if (!current) return undefined;
    return createCurrentBriefView({ ...current, maximumAgeMs: input.maximumAgeMs, now: input.now });
  }
}
