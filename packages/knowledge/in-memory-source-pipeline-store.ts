import { canonicalJson, sha256 } from "../runtime/canonical.ts";
import type { KnowledgeAccessPolicy } from "./contracts.ts";
import type {
  RawAssetReferenceV2,
  SourceAccessSnapshotV2,
  SourceEnvelopeV2,
  SourceEventV2,
  SourceReceiptV2,
} from "./source-contracts-v2.ts";
import type {
  SourceChangeEntryV2,
  SourceEventInsertResult,
  SourceEventRecordV2,
  SourceEvidenceWriteResult,
  SourceLifecycleRequestV2,
  SourceLifecycleTargetKind,
  SourceInventoryObjectV2,
  SourcePipelineFailureClass,
  SourcePipelineStore,
  SourceRawEvidenceV2,
  SourceWatermarkV2,
} from "./source-pipeline-store.ts";

const clone = <T>(value: T): T => structuredClone(value);
const evidenceKey = (sourceId: string, objectId: string, version: string): string => `${sourceId}\0${objectId}\0${version}`;
const objectKey = (sourceId: string, objectId: string): string => `${sourceId}\0${objectId}`;
const accessKey = (snapshot: SourceAccessSnapshotV2): string => `${snapshot.sourceId}\0${snapshot.providerObjectId}\0${snapshot.providerAccessVersion}`;

export class InMemorySourcePipelineStore implements SourcePipelineStore {
  readonly events = new Map<string, SourceEventRecordV2>();
  readonly deliveries = new Map<string, string>();
  readonly policies = new Map<string, { policy: KnowledgeAccessPolicy; evidenceDigest: string }>();
  readonly accessSnapshots = new Map<string, SourceAccessSnapshotV2>();
  readonly rawEvidence = new Map<string, SourceRawEvidenceV2>();
  readonly inventory = new Map<string, { providerVersion: string; deletionState: "present" | "deleted"; observedAt: string }>();
  readonly currentAccess = new Map<string, { access: SourceAccessSnapshotV2; accessPolicyId: string }>();
  readonly rawAssets = new Map<string, RawAssetReferenceV2>();
  readonly rawAssetPayloads = new Map<string, Uint8Array>();
  readonly syncLeases = new Map<string, { owner: string; acquiredAt: string; leaseUntil: string }>();
  readonly rawAssetContexts = new Map<string, { sourceId: string; providerObjectId: string; providerVersion: string; accessPolicyId: string; retentionClass: "durable" | "session-temporary"; state: "active" | "deletion-requested" | "purged" }>();
  readonly receipts = new Map<string, SourceReceiptV2>();
  readonly changes: SourceChangeEntryV2[] = [];
  readonly watermarks = new Map<string, SourceWatermarkV2>();
  readonly lifecycleRequests = new Map<string, SourceLifecycleRequestV2>();

  async putEvent(event: SourceEventV2): Promise<SourceEventInsertResult> {
    const deliveryKey = `${event.sourceId}\0${event.deliveryId}`;
    const deliveryEventId = this.deliveries.get(deliveryKey);
    if (deliveryEventId && deliveryEventId !== event.eventId) throw new Error(`Source delivery '${event.deliveryId}' was reused with different canonical event content.`);
    const existing = this.events.get(event.eventId);
    if (existing) {
      if (canonicalJson(existing.event) !== canonicalJson(event)) throw new Error(`Source event '${event.eventId}' was reused with different content.`);
      return "unchanged";
    }
    this.events.set(event.eventId, { event: clone(event), status: "received", attempt: 0 });
    this.deliveries.set(deliveryKey, event.eventId);
    return "inserted";
  }

  async getEvent(eventId: string): Promise<SourceEventRecordV2 | undefined> {
    const record = this.events.get(eventId);
    return record ? clone(record) : undefined;
  }

  async claimEvent(input: { eventId: string; workerId: string; leaseUntil: string; now: string; maxAttempts: number }): Promise<"claimed" | "complete" | "busy" | "exhausted"> {
    const record = this.events.get(input.eventId);
    if (!record) throw new Error(`Unknown Source event '${input.eventId}'.`);
    if (["processed", "quarantined"].includes(record.status)) return "complete";
    if (record.status === "leased" && record.leaseUntil && Date.parse(record.leaseUntil) > Date.parse(input.now)) return "busy";
    if (record.retryAfter && Date.parse(record.retryAfter) > Date.parse(input.now)) return "busy";
    if (record.attempt >= input.maxAttempts) return "exhausted";
    record.status = "leased";
    record.attempt += 1;
    record.leaseOwner = input.workerId;
    record.leaseUntil = input.leaseUntil;
    record.failureClass = undefined;
    record.retryAfter = undefined;
    return "claimed";
  }

  async completeEvent(eventId: string, status: "processed" | "quarantined", completedAt: string): Promise<void> {
    const record = this.events.get(eventId);
    if (!record) throw new Error(`Unknown Source event '${eventId}'.`);
    record.status = status;
    record.completedAt = completedAt;
    record.leaseOwner = undefined;
    record.leaseUntil = undefined;
  }

  async failEvent(eventId: string, failureClass: SourcePipelineFailureClass, retryAfter: string): Promise<void> {
    const record = this.events.get(eventId);
    if (!record) throw new Error(`Unknown Source event '${eventId}'.`);
    record.status = "failed";
    record.failureClass = failureClass;
    record.retryAfter = retryAfter;
    record.leaseOwner = undefined;
    record.leaseUntil = undefined;
  }

  async putPolicy(policy: KnowledgeAccessPolicy, evidenceDigest: string): Promise<SourceEvidenceWriteResult> {
    const existing = this.policies.get(policy.policyId);
    if (existing) {
      if (canonicalJson(existing.policy) !== canonicalJson(policy)) throw new Error(`Source policy '${policy.policyId}' was reused with different content.`);
      return "unchanged";
    }
    this.policies.set(policy.policyId, { policy: clone(policy), evidenceDigest });
    return "inserted";
  }

  async getPolicy(policyId: string): Promise<KnowledgeAccessPolicy | undefined> {
    const value = this.policies.get(policyId)?.policy;
    return value ? clone(value) : undefined;
  }

  async putAccessSnapshot(snapshot: SourceAccessSnapshotV2): Promise<SourceEvidenceWriteResult> {
    const key = accessKey(snapshot);
    const existing = this.accessSnapshots.get(key);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(snapshot)) throw new Error(`Source ACL snapshot '${key}' was reused with different content.`);
      return "unchanged";
    }
    this.accessSnapshots.set(key, clone(snapshot));
    return "inserted";
  }

  async putRawEvidence(evidence: SourceRawEvidenceV2): Promise<SourceEvidenceWriteResult> {
    const key = evidenceKey(evidence.envelope.sourceId, evidence.envelope.providerObjectId, evidence.envelope.providerVersion);
    const existing = this.rawEvidence.get(key);
    if (existing) {
      if (existing.envelope.contentDigest !== evidence.envelope.contentDigest || canonicalJson(existing.content) !== canonicalJson(evidence.content)) throw new Error(`Source object '${evidence.envelope.providerObjectId}' reused provider version '${evidence.envelope.providerVersion}' with different evidence.`);
      this.inventory.set(objectKey(evidence.envelope.sourceId, evidence.envelope.providerObjectId), {
        providerVersion: evidence.envelope.providerVersion,
        deletionState: "present",
        observedAt: evidence.envelope.observedAt,
      });
      this.currentAccess.set(objectKey(evidence.envelope.sourceId, evidence.envelope.providerObjectId), {
        access: clone(evidence.access),
        accessPolicyId: evidence.envelope.accessPolicyId,
      });
      return "unchanged";
    }
    this.rawEvidence.set(key, clone(evidence));
    this.inventory.set(objectKey(evidence.envelope.sourceId, evidence.envelope.providerObjectId), {
      providerVersion: evidence.envelope.providerVersion,
      deletionState: "present",
      observedAt: evidence.envelope.observedAt,
    });
    this.currentAccess.set(objectKey(evidence.envelope.sourceId, evidence.envelope.providerObjectId), {
      access: clone(evidence.access),
      accessPolicyId: evidence.envelope.accessPolicyId,
    });
    return "inserted";
  }

  async getRawEvidence(sourceId: string, providerObjectId: string, providerVersion?: string): Promise<SourceRawEvidenceV2 | undefined> {
    const version = providerVersion ?? this.inventory.get(objectKey(sourceId, providerObjectId))?.providerVersion;
    if (!version) return undefined;
    const value = this.rawEvidence.get(evidenceKey(sourceId, providerObjectId, version));
    return value ? clone(value) : undefined;
  }

  async currentRawEvidence(sourceId: string, providerObjectId: string): Promise<SourceRawEvidenceV2 | undefined> {
    const inventory = this.inventory.get(objectKey(sourceId, providerObjectId));
    if (!inventory) return undefined;
    const value = this.rawEvidence.get(evidenceKey(sourceId, providerObjectId, inventory.providerVersion));
    if (!value) return undefined;
    const access = this.currentAccess.get(objectKey(sourceId, providerObjectId));
    return clone({
      ...value,
      envelope: { ...value.envelope, deletionState: inventory.deletionState, ...(access ? { accessPolicyId: access.accessPolicyId } : {}) },
      ...(access ? { access: access.access } : {}),
      modelReady: value.modelReady && inventory.deletionState === "present" && value.payloadState === "active" && Boolean(access) && access?.accessPolicyId !== "policy:quarantine",
    });
  }

  async listCurrentSourceObjects(sourceId: string): Promise<SourceInventoryObjectV2[]> {
    const prefix = `${sourceId}\0`;
    return [...this.inventory.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({
        providerObjectId: key.slice(prefix.length),
        providerVersion: value.providerVersion,
        deletionState: value.deletionState,
        observedAt: value.observedAt,
      }))
      .sort((left, right) => left.providerObjectId.localeCompare(right.providerObjectId))
      .map(clone);
  }

  async markProviderDeleted(input: { sourceId: string; providerObjectId: string; observedAt: string; eventId: string }): Promise<"deleted" | "unchanged" | "missing"> {
    const key = objectKey(input.sourceId, input.providerObjectId);
    const current = this.inventory.get(key);
    if (!current) return "missing";
    if (current.deletionState === "deleted") return "unchanged";
    current.deletionState = "deleted";
    current.observedAt = input.observedAt;
    return "deleted";
  }

  async updateObjectAccess(input: { sourceId: string; providerObjectId: string; access: SourceAccessSnapshotV2; accessPolicyId: string; observedAt: string }): Promise<"updated" | "unchanged" | "missing"> {
    const key = objectKey(input.sourceId, input.providerObjectId);
    if (!this.inventory.has(key)) return "missing";
    const current = this.currentAccess.get(key);
    const next = { access: clone(input.access), accessPolicyId: input.accessPolicyId };
    if (current && canonicalJson(current) === canonicalJson(next)) return "unchanged";
    this.currentAccess.set(key, next);
    return "updated";
  }

  async putRawAsset(reference: RawAssetReferenceV2, input: { sourceId: string; providerObjectId: string; providerVersion: string; accessPolicyId: string; retentionClass: "durable" | "session-temporary" }, payload?: Uint8Array): Promise<SourceEvidenceWriteResult> {
    const existing = this.rawAssets.get(reference.assetId);
    const nextContext = { ...input, state: "active" as const };
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(reference) || canonicalJson(this.rawAssetContexts.get(reference.assetId)) !== canonicalJson(nextContext)) throw new Error(`Raw Asset '${reference.assetId}' was reused with different content or context.`);
      return "unchanged";
    }
    this.rawAssets.set(reference.assetId, clone(reference));
    if (payload) this.rawAssetPayloads.set(reference.assetId, new Uint8Array(payload));
    this.rawAssetContexts.set(reference.assetId, nextContext);
    return "inserted";
  }

  async getRawAsset(assetId: string): Promise<RawAssetReferenceV2 | undefined> {
    if (this.rawAssetContexts.get(assetId)?.state === "purged") return undefined;
    const value = this.rawAssets.get(assetId);
    return value ? clone(value) : undefined;
  }

  async putReceipt(receipt: SourceReceiptV2): Promise<SourceEvidenceWriteResult> {
    const existing = this.receipts.get(receipt.receiptId);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(receipt)) throw new Error(`Source receipt '${receipt.receiptId}' was reused with different content.`);
      return "unchanged";
    }
    this.receipts.set(receipt.receiptId, clone(receipt));
    return "inserted";
  }

  async appendChange(entry: Omit<SourceChangeEntryV2, "sequence" | "previousDigest" | "chainDigest">): Promise<SourceChangeEntryV2> {
    const existing = this.changes.find((candidate) => candidate.changeId === entry.changeId);
    if (existing) {
      const comparable = (({ sequence: _sequence, previousDigest: _previousDigest, chainDigest: _chainDigest, ...rest }) => rest)(existing);
      if (canonicalJson(comparable) !== canonicalJson(entry)) throw new Error(`Source change '${entry.changeId}' was reused with different content.`);
      return clone(existing);
    }
    const previousDigest = this.changes.at(-1)?.chainDigest;
    const sequence = this.changes.length + 1;
    const chainDigest = sha256({ sequence, previousDigest, ...entry });
    const value: SourceChangeEntryV2 = { sequence, ...(previousDigest ? { previousDigest } : {}), chainDigest, ...clone(entry) };
    this.changes.push(value);
    return clone(value);
  }

  async listChanges(input: { afterSequence?: number; limit: number }): Promise<SourceChangeEntryV2[]> {
    return this.changes.filter((entry) => entry.sequence > (input.afterSequence ?? 0)).slice(0, Math.max(1, Math.min(input.limit, 1_000))).map(clone);
  }

  async getWatermark(sourceId: string, streamId: string): Promise<SourceWatermarkV2 | undefined> {
    const value = this.watermarks.get(`${sourceId}\0${streamId}`);
    return value ? clone(value) : undefined;
  }

  async advanceWatermark(watermark: SourceWatermarkV2): Promise<"advanced" | "unchanged"> {
    const key = `${watermark.sourceId}\0${watermark.streamId}`;
    const existing = this.watermarks.get(key);
    if (existing && canonicalJson(existing) === canonicalJson(watermark)) return "unchanged";
    if (existing && Date.parse(watermark.updatedAt) < Date.parse(existing.updatedAt)) throw new Error(`Source watermark '${watermark.streamId}' cannot move backward in time.`);
    if (watermark.stateDigest !== sha256({ sourceId: watermark.sourceId, streamId: watermark.streamId, cursor: watermark.cursor, watermark: watermark.watermark, completed: watermark.completed, updatedAt: watermark.updatedAt })) throw new Error(`Source watermark '${watermark.streamId}' has an invalid state digest.`);
    this.watermarks.set(key, clone(watermark));
    return "advanced";
  }

  async claimSyncLease(input: { sourceId: string; streamId: string; owner: string; acquiredAt: string; leaseUntil: string }): Promise<"claimed" | "busy"> {
    const key = `${input.sourceId}\0${input.streamId}`;
    const current = this.syncLeases.get(key);
    if (current && current.owner !== input.owner && Date.parse(current.leaseUntil) > Date.parse(input.acquiredAt)) return "busy";
    this.syncLeases.set(key, { owner: input.owner, acquiredAt: input.acquiredAt, leaseUntil: input.leaseUntil });
    return "claimed";
  }

  async releaseSyncLease(input: { sourceId: string; streamId: string; owner: string }): Promise<"released" | "unchanged"> {
    const key = `${input.sourceId}\0${input.streamId}`;
    if (this.syncLeases.get(key)?.owner !== input.owner) return "unchanged";
    this.syncLeases.delete(key);
    return "released";
  }

  async previewDependencies(input: { sourceId: string; targetKind: SourceLifecycleTargetKind; targetId: string; targetVersion?: string }): Promise<string[]> {
    if (input.targetKind === "raw-asset") {
      const context = this.rawAssetContexts.get(input.targetId);
      return context ? [`source-object:${context.sourceId}/${context.providerObjectId}@${context.providerVersion}`] : [];
    }
    const current = await this.getRawEvidence(input.sourceId, input.targetId, input.targetVersion);
    if (!current) return [];
    const dependencies = [`access-policy:${current.envelope.accessPolicyId}`];
    if (current.content && "rawAsset" in current.content && current.content.rawAsset) dependencies.push(`raw-asset:${current.content.rawAsset.assetId}`);
    return dependencies.sort();
  }

  async putLifecycleRequest(request: SourceLifecycleRequestV2): Promise<SourceEvidenceWriteResult> {
    const existing = this.lifecycleRequests.get(request.requestId);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(request)) throw new Error(`Source lifecycle request '${request.requestId}' was reused with different content.`);
      return "unchanged";
    }
    if (request.targetKind === "source-object") {
      const evidence = await this.getRawEvidence(request.sourceId, request.targetId, request.targetVersion);
      if (!evidence) throw new Error(`Unknown lifecycle Source Object '${request.targetId}'.`);
      evidence.payloadState = "deletion-requested";
      this.rawEvidence.set(evidenceKey(evidence.envelope.sourceId, evidence.envelope.providerObjectId, evidence.envelope.providerVersion), evidence);
    } else {
      const context = this.rawAssetContexts.get(request.targetId);
      if (!context) throw new Error(`Unknown lifecycle Raw Asset '${request.targetId}'.`);
      context.state = "deletion-requested";
    }
    this.lifecycleRequests.set(request.requestId, clone(request));
    return "inserted";
  }

  async getLifecycleRequest(requestId: string): Promise<SourceLifecycleRequestV2 | undefined> {
    const value = this.lifecycleRequests.get(requestId);
    return value ? clone(value) : undefined;
  }

  async restoreLifecycleRequest(requestId: string, restoredAt: string, receipt: SourceReceiptV2): Promise<"restored" | "unchanged" | "missing" | "purged"> {
    const request = this.lifecycleRequests.get(requestId);
    if (!request) return "missing";
    if (request.status === "purged") return "purged";
    if (request.status === "restored") return "unchanged";
    request.status = "restored";
    request.restoredAt = restoredAt;
    if (request.targetKind === "source-object") {
      const evidence = await this.getRawEvidence(request.sourceId, request.targetId, request.targetVersion);
      if (evidence && evidence.payloadState !== "purged") {
        evidence.payloadState = "active";
        this.rawEvidence.set(evidenceKey(evidence.envelope.sourceId, evidence.envelope.providerObjectId, evidence.envelope.providerVersion), evidence);
      }
    } else {
      const context = this.rawAssetContexts.get(request.targetId);
      if (context && context.state !== "purged") context.state = "active";
    }
    await this.putReceipt(receipt);
    return "restored";
  }

  async setLifecycleLegalHold(requestId: string, enabled: boolean, _actor: string, _observedAt: string, receipt: SourceReceiptV2): Promise<"updated" | "unchanged" | "missing" | "purged"> {
    const request = this.lifecycleRequests.get(requestId);
    if (!request) return "missing";
    if (request.status === "purged") return "purged";
    if (request.legalHold === enabled) return "unchanged";
    request.legalHold = enabled;
    request.status = enabled ? "held" : "requested";
    await this.putReceipt(receipt);
    return "updated";
  }

  async purgeLifecycleRequest(requestId: string, purgedAt: string, receipt: SourceReceiptV2): Promise<"purged" | "held" | "too-early" | "unchanged" | "missing"> {
    const request = this.lifecycleRequests.get(requestId);
    if (!request) return "missing";
    if (request.status === "purged") return "unchanged";
    if (request.status === "restored") return "unchanged";
    if (request.legalHold || request.status === "held") return "held";
    if (Date.parse(purgedAt) < Date.parse(request.purgeAfter)) return "too-early";
    if (request.targetKind === "source-object") {
      const evidence = await this.getRawEvidence(request.sourceId, request.targetId, request.targetVersion);
      if (evidence) {
        evidence.content = undefined;
        evidence.modelReady = false;
        evidence.payloadState = "purged";
        evidence.redactedAt = purgedAt;
        this.rawEvidence.set(evidenceKey(evidence.envelope.sourceId, evidence.envelope.providerObjectId, evidence.envelope.providerVersion), evidence);
      }
    } else {
      const context = this.rawAssetContexts.get(request.targetId);
      if (context) context.state = "purged";
      this.rawAssets.delete(request.targetId);
      this.rawAssetPayloads.delete(request.targetId);
    }
    request.status = "purged";
    request.purgedAt = purgedAt;
    await this.putReceipt(receipt);
    return "purged";
  }
}
