import type { KnowledgeAccessPolicy } from "./contracts.ts";
import type {
  RawAssetReferenceV2,
  SourceAccessSnapshotV2,
  SourceEnvelopeContentV2,
  SourceEnvelopeV2,
  SourceEventV2,
  SourceReceiptV2,
} from "./source-contracts-v2.ts";

export type SourceEventProcessingStatus = "received" | "leased" | "processed" | "quarantined" | "failed" | "deferred";

export interface SourceEventRecordV2 {
  event: SourceEventV2;
  status: SourceEventProcessingStatus;
  attempt: number;
  leaseOwner?: string;
  leaseUntil?: string;
  failureClass?: SourcePipelineFailureClass;
  retryAfter?: string;
  completedAt?: string;
}

export type SourcePipelineFailureClass =
  | "provider-failure"
  | "integrity-failure"
  | "policy-failure"
  | "content-failure"
  | "storage-failure"
  | "unsupported";

export interface SourceRawEvidenceV2 {
  envelope: Omit<SourceEnvelopeV2, "content">;
  content?: SourceEnvelopeContentV2;
  access: SourceAccessSnapshotV2;
  sanityCodes: string[];
  modelReady: boolean;
  payloadState: "active" | "deletion-requested" | "purged";
  retentionUntil: string;
  recordedAt: string;
  redactedAt?: string;
}

export type SourceChangeKind = "ingested" | "deleted" | "access-changed" | "quarantined" | "restored" | "purged";

export interface SourceChangeEntryV2 {
  sequence: number;
  changeId: string;
  previousDigest?: string;
  chainDigest: string;
  sourceId: string;
  objectKind: "source-object" | "raw-asset" | "access-policy";
  objectId: string;
  objectVersion?: string;
  changeKind: SourceChangeKind;
  accessPolicyId: string;
  payloadDigest: string;
  receiptId: string;
  occurredAt: string;
}

export interface SourceWatermarkV2 {
  sourceId: string;
  streamId: string;
  cursor?: string;
  watermark?: string;
  completed: boolean;
  stateDigest: string;
  updatedAt: string;
}

export interface SourceInventoryObjectV2 {
  providerObjectId: string;
  providerVersion: string;
  deletionState: "present" | "deleted";
  observedAt: string;
}

export type SourceLifecycleTargetKind = "source-object" | "raw-asset";
export type SourceLifecycleStatus = "requested" | "restored" | "held" | "purged";

export interface SourceLifecycleRequestV2 {
  requestId: string;
  sourceId: string;
  targetKind: SourceLifecycleTargetKind;
  targetId: string;
  targetVersion?: string;
  requestedBy: string;
  reason: string;
  requestedAt: string;
  purgeAfter: string;
  dependencyIds: string[];
  accessPolicyId: string;
  status: SourceLifecycleStatus;
  legalHold: boolean;
  restoredAt?: string;
  purgedAt?: string;
  receiptId: string;
}

export type SourceEventInsertResult = "inserted" | "unchanged";
export type SourceEvidenceWriteResult = "inserted" | "unchanged";

export interface SourcePipelineStore {
  putEvent(event: SourceEventV2): Promise<SourceEventInsertResult>;
  getEvent(eventId: string): Promise<SourceEventRecordV2 | undefined>;
  claimEvent(input: { eventId: string; workerId: string; leaseUntil: string; now: string; maxAttempts: number }): Promise<"claimed" | "complete" | "busy" | "exhausted">;
  completeEvent(eventId: string, status: "processed" | "quarantined", completedAt: string): Promise<void>;
  failEvent(eventId: string, failureClass: SourcePipelineFailureClass, retryAfter: string): Promise<void>;

  putPolicy(policy: KnowledgeAccessPolicy, evidenceDigest: string): Promise<SourceEvidenceWriteResult>;
  getPolicy(policyId: string): Promise<KnowledgeAccessPolicy | undefined>;
  putAccessSnapshot(snapshot: SourceAccessSnapshotV2): Promise<SourceEvidenceWriteResult>;
  putRawEvidence(evidence: SourceRawEvidenceV2): Promise<SourceEvidenceWriteResult>;
  getRawEvidence(sourceId: string, providerObjectId: string, providerVersion?: string): Promise<SourceRawEvidenceV2 | undefined>;
  currentRawEvidence(sourceId: string, providerObjectId: string): Promise<SourceRawEvidenceV2 | undefined>;
  listCurrentSourceObjects(sourceId: string): Promise<SourceInventoryObjectV2[]>;
  markProviderDeleted(input: { sourceId: string; providerObjectId: string; observedAt: string; eventId: string }): Promise<"deleted" | "unchanged" | "missing">;
  updateObjectAccess(input: { sourceId: string; providerObjectId: string; access: SourceAccessSnapshotV2; accessPolicyId: string; observedAt: string }): Promise<"updated" | "unchanged" | "missing">;

  putRawAsset(reference: RawAssetReferenceV2, input: { sourceId: string; providerObjectId: string; providerVersion: string; accessPolicyId: string; retentionClass: "durable" | "session-temporary" }, payload?: Uint8Array): Promise<SourceEvidenceWriteResult>;
  getRawAsset(assetId: string): Promise<RawAssetReferenceV2 | undefined>;

  putReceipt(receipt: SourceReceiptV2): Promise<SourceEvidenceWriteResult>;
  appendChange(entry: Omit<SourceChangeEntryV2, "sequence" | "previousDigest" | "chainDigest">): Promise<SourceChangeEntryV2>;
  listChanges(input: { afterSequence?: number; limit: number }): Promise<SourceChangeEntryV2[]>;
  getWatermark(sourceId: string, streamId: string): Promise<SourceWatermarkV2 | undefined>;
  advanceWatermark(watermark: SourceWatermarkV2): Promise<"advanced" | "unchanged">;
  claimSyncLease(input: { sourceId: string; streamId: string; owner: string; acquiredAt: string; leaseUntil: string }): Promise<"claimed" | "busy">;
  releaseSyncLease(input: { sourceId: string; streamId: string; owner: string }): Promise<"released" | "unchanged">;

  previewDependencies(input: { sourceId: string; targetKind: SourceLifecycleTargetKind; targetId: string; targetVersion?: string }): Promise<string[]>;
  putLifecycleRequest(request: SourceLifecycleRequestV2): Promise<SourceEvidenceWriteResult>;
  getLifecycleRequest(requestId: string): Promise<SourceLifecycleRequestV2 | undefined>;
  restoreLifecycleRequest(requestId: string, restoredAt: string, receipt: SourceReceiptV2): Promise<"restored" | "unchanged" | "missing" | "purged">;
  setLifecycleLegalHold(requestId: string, enabled: boolean, actor: string, observedAt: string, receipt: SourceReceiptV2): Promise<"updated" | "unchanged" | "missing" | "purged">;
  purgeLifecycleRequest(requestId: string, purgedAt: string, receipt: SourceReceiptV2): Promise<"purged" | "held" | "too-early" | "unchanged" | "missing">;
}

export interface SourceRawAssetVerifier {
  readonly id: string;
  readonly version: string;
  verify(reference: RawAssetReferenceV2): Promise<{ ok: boolean; contentDigest: string; mediaType: string; size: number; evidenceDigest: string }>;
}

export interface SourceRawAssetStager {
  readonly id: string;
  readonly version: string;
  stage(input: {
    sourceId: string;
    providerObjectId: string;
    providerVersion: string;
    mediaType: RawAssetReferenceV2["mediaType"];
    bytes: Uint8Array;
  }): Promise<{ reference: RawAssetReferenceV2; payload?: Uint8Array }>;
}

export interface SourceExternalPrincipalResolution {
  status: "verified" | "unresolved" | "revoked";
  subjectKind?: "principal" | "group";
  subjectId?: string;
  evidenceDigest: string;
}

export interface SourceExternalPrincipalResolver {
  resolve(input: {
    mappingId: string;
    providerTenantId: string;
    externalPrincipalId: string;
    expectedKind: "principal" | "group";
  }): Promise<SourceExternalPrincipalResolution>;
}
