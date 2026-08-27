import { canonicalJson, sha256 } from "../runtime/canonical.ts";

export const BRAIN_CONTRACT_VERSION = "0.1.0" as const;
export const BRAIN_PAGE_TAXONOMY_VERSION = "1.0.0" as const;

export const BASE_BRAIN_PAGE_TYPES = [
  { key: "person", displayLabel: "Person", extractionProfile: "identity" },
  { key: "company", displayLabel: "Company", extractionProfile: "identity" },
  { key: "media", displayLabel: "Media", extractionProfile: "media" },
  { key: "tweet", displayLabel: "Tweet", extractionProfile: "social-item" },
  { key: "social-digest", displayLabel: "Social digest", extractionProfile: "social-digest" },
  { key: "analysis", displayLabel: "Analysis", extractionProfile: "analysis" },
  { key: "atom", displayLabel: "Atom", extractionProfile: "atomic" },
  { key: "concept", displayLabel: "Concept", extractionProfile: "concept" },
  { key: "source", displayLabel: "Source", extractionProfile: "source" },
  { key: "deal", displayLabel: "Deal", extractionProfile: "commercial" },
  { key: "email", displayLabel: "Email", extractionProfile: "message" },
  { key: "slack", displayLabel: "Slack", extractionProfile: "message" },
  { key: "meeting", displayLabel: "Meeting", extractionProfile: "transcript" },
  { key: "conversation", displayLabel: "Conversation", extractionProfile: "transcript" },
  { key: "writing", displayLabel: "Writing", extractionProfile: "document" },
  { key: "project", displayLabel: "Project", extractionProfile: "project" },
  { key: "note", displayLabel: "Note", extractionProfile: "note" },
  { key: "event", displayLabel: "Event", extractionProfile: "event" },
  { key: "diary", displayLabel: "Diary", extractionProfile: "chronology" },
] as const;

export type BaseBrainPageType = typeof BASE_BRAIN_PAGE_TYPES[number]["key"];
export type PageTypeOrigin = "core" | "extension" | "legacy";
export type PageTypeStatus = "active" | "deprecated";

export interface BrainPageTypeDefinition {
  key: string;
  taxonomyVersion: string;
  displayLabel: string;
  aliases: string[];
  parentKey?: string;
  extractionProfile: string;
  origin: PageTypeOrigin;
  status: PageTypeStatus;
}

export const CORE_BRAIN_PAGE_TAXONOMY: readonly BrainPageTypeDefinition[] = BASE_BRAIN_PAGE_TYPES.map((entry) => ({
  ...entry,
  taxonomyVersion: BRAIN_PAGE_TAXONOMY_VERSION,
  aliases: [],
  origin: "core",
  status: "active",
}));

const PAGE_TYPE_KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function assertBrainPageTypeRegistry(definitions: readonly BrainPageTypeDefinition[]): void {
  const keys = new Set<string>();
  const aliases = new Set<string>();
  for (const definition of definitions) {
    if (!PAGE_TYPE_KEY.test(definition.key)) throw new Error(`Invalid Brain Page type key '${definition.key}'.`);
    if (!definition.taxonomyVersion.trim() || !definition.displayLabel.trim() || !definition.extractionProfile.trim()) {
      throw new Error(`Brain Page type '${definition.key}' requires taxonomyVersion, displayLabel, and extractionProfile.`);
    }
    if (keys.has(definition.key) || aliases.has(definition.key)) throw new Error(`Duplicate Brain Page type key '${definition.key}'.`);
    keys.add(definition.key);
    for (const alias of definition.aliases) {
      if (!PAGE_TYPE_KEY.test(alias)) throw new Error(`Invalid Brain Page type alias '${alias}'.`);
      if (alias === definition.key || keys.has(alias) || aliases.has(alias)) throw new Error(`Duplicate Brain Page type alias '${alias}'.`);
      aliases.add(alias);
    }
    if (definition.parentKey === definition.key) throw new Error(`Brain Page type '${definition.key}' cannot be its own parent.`);
  }
  for (const definition of definitions) {
    if (definition.parentKey && !keys.has(definition.parentKey)) throw new Error(`Unknown parent Brain Page type '${definition.parentKey}'.`);
  }
}

export interface BrainPageTypeResolution {
  key: string;
  matchedBy: "key" | "alias" | "fallback";
  definition: BrainPageTypeDefinition;
}

export function resolveBrainPageType(
  candidate: string | undefined,
  definitions: readonly BrainPageTypeDefinition[] = CORE_BRAIN_PAGE_TAXONOMY,
): BrainPageTypeResolution {
  assertBrainPageTypeRegistry(definitions);
  const normalized = candidate?.trim().toLocaleLowerCase("en");
  const exact = definitions.find((entry) => entry.key === normalized);
  if (exact) return { key: exact.key, matchedBy: "key", definition: structuredClone(exact) };
  const alias = definitions.find((entry) => entry.aliases.includes(normalized ?? ""));
  if (alias) return { key: alias.key, matchedBy: "alias", definition: structuredClone(alias) };
  const fallback = definitions.find((entry) => entry.key === "note");
  if (!fallback) throw new Error("Brain Page type registry requires the 'note' fallback type.");
  return { key: fallback.key, matchedBy: "fallback", definition: structuredClone(fallback) };
}

export type PageVerificationStatus = "unverified" | "verified" | "rejected";
export type PageLifecycleStatus = "active" | "superseded" | "forgotten" | "deleted";

export interface BrainPage {
  pageId: string;
  pageTypeKey: string;
  sourceId: string;
  sourcePageKey: string;
  currentVersionId: string;
  verificationStatus: PageVerificationStatus;
  accessPolicyId: string;
  lifecycleStatus: PageLifecycleStatus;
  createdAt: string;
}

export interface BrainPageVersion {
  pageVersionId: string;
  pageId: string;
  version: number;
  title: string;
  summary?: string;
  body: string;
  metadata: Record<string, unknown>;
  contentDigest: string;
  observedAt: string;
  createdAt: string;
  sourceObjectId: string;
  sourceObjectVersion: string;
  accessPolicyId: string;
  modelProvenance?: { model: string; promptVersion: string; extractionRunId: string };
}

export interface BrainPageVersionInput {
  pageTypeKey: string;
  sourceId: string;
  sourcePageKey: string;
  verificationStatus: PageVerificationStatus;
  accessPolicyId: string;
  lifecycleStatus?: PageLifecycleStatus;
  pageCreatedAt: string;
  version: number;
  title: string;
  summary?: string;
  body: string;
  metadata: Record<string, unknown>;
  observedAt: string;
  versionCreatedAt: string;
  sourceObjectId: string;
  sourceObjectVersion: string;
  modelProvenance?: { model: string; promptVersion: string; extractionRunId: string };
}

export type EntityIdentityKind = "person" | "organization" | "project" | "deal" | "concept" | "other";
export type EntityCreationBasis = "provider-identifier" | "administrator-mapping" | "review-decision";
export type EntityMembershipProofBasis = "provider-identifier" | "administrator-mapping" | "deterministic-rule" | "review-decision";
export type EntityProposalMethod = "name-similarity" | "embedding-similarity" | "model-judgment";

const ENTITY_IDENTITY_KINDS: readonly EntityIdentityKind[] = ["person", "organization", "project", "deal", "concept", "other"];
const ENTITY_CREATION_BASES: readonly EntityCreationBasis[] = ["provider-identifier", "administrator-mapping", "review-decision"];
const ENTITY_MEMBERSHIP_PROOFS: readonly EntityMembershipProofBasis[] = ["provider-identifier", "administrator-mapping", "deterministic-rule", "review-decision"];
const ENTITY_PROPOSAL_METHODS: readonly EntityProposalMethod[] = ["name-similarity", "embedding-similarity", "model-judgment"];

export interface EntityIdentity {
  entityId: string;
  entityKind: EntityIdentityKind;
  stableKey: string;
  displayName: string;
  creationBasis: EntityCreationBasis;
  creationReceiptId: string;
  lifecycleStatus: "active" | "merged" | "deleted";
  createdAt: string;
}

export interface EntityIdentityMembership {
  membershipId: string;
  entityId: string;
  pageId: string;
  proofBasis: EntityMembershipProofBasis;
  proofReceiptId: string;
  pageAccessPolicyId: string;
  status: "active" | "revoked";
  createdAt: string;
}

export interface EntityIdentityProposal {
  proposalId: string;
  candidatePageId: string;
  targetEntityId: string;
  method: EntityProposalMethod;
  score?: number;
  rationale: string;
  evidenceReceiptIds: string[];
  candidateAccessPolicyId: string;
  createdBy: string;
  createdAt: string;
  modelProvenance?: { model: string; promptVersion: string; extractionRunId: string };
  status: "proposed";
}

export interface EntityIdentityDecision {
  decisionId: string;
  proposalId: string;
  decision: "accepted" | "rejected";
  decidedBy: string;
  decidedAt: string;
  decisionReceiptId: string;
  membership?: EntityIdentityMembership;
}

export type FactClaimKind = "event" | "preference" | "commitment" | "belief" | "fact";
export type TakeClaimKind = "fact" | "take" | "bet" | "hunch";
export type ClaimStatus = "proposed" | "active" | "superseded" | "expired" | "resolved" | "forgotten" | "contested" | "deleted";
export type HolderType = "person" | "team" | "company" | "world" | "system" | "unresolved";
export type ClaimParticipantRelationType = "speaker" | "author" | "subject" | "approver" | "owner" | "beneficiary" | "affected-party";

export interface EpistemicHolder {
  holderId: string;
  holderType: HolderType;
  displayName: string;
}

export type ClaimEvidenceLocator =
  | { kind: "line"; start: number; end: number }
  | { kind: "timestamp"; startMs: number; endMs: number }
  | { kind: "provider-object"; value: string }
  | { kind: "json-pointer"; value: string };

export interface ClaimEvidence {
  evidenceId: string;
  sourceId: string;
  providerObjectId: string;
  providerVersion: string;
  contentDigest: string;
  observedAt: string;
  locator: ClaimEvidenceLocator;
  pageId?: string;
  pageVersionId?: string;
}

interface BrainClaimInputBase {
  claimText: string;
  observedAt: string;
  validFrom?: string;
  validUntil?: string;
  evidence: ClaimEvidence[];
  unresolvedEvidenceReason?: string;
  extractionConfidence: number;
  epistemicWeight: number;
  accessPolicyId: string;
  createdBy: string;
  modelProvenance?: { model: string; promptVersion: string; extractionRunId: string };
}

export interface FactClaimInput extends BrainClaimInputBase {
  memoryClass: "fact";
  claimKind: FactClaimKind;
  ownerPrincipalId: string;
  scope: { kind: "principal" } | { kind: "session"; sessionId: string };
}

export type TakeDerivation = "source-literal" | "fact-consolidation" | "model-derived" | "holder-accepted";

export interface TakeClaimInput extends BrainClaimInputBase {
  memoryClass: "take";
  claimKind: TakeClaimKind;
  primaryHolder: EpistemicHolder;
  derivation: TakeDerivation;
  consolidationReceiptId?: string;
  activationReceiptId?: string;
}

export type BrainClaimInput = FactClaimInput | TakeClaimInput;

export interface BrainClaim {
  claimId: string;
  memoryClass: "fact" | "take";
  claimKind: FactClaimKind | TakeClaimKind;
  claimText: string;
  status: ClaimStatus;
  ownerPrincipalId?: string;
  scope?: FactClaimInput["scope"];
  primaryHolder?: EpistemicHolder;
  derivation: "principal-memory" | TakeDerivation;
  evidence: ClaimEvidence[];
  unresolvedEvidenceReason?: string;
  observedAt: string;
  validFrom?: string;
  validUntil?: string;
  extractionConfidence: number;
  epistemicWeight: number;
  accessPolicyId: string;
  createdBy: string;
  consolidationReceiptId?: string;
  activationReceiptId?: string;
  modelProvenance?: { model: string; promptVersion: string; extractionRunId: string };
}

const required = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
};

const iso = (value: string, label: string): string => {
  if (Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(value).toISOString();
};

const normalizeModelProvenance = (
  value: { model: string; promptVersion: string; extractionRunId: string } | undefined,
  label: string,
): { model: string; promptVersion: string; extractionRunId: string } | undefined => value ? {
  model: required(value.model, `${label} model`),
  promptVersion: required(value.promptVersion, `${label} prompt version`),
  extractionRunId: required(value.extractionRunId, `${label} extraction run ID`),
} : undefined;

export function createBrainPageVersion(input: BrainPageVersionInput): { page: BrainPage; version: BrainPageVersion } {
  if (!Number.isInteger(input.version) || input.version < 1) throw new Error("Brain Page version must be a positive integer.");
  const pageTypeKey = required(input.pageTypeKey, "Brain Page type key");
  const sourceId = required(input.sourceId, "Brain Page source ID");
  const sourcePageKey = required(input.sourcePageKey, "Brain Page source key");
  const accessPolicyId = required(input.accessPolicyId, "Brain Page access policy ID");
  const pageCreatedAt = iso(input.pageCreatedAt, "Brain Page createdAt");
  const observedAt = iso(input.observedAt, "Brain Page version observedAt");
  const versionCreatedAt = iso(input.versionCreatedAt, "Brain Page version createdAt");
  const title = required(input.title, "Brain Page version title");
  const body = required(input.body, "Brain Page version body");
  const summary = input.summary?.trim() || undefined;
  const sourceObjectId = required(input.sourceObjectId, "Brain Page source object ID");
  const sourceObjectVersion = required(input.sourceObjectVersion, "Brain Page source object version");
  const modelProvenance = normalizeModelProvenance(input.modelProvenance, "Brain Page provenance");
  const pageId = sha256({ sourceId, sourcePageKey });
  const contentDigest = sha256({ title, summary, body, metadata: input.metadata, sourceObjectId, sourceObjectVersion });
  const pageVersionId = sha256({ pageId, version: input.version, contentDigest, observedAt, accessPolicyId, modelProvenance });
  return {
    page: {
      pageId,
      pageTypeKey,
      sourceId,
      sourcePageKey,
      currentVersionId: pageVersionId,
      verificationStatus: input.verificationStatus,
      accessPolicyId,
      lifecycleStatus: input.lifecycleStatus ?? "active",
      createdAt: pageCreatedAt,
    },
    version: {
      pageVersionId,
      pageId,
      version: input.version,
      title,
      summary,
      body,
      metadata: structuredClone(input.metadata),
      contentDigest,
      observedAt,
      createdAt: versionCreatedAt,
      sourceObjectId,
      sourceObjectVersion,
      accessPolicyId,
      modelProvenance,
    },
  };
}

export function assertBrainPageVersionIntegrity(page: BrainPage, version: BrainPageVersion): void {
  const rebuilt = createBrainPageVersion({
    pageTypeKey: page.pageTypeKey,
    sourceId: page.sourceId,
    sourcePageKey: page.sourcePageKey,
    verificationStatus: page.verificationStatus,
    accessPolicyId: page.accessPolicyId,
    lifecycleStatus: page.lifecycleStatus,
    pageCreatedAt: page.createdAt,
    version: version.version,
    title: version.title,
    summary: version.summary,
    body: version.body,
    metadata: version.metadata,
    observedAt: version.observedAt,
    versionCreatedAt: version.createdAt,
    sourceObjectId: version.sourceObjectId,
    sourceObjectVersion: version.sourceObjectVersion,
    modelProvenance: version.modelProvenance,
  });
  if (version.pageId !== page.pageId || page.currentVersionId !== version.pageVersionId || canonicalJson(rebuilt) !== canonicalJson({ page, version })) {
    throw new Error("Brain Page or Page version failed deterministic integrity validation.");
  }
}

export function createEntityIdentity(input: {
  entityKind: EntityIdentityKind;
  stableKey: string;
  displayName: string;
  creationBasis: EntityCreationBasis;
  creationReceiptId: string;
  createdAt: string;
}): EntityIdentity {
  if (!ENTITY_IDENTITY_KINDS.includes(input.entityKind)) throw new Error(`Unsupported Entity kind '${input.entityKind}'.`);
  if (!ENTITY_CREATION_BASES.includes(input.creationBasis)) throw new Error(`Unsupported Entity creation basis '${input.creationBasis}'.`);
  const stableKey = required(input.stableKey, "Entity stable key");
  const base = {
    entityKind: input.entityKind,
    stableKey,
    displayName: required(input.displayName, "Entity display name"),
    creationBasis: input.creationBasis,
    creationReceiptId: required(input.creationReceiptId, "Entity creation receipt ID"),
    lifecycleStatus: "active" as const,
    createdAt: iso(input.createdAt, "Entity createdAt"),
  };
  return { entityId: sha256({ entityKind: input.entityKind, stableKey }), ...base };
}

export function assertEntityIdentityIntegrity(entity: EntityIdentity): void {
  const rebuilt = createEntityIdentity({
    entityKind: entity.entityKind,
    stableKey: entity.stableKey,
    displayName: entity.displayName,
    creationBasis: entity.creationBasis,
    creationReceiptId: entity.creationReceiptId,
    createdAt: entity.createdAt,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(entity)) throw new Error("Entity identity failed deterministic integrity validation.");
}

export function createEntityIdentityMembership(input: {
  entity: EntityIdentity;
  page: BrainPage;
  proofBasis: EntityMembershipProofBasis;
  proofReceiptId: string;
  createdAt: string;
}): EntityIdentityMembership {
  assertEntityIdentityIntegrity(input.entity);
  if (!ENTITY_MEMBERSHIP_PROOFS.includes(input.proofBasis)) throw new Error(`Unsupported Entity membership proof '${input.proofBasis}'.`);
  const proofReceiptId = required(input.proofReceiptId, "Entity membership proof receipt ID");
  const base = {
    entityId: input.entity.entityId,
    pageId: required(input.page.pageId, "Entity membership Page ID"),
    proofBasis: input.proofBasis,
    proofReceiptId,
    pageAccessPolicyId: required(input.page.accessPolicyId, "Entity membership Page access policy ID"),
    status: "active" as const,
    createdAt: iso(input.createdAt, "Entity membership createdAt"),
  };
  return { membershipId: sha256(base), ...base };
}

export function assertEntityIdentityMembershipIntegrity(
  membership: EntityIdentityMembership,
  entity: EntityIdentity,
  page: BrainPage,
): void {
  const rebuilt = createEntityIdentityMembership({
    entity,
    page,
    proofBasis: membership.proofBasis,
    proofReceiptId: membership.proofReceiptId,
    createdAt: membership.createdAt,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(membership)) throw new Error("Entity membership failed deterministic integrity validation.");
}

export function createEntityIdentityProposal(input: {
  candidatePage: BrainPage;
  targetEntity: EntityIdentity;
  method: EntityProposalMethod;
  score?: number;
  rationale: string;
  evidenceReceiptIds: string[];
  createdBy: string;
  createdAt: string;
  modelProvenance?: { model: string; promptVersion: string; extractionRunId: string };
}): EntityIdentityProposal {
  assertEntityIdentityIntegrity(input.targetEntity);
  if (!ENTITY_PROPOSAL_METHODS.includes(input.method)) throw new Error(`Unsupported Entity proposal method '${input.method}'.`);
  if (input.score !== undefined && (input.score < 0 || input.score > 1)) throw new Error("Entity proposal score must be between 0 and 1.");
  const evidenceReceiptIds = [...new Set(input.evidenceReceiptIds.map((entry) => required(entry, "Entity proposal evidence receipt ID")))].sort();
  if (evidenceReceiptIds.length === 0) throw new Error("Entity proposal requires at least one evidence receipt.");
  const modelProvenance = normalizeModelProvenance(input.modelProvenance, "Entity proposal provenance");
  if (input.method === "model-judgment" && !modelProvenance) {
    throw new Error("A model-derived Entity proposal requires model, prompt, and extraction-run provenance.");
  }
  const base = {
    candidatePageId: required(input.candidatePage.pageId, "Entity proposal candidate Page ID"),
    targetEntityId: input.targetEntity.entityId,
    method: input.method,
    score: input.score,
    rationale: required(input.rationale, "Entity proposal rationale"),
    evidenceReceiptIds,
    candidateAccessPolicyId: required(input.candidatePage.accessPolicyId, "Entity proposal candidate access policy ID"),
    createdBy: required(input.createdBy, "Entity proposal creator"),
    createdAt: iso(input.createdAt, "Entity proposal createdAt"),
    modelProvenance,
    status: "proposed" as const,
  };
  return { proposalId: sha256(base), ...base };
}

export function assertEntityIdentityProposalIntegrity(
  proposal: EntityIdentityProposal,
  candidatePage: BrainPage,
  targetEntity: EntityIdentity,
): void {
  const rebuilt = createEntityIdentityProposal({
    candidatePage,
    targetEntity,
    method: proposal.method,
    score: proposal.score,
    rationale: proposal.rationale,
    evidenceReceiptIds: proposal.evidenceReceiptIds,
    createdBy: proposal.createdBy,
    createdAt: proposal.createdAt,
    modelProvenance: proposal.modelProvenance,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(proposal)) throw new Error("Entity identity proposal failed deterministic integrity validation.");
}

export function createEntityIdentityDecision(input: {
  proposal: EntityIdentityProposal;
  candidatePage: BrainPage;
  targetEntity: EntityIdentity;
  decision: "accepted" | "rejected";
  decidedBy: string;
  decidedAt: string;
  decisionReceiptId: string;
}): EntityIdentityDecision {
  assertEntityIdentityProposalIntegrity(input.proposal, input.candidatePage, input.targetEntity);
  if (input.decision !== "accepted" && input.decision !== "rejected") throw new Error(`Unsupported Entity proposal decision '${input.decision}'.`);
  const decidedAt = iso(input.decidedAt, "Entity proposal decision time");
  const decisionReceiptId = required(input.decisionReceiptId, "Entity proposal decision receipt ID");
  const membership = input.decision === "accepted" ? createEntityIdentityMembership({
    entity: input.targetEntity,
    page: input.candidatePage,
    proofBasis: "review-decision",
    proofReceiptId: decisionReceiptId,
    createdAt: decidedAt,
  }) : undefined;
  const base = {
    proposalId: input.proposal.proposalId,
    decision: input.decision,
    decidedBy: required(input.decidedBy, "Entity proposal decision principal"),
    decidedAt,
    decisionReceiptId,
    membership,
  };
  return { decisionId: sha256(base), ...base };
}

export function assertEntityIdentityDecisionIntegrity(input: {
  decision: EntityIdentityDecision;
  proposal: EntityIdentityProposal;
  candidatePage: BrainPage;
  targetEntity: EntityIdentity;
}): void {
  const rebuilt = createEntityIdentityDecision({
    proposal: input.proposal,
    candidatePage: input.candidatePage,
    targetEntity: input.targetEntity,
    decision: input.decision.decision,
    decidedBy: input.decision.decidedBy,
    decidedAt: input.decision.decidedAt,
    decisionReceiptId: input.decision.decisionReceiptId,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(input.decision)) throw new Error("Entity identity decision failed deterministic integrity validation.");
}

const validateLocator = (locator: ClaimEvidenceLocator): void => {
  if (locator.kind === "line" && (!Number.isInteger(locator.start) || !Number.isInteger(locator.end) || locator.start < 1 || locator.end < locator.start)) {
    throw new Error("Claim line evidence requires a valid inclusive line range.");
  }
  if (locator.kind === "timestamp" && (locator.startMs < 0 || locator.endMs < locator.startMs)) {
    throw new Error("Claim timestamp evidence requires a valid millisecond range.");
  }
  if ((locator.kind === "provider-object" || locator.kind === "json-pointer") && !locator.value.trim()) {
    throw new Error("Claim evidence locator value is required.");
  }
};

const normalizeEvidence = (evidence: readonly ClaimEvidence[]): ClaimEvidence[] => {
  const normalized = evidence.map((entry) => {
    validateLocator(entry.locator);
    if (Boolean(entry.pageId) !== Boolean(entry.pageVersionId)) {
      throw new Error("Claim Page evidence requires both pageId and pageVersionId.");
    }
    return {
      ...structuredClone(entry),
      evidenceId: required(entry.evidenceId, "Claim evidence ID"),
      sourceId: required(entry.sourceId, "Claim evidence source ID"),
      providerObjectId: required(entry.providerObjectId, "Claim evidence provider object ID"),
      providerVersion: required(entry.providerVersion, "Claim evidence provider version"),
      contentDigest: required(entry.contentDigest, "Claim evidence content digest"),
      observedAt: iso(entry.observedAt, "Claim evidence observedAt"),
      pageId: entry.pageId ? required(entry.pageId, "Claim evidence Page ID") : undefined,
      pageVersionId: entry.pageVersionId ? required(entry.pageVersionId, "Claim evidence Page version ID") : undefined,
    };
  }).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  if (new Set(normalized.map((entry) => entry.evidenceId)).size !== normalized.length) {
    throw new Error("Claim evidence IDs must be unique within a Claim.");
  }
  return normalized;
};

export function createBrainClaim(input: BrainClaimInput): BrainClaim {
  const claimText = required(input.claimText, "Claim text");
  const observedAt = iso(input.observedAt, "Claim observedAt");
  const validFrom = input.validFrom ? iso(input.validFrom, "Claim validFrom") : undefined;
  const validUntil = input.validUntil ? iso(input.validUntil, "Claim validUntil") : undefined;
  if (validFrom && validUntil && Date.parse(validUntil) < Date.parse(validFrom)) throw new Error("Claim validUntil cannot precede validFrom.");
  if (!Number.isFinite(input.extractionConfidence) || input.extractionConfidence < 0 || input.extractionConfidence > 1) throw new Error("Claim extractionConfidence must be between 0 and 1.");
  if (!Number.isFinite(input.epistemicWeight)) throw new Error("Claim epistemicWeight must be finite.");
  const epistemicWeight = Math.round(Math.max(0, Math.min(1, input.epistemicWeight)) * 20) / 20;
  const evidence = normalizeEvidence(input.evidence);
  const unresolvedEvidenceReason = input.unresolvedEvidenceReason?.trim() || undefined;
  if (evidence.length === 0 && !unresolvedEvidenceReason) throw new Error("A Claim requires exact evidence or an explicit unresolved-evidence reason.");
  const modelProvenance = normalizeModelProvenance(input.modelProvenance, "Claim provenance");

  const common = {
    memoryClass: input.memoryClass,
    claimKind: input.claimKind,
    claimText,
    evidence,
    unresolvedEvidenceReason,
    observedAt,
    validFrom,
    validUntil,
    extractionConfidence: input.extractionConfidence,
    epistemicWeight,
    accessPolicyId: required(input.accessPolicyId, "Claim access policy ID"),
    createdBy: required(input.createdBy, "Claim creator"),
    modelProvenance,
  };

  let withoutId: Omit<BrainClaim, "claimId">;
  if (input.memoryClass === "fact") {
    const ownerPrincipalId = required(input.ownerPrincipalId, "Fact owner principal ID");
    if (input.scope.kind === "session") required(input.scope.sessionId, "Fact session ID");
    withoutId = { ...common, status: "active", ownerPrincipalId, scope: structuredClone(input.scope), derivation: "principal-memory" };
  } else {
    const primaryHolder = {
      ...structuredClone(input.primaryHolder),
      holderId: required(input.primaryHolder.holderId, "Take Holder ID"),
      displayName: required(input.primaryHolder.displayName, "Take Holder display name"),
    };
    if (input.derivation === "fact-consolidation" && !input.consolidationReceiptId?.trim()) {
      throw new Error("A consolidated Take requires a consolidation receipt.");
    }
    if (input.derivation === "holder-accepted" && !input.activationReceiptId?.trim()) {
      throw new Error("A Holder-accepted Take requires an activation receipt.");
    }
    if (input.derivation === "model-derived" && !modelProvenance) {
      throw new Error("A model-derived Take requires model, prompt, and extraction-run provenance.");
    }
    const resolvedHolder = primaryHolder.holderType !== "unresolved";
    const status: ClaimStatus = input.derivation === "model-derived"
      ? "proposed"
      : input.derivation === "source-literal"
        ? (resolvedHolder && evidence.length > 0 ? "active" : "proposed")
        : resolvedHolder ? "active" : "proposed";
    withoutId = {
      ...common,
      status,
      primaryHolder,
      derivation: input.derivation,
      consolidationReceiptId: input.consolidationReceiptId?.trim() || undefined,
      activationReceiptId: input.activationReceiptId?.trim() || undefined,
    };
  }
  return { claimId: sha256(withoutId), ...withoutId };
}

export function assertBrainClaimIntegrity(claim: BrainClaim): void {
  const common = {
    claimText: claim.claimText,
    observedAt: claim.observedAt,
    validFrom: claim.validFrom,
    validUntil: claim.validUntil,
    evidence: claim.evidence,
    unresolvedEvidenceReason: claim.unresolvedEvidenceReason,
    extractionConfidence: claim.extractionConfidence,
    epistemicWeight: claim.epistemicWeight,
    accessPolicyId: claim.accessPolicyId,
    createdBy: claim.createdBy,
    modelProvenance: claim.modelProvenance,
  };
  const rebuilt = claim.memoryClass === "fact"
    ? createBrainClaim({
      ...common,
      memoryClass: "fact",
      claimKind: claim.claimKind as FactClaimKind,
      ownerPrincipalId: claim.ownerPrincipalId ?? "",
      scope: claim.scope ?? { kind: "principal" },
    })
    : createBrainClaim({
      ...common,
      memoryClass: "take",
      claimKind: claim.claimKind as TakeClaimKind,
      primaryHolder: claim.primaryHolder ?? { holderId: "", holderType: "unresolved", displayName: "" },
      derivation: claim.derivation as TakeDerivation,
      consolidationReceiptId: claim.consolidationReceiptId,
      activationReceiptId: claim.activationReceiptId,
    });
  if (canonicalJson(rebuilt) !== canonicalJson(claim)) throw new Error("Brain Claim failed deterministic integrity validation.");
}

export type ClaimResolutionOutcome = "correct" | "incorrect" | "partial" | "unresolvable";

export interface ClaimResolutionProposal {
  proposalId: string;
  claimId: string;
  outcome: ClaimResolutionOutcome;
  outcomeEvidence: ClaimEvidence[];
  proposedBy: string;
  proposedAt: string;
  judgeReceiptId: string;
  status: "proposed";
  autoApplicable: false;
}

export function createClaimResolutionProposal(input: {
  claim: BrainClaim;
  outcome: ClaimResolutionOutcome;
  outcomeEvidence: ClaimEvidence[];
  proposedBy: string;
  proposedAt: string;
  judgeReceiptId: string;
}): ClaimResolutionProposal {
  const proposedAt = iso(input.proposedAt, "Claim resolution proposedAt");
  const outcomeEvidence = normalizeEvidence(input.outcomeEvidence);
  if (outcomeEvidence.length === 0) throw new Error("A Claim resolution proposal requires outcome evidence.");
  if (outcomeEvidence.some((entry) => Date.parse(entry.observedAt) <= Date.parse(input.claim.observedAt))) {
    throw new Error("Claim resolution evidence must postdate the Claim.");
  }
  const originalSourceObjects = new Set(input.claim.evidence.map((entry) => `${entry.sourceId}\0${entry.providerObjectId}`));
  const originalPages = new Set(input.claim.evidence.flatMap((entry) => entry.pageId ? [entry.pageId] : []));
  if (outcomeEvidence.every((entry) => originalSourceObjects.has(`${entry.sourceId}\0${entry.providerObjectId}`) || (entry.pageId !== undefined && originalPages.has(entry.pageId)))) {
    throw new Error("Claim resolution requires evidence independent from the Claim's own source Page.");
  }
  const base = {
    claimId: input.claim.claimId,
    outcome: input.outcome,
    outcomeEvidence,
    proposedBy: required(input.proposedBy, "Claim resolution proposer"),
    proposedAt,
    judgeReceiptId: required(input.judgeReceiptId, "Claim resolution judge receipt ID"),
    status: "proposed" as const,
    autoApplicable: false as const,
  };
  return { proposalId: sha256(base), ...base };
}

export function assertClaimResolutionProposalIntegrity(proposal: ClaimResolutionProposal, claim: BrainClaim): void {
  const rebuilt = createClaimResolutionProposal({
    claim,
    outcome: proposal.outcome,
    outcomeEvidence: proposal.outcomeEvidence,
    proposedBy: proposal.proposedBy,
    proposedAt: proposal.proposedAt,
    judgeReceiptId: proposal.judgeReceiptId,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(proposal)) throw new Error("Claim resolution proposal failed deterministic integrity validation.");
}
