export const SOURCE_CONNECTOR_CONTRACT_VERSION = "1.0.0" as const;
export const RUNTIME_OBSERVATION_CONTRACT_VERSION = "1.0.0" as const;

export type SourceRetentionPolicy =
  | { mode: "retain" }
  | { mode: "expire-after-days"; days: number };

export const sourceRetentionUntil = (observedAt: string, retention: SourceRetentionPolicy): string =>
  retention.mode === "retain"
    ? "9999-12-31T23:59:59.999Z"
    : new Date(Date.parse(observedAt) + retention.days * 86_400_000).toISOString();

export interface KnowledgeSourceRequirement {
  version: 1;
  sourceId: string;
  kind: "repository-documents";
  dataOwner: string;
  retention: SourceRetentionPolicy;
  legalHold: boolean;
  dataClass: "business";
  personalData: false;
  pathPrefix: string;
  includeExtensions: [".md"];
  maxObjectBytes: number;
  staleAfterHours: number;
}

export interface KnowledgeSourceBinding {
  version: 1;
  sourceId: string;
  connector: "oregano/github-repository-source";
  connectorVersion: typeof SOURCE_CONNECTOR_CONTRACT_VERSION;
  secretRef: string;
  owner: string;
  repository: string;
  ref: string;
  apiBaseUrl?: string;
  requiredScopes: ["contents:read"];
}

export interface SourceObjectDescriptor {
  providerObjectId: string;
  providerVersion: string;
  path: string;
  mediaType: "text/markdown";
  size: number;
}

export interface SourceReceipt {
  receiptId: string;
  sourceId: string;
  operation: "verify" | "enumerate" | "fetch" | "reconcile" | "revoke" | "delete";
  observedAt: string;
  cursor?: string;
  objectId?: string;
  objectVersion?: string;
  evidence: Record<string, unknown>;
}

export interface SourceEnvelope {
  sourceId: string;
  providerObjectId: string;
  providerVersion: string;
  observedAt: string;
  mediaType: "text/markdown";
  contentDigest: string;
  ownerOrAccount: string;
  cursorOrEventId: string;
  deletionState: "present" | "deleted";
  receiptMetadata: Record<string, unknown>;
  boundedText?: string;
}

export interface SourcePage {
  objects: SourceObjectDescriptor[];
  nextCursor?: string;
  complete: boolean;
  receipt: SourceReceipt;
}

export interface SourceVerification {
  ok: boolean;
  sourceId: string;
  connector: string;
  repositoryIdentity: string;
  ref: string;
  requiredScopes: string[];
  receipt: SourceReceipt;
}

export interface SourceHealth {
  ok: boolean;
  sourceId: string;
  status: "healthy" | "stale" | "revoked" | "error";
  checkedAt: string;
  lastSuccessfulSync?: string;
  reason?: string;
}

export interface KnowledgeSourceConnector {
  readonly id: string;
  readonly version: typeof SOURCE_CONNECTOR_CONTRACT_VERSION;
  readonly sourceId: string;
  verify(): Promise<SourceVerification>;
  enumerate(input?: { cursor?: string; pageSize?: number }): Promise<SourcePage>;
  fetch(descriptor: SourceObjectDescriptor, cursorOrEventId: string): Promise<{ envelope: SourceEnvelope; receipt: SourceReceipt }>;
  health(): Promise<SourceHealth>;
  revoke(): Promise<SourceReceipt>;
}

export type RuntimeObservationStatus = "active" | "superseded" | "expired" | "deletion-requested" | "deleted" | "legal-hold";

export interface RuntimeObservation {
  observationId: string;
  subject: string;
  content: string;
  contentDigest: string;
  observedAt: string;
  expiresAt?: string;
  runId: string;
  agentId: string;
  evidence: Record<string, unknown>;
  status: RuntimeObservationStatus;
  supersedes?: string;
  personalData: false;
}

export interface KnowledgeSourceStore {
  registerSource(requirement: KnowledgeSourceRequirement, binding: Omit<KnowledgeSourceBinding, "secretRef"> & { secretRef: string }): Promise<void>;
  getCursor(sourceId: string): Promise<string | undefined>;
  recordReceipt(receipt: SourceReceipt): Promise<boolean>;
  upsertEnvelope(envelope: SourceEnvelope, retention: SourceRetentionPolicy): Promise<"inserted" | "updated" | "unchanged">;
  getEnvelope(sourceId: string, providerObjectId: string, providerVersion?: string): Promise<SourceEnvelope | undefined>;
  reconcileEnvelopes(sourceId: string, presentObjectIds: readonly string[], observedAt: string, retention: SourceRetentionPolicy): Promise<number>;
  purgeExpiredSourceContent(sourceId: string, now: string): Promise<number>;
  updateCursor(sourceId: string, cursor: string | undefined, completed: boolean): Promise<void>;
  recordSourceHealth(health: SourceHealth): Promise<void>;
  revokeSource(sourceId: string, receipt: SourceReceipt): Promise<void>;
  recordObservation(observation: RuntimeObservation): Promise<boolean>;
  getObservation(observationId: string): Promise<RuntimeObservation | undefined>;
  supersedeObservation(observationId: string, replacementId: string): Promise<boolean>;
  expireObservations(now: string): Promise<number>;
  requestObservationDeletion(observationId: string, requestedBy: string, reason: string): Promise<string>;
  setObservationLegalHold(observationId: string, enabled: boolean, actor: string): Promise<boolean>;
  applyObservationDeletion(observationId: string): Promise<"deleted" | "held" | "missing">;
  listObservationPromotionCandidates(limit?: number): Promise<RuntimeObservation[]>;
}
