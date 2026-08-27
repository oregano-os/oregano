import { createHash } from "node:crypto";
import { sha256 } from "../runtime/canonical.ts";
import { assertNarrowingPolicy, QUARANTINE_POLICY, QUARANTINE_POLICY_ID } from "./access-control.ts";
import type { KnowledgeAccessPolicy } from "./contracts.ts";
import {
  SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
  validateSourceAccessSnapshotV2,
  validateSourceEnvelopeV2,
  validateSourceEventV2,
  validateSourceReceiptV2,
  type SourceAccessSnapshotV2,
  type SourceConnectorV2,
  type ExactSourceInputV2,
  type SourceEnvelopeV2,
  type SourceEventV2,
  type SourceReceiptOperationV2,
  type SourceReceiptV2,
  type SourceRequirementV2,
} from "./source-contracts-v2.ts";
import type {
  SourceExternalPrincipalResolver,
  SourceLifecycleRequestV2,
  SourceLifecycleTargetKind,
  SourcePipelineFailureClass,
  SourcePipelineStore,
  SourceRawAssetVerifier,
  SourceWatermarkV2,
} from "./source-pipeline-store.ts";
import { inspectSourceEnvelopeSanity } from "./source-sanity.ts";
import { sourceRetentionUntil } from "./source-contracts.ts";

const HOURS_72 = 72 * 60 * 60 * 1_000;

export async function ingestExactSourceInputV2(input: {
  exactInput: ExactSourceInputV2;
  requirement: SourceRequirementV2;
  connector: SourceConnectorV2;
  store: SourcePipelineStore;
  workerId: string;
  principalResolver?: SourceExternalPrincipalResolver;
  rawAssetVerifier?: SourceRawAssetVerifier;
  now?: () => string;
}): Promise<SourceEventProcessingResultV2> {
  if (!input.connector.stageExactInput) throw new Error(`Source Connector '${input.connector.descriptor.connectorId}' does not support exact input ingestion.`);
  const staged = await input.connector.stageExactInput(input.exactInput);
  const stagingReceipt = validateSourceReceiptV2(staged.receipt, {
    sourceId: input.requirement.sourceId,
    connectorId: input.connector.descriptor.connectorId,
    connectorVersion: input.connector.descriptor.connectorVersion,
  });
  await input.store.putReceipt(stagingReceipt);
  const result = await processSourceEventV2({
    event: staged.event,
    requirement: input.requirement,
    connector: input.connector,
    store: input.store,
    workerId: input.workerId,
    principalResolver: input.principalResolver,
    rawAssetVerifier: input.rawAssetVerifier,
    now: input.now,
  });
  return { ...result, receiptIds: [stagingReceipt.receiptId, ...result.receiptIds] };
}

export interface SourceEventProcessingResultV2 {
  eventId: string;
  sourceId: string;
  providerObjectId: string;
  outcome: "processed" | "quarantined" | "duplicate" | "busy" | "exhausted" | "failed";
  accessPolicyId?: string;
  rawEvidenceWrite?: "inserted" | "unchanged";
  changeId?: string;
  receiptIds: string[];
  sanityCodes: string[];
  failureClass?: SourcePipelineFailureClass;
  retryAfter?: string;
}

export interface SourceBatchProcessingResultV2 {
  sourceId: string;
  processed: number;
  quarantined: number;
  duplicate: number;
  failed: number;
  complete: boolean;
  watermarkAdvanced: boolean;
  results: SourceEventProcessingResultV2[];
}

const pipelineReceipt = (input: {
  connector: SourceConnectorV2;
  event: SourceEventV2;
  operation: SourceReceiptOperationV2;
  outcome: SourceReceiptV2["outcome"];
  observedAt: string;
  reasonCode: string;
  evidence: unknown;
}): SourceReceiptV2 => {
  const evidenceDigest = sha256(input.evidence);
  return {
    contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
    receiptId: sha256({
      sourceId: input.event.sourceId,
      eventId: input.event.eventId,
      operation: input.operation,
      outcome: input.outcome,
      observedAt: input.observedAt,
      reasonCode: input.reasonCode,
      evidenceDigest,
    }),
    sourceId: input.event.sourceId,
    connectorId: input.connector.descriptor.connectorId,
    connectorVersion: input.connector.descriptor.connectorVersion,
    operation: input.operation,
    outcome: input.outcome,
    observedAt: input.observedAt,
    evidenceDigest,
    deliveryId: input.event.deliveryId,
    providerObjectId: input.event.providerObjectId,
    ...(input.event.providerVersion ? { providerVersion: input.event.providerVersion } : {}),
    reasonCode: input.reasonCode,
  };
};

const lifecycleReceipt = (input: {
  sourceId: string;
  connectorId: string;
  connectorVersion: string;
  requestId: string;
  targetId: string;
  observedAt: string;
  reasonCode: string;
  outcome?: SourceReceiptV2["outcome"];
}): SourceReceiptV2 => {
  const evidenceDigest = sha256({ requestId: input.requestId, targetId: input.targetId, reasonCode: input.reasonCode });
  return {
    contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
    receiptId: sha256({ ...input, evidenceDigest }),
    sourceId: input.sourceId,
    connectorId: input.connectorId,
    connectorVersion: input.connectorVersion,
    operation: "lifecycle",
    outcome: input.outcome ?? "succeeded",
    observedAt: input.observedAt,
    evidenceDigest,
    providerObjectId: input.targetId,
    reasonCode: input.reasonCode,
  };
};

const classifyFailure = (error: unknown): SourcePipelineFailureClass => {
  const message = error instanceof Error ? error.message : String(error);
  if (/digest|size|media|encoding|identity|version|canonical|reused/i.test(message)) return "integrity-failure";
  if (/access|policy|principal|acl|quarantine/i.test(message)) return "policy-failure";
  if (/content|credential|prompt|repetition|empty/i.test(message)) return "content-failure";
  if (/asset|storage/i.test(message)) return "storage-failure";
  if (/unsupported|not implement/i.test(message)) return "unsupported";
  return "provider-failure";
};

const quarantinePolicy = async (store: SourcePipelineStore, evidenceDigest: string): Promise<string> => {
  await store.putPolicy(QUARANTINE_POLICY, evidenceDigest);
  return QUARANTINE_POLICY_ID;
};

async function resolveObjectPolicy(input: {
  requirement: SourceRequirementV2;
  envelope: Pick<SourceEnvelopeV2, "providerTenantId" | "providerObjectId">;
  access: SourceAccessSnapshotV2;
  store: SourcePipelineStore;
  principalResolver?: SourceExternalPrincipalResolver;
}): Promise<{ policyId: string; quarantined: boolean; codes: string[] }> {
  const { requirement, access, store } = input;
  if (requirement.access.mode === "quarantine") {
    return { policyId: await quarantinePolicy(store, access.evidenceDigest), quarantined: true, codes: ["source-profile-quarantine"] };
  }
  const rootPolicyId = requirement.access.mode === "fixed-policy" ? requirement.access.rootPolicyId : requirement.access.rootPolicyId;
  const rootPolicy = await store.getPolicy(rootPolicyId);
  if (!rootPolicy || rootPolicy.status !== "active" || !rootPolicy.sourceRoot) {
    return { policyId: await quarantinePolicy(store, access.evidenceDigest), quarantined: true, codes: ["source-root-policy-unavailable"] };
  }
  if (requirement.access.mode === "fixed-policy") return { policyId: rootPolicy.policyId, quarantined: false, codes: [] };
  if (!input.principalResolver) {
    return { policyId: await quarantinePolicy(store, access.evidenceDigest), quarantined: true, codes: ["acl-resolver-unavailable"] };
  }

  const externalEffects = new Map<string, Set<string>>();
  for (const external of access.entries) {
    const key = `${external.principalType}\0${external.externalPrincipalId}\0${external.role}`;
    const effects = externalEffects.get(key) ?? new Set<string>();
    effects.add(external.effect);
    externalEffects.set(key, effects);
  }
  if ([...externalEffects.values()].some((effects) => effects.size > 1)) {
    return { policyId: await quarantinePolicy(store, access.evidenceDigest), quarantined: true, codes: ["acl-conflicting-effects"] };
  }

  const entries: KnowledgeAccessPolicy["entries"] = [];
  const mappingEvidence: string[] = [];
  const codes: string[] = [];
  for (const external of access.entries) {
    const resolution = await input.principalResolver.resolve({
      mappingId: requirement.access.mappingId,
      providerTenantId: input.envelope.providerTenantId,
      externalPrincipalId: external.externalPrincipalId,
      expectedKind: external.principalType,
    });
    mappingEvidence.push(resolution.evidenceDigest);
    if (resolution.status !== "verified" || !resolution.subjectId || !resolution.subjectKind || resolution.subjectKind !== external.principalType) {
      codes.push(`acl-${resolution.status}`);
      continue;
    }
    entries.push({
      subjectKind: resolution.subjectKind,
      subjectId: resolution.subjectId,
      permission: "read",
      effect: external.effect,
    });
  }
  if (codes.length > 0 || entries.length === 0 || !entries.some((entry) => entry.effect === "allow")) {
    return { policyId: await quarantinePolicy(store, sha256({ access: access.evidenceDigest, mappingEvidence })), quarantined: true, codes: [...new Set(codes.length ? codes : ["acl-no-verified-reader"])].sort() };
  }
  const policyId = `policy:source:${requirement.sourceId}:${sha256({ providerObjectId: input.envelope.providerObjectId, providerAccessVersion: access.providerAccessVersion, entries }).slice(0, 32)}`;
  const policy: KnowledgeAccessPolicy = {
    policyId,
    policyVersion: 1,
    visibility: "private",
    parentPolicyId: rootPolicy.policyId,
    sourceRoot: false,
    status: "active",
    entries: entries.sort((left, right) => left.subjectKind.localeCompare(right.subjectKind) || left.subjectId.localeCompare(right.subjectId) || left.effect.localeCompare(right.effect)),
  };
  assertNarrowingPolicy(policy, rootPolicy);
  await store.putPolicy(policy, sha256({ access: access.evidenceDigest, mappingEvidence }));
  return { policyId, quarantined: false, codes: [] };
}

const changeInput = (input: {
  event: SourceEventV2;
  kind: "ingested" | "deleted" | "access-changed" | "quarantined";
  policyId: string;
  payloadDigest: string;
  receiptId: string;
  objectVersion?: string;
}) => ({
  changeId: sha256({ eventId: input.event.eventId, changeKind: input.kind, policyId: input.policyId, payloadDigest: input.payloadDigest }),
  sourceId: input.event.sourceId,
  objectKind: "source-object" as const,
  objectId: input.event.providerObjectId,
  ...(input.objectVersion ?? input.event.providerVersion ? { objectVersion: input.objectVersion ?? input.event.providerVersion } : {}),
  changeKind: input.kind,
  accessPolicyId: input.policyId,
  payloadDigest: input.payloadDigest,
  receiptId: input.receiptId,
  occurredAt: input.event.observedAt,
});

export async function processSourceEventV2(input: {
  event: SourceEventV2;
  requirement: SourceRequirementV2;
  connector: SourceConnectorV2;
  store: SourcePipelineStore;
  workerId: string;
  principalResolver?: SourceExternalPrincipalResolver;
  rawAssetVerifier?: SourceRawAssetVerifier;
  now?: () => string;
  maxAttempts?: number;
  leaseSeconds?: number;
}): Promise<SourceEventProcessingResultV2> {
  const event = validateSourceEventV2(input.event);
  if (event.sourceId !== input.requirement.sourceId || event.sourceId !== input.connector.sourceId) throw new Error("Source event, requirement, and Connector identities differ.");
  if (!input.connector.descriptor.sourceKinds.includes(input.requirement.sourceKind) || !input.connector.descriptor.deliveryModes.includes(input.requirement.deliveryMode)) throw new Error("Source Connector descriptor does not support the requirement profile.");
  await input.store.putEvent(event);
  const now = input.now?.() ?? new Date().toISOString();
  const leaseUntil = new Date(Date.parse(now) + Math.max(1, Math.min(input.leaseSeconds ?? 60, 3_600)) * 1_000).toISOString();
  const claim = await input.store.claimEvent({ eventId: event.eventId, workerId: input.workerId, leaseUntil, now, maxAttempts: Math.max(1, Math.min(input.maxAttempts ?? 3, 10)) });
  if (claim === "complete") return { eventId: event.eventId, sourceId: event.sourceId, providerObjectId: event.providerObjectId, outcome: "duplicate", receiptIds: [], sanityCodes: [] };
  if (claim === "busy" || claim === "exhausted") return { eventId: event.eventId, sourceId: event.sourceId, providerObjectId: event.providerObjectId, outcome: claim, receiptIds: [], sanityCodes: [] };

  const receiptIds: string[] = [];
  try {
    if (event.eventType === "deleted") {
      const current = await input.store.currentRawEvidence(event.sourceId, event.providerObjectId);
      const result = await input.store.markProviderDeleted({ sourceId: event.sourceId, providerObjectId: event.providerObjectId, observedAt: event.observedAt, eventId: event.eventId });
      const receipt = pipelineReceipt({ connector: input.connector, event, operation: "lifecycle", outcome: result === "missing" ? "skipped" : "succeeded", observedAt: now, reasonCode: `provider-delete-${result}`, evidence: { eventId: event.eventId, result } });
      await input.store.putReceipt(receipt); receiptIds.push(receipt.receiptId);
      const policyId = current?.envelope.accessPolicyId ?? QUARANTINE_POLICY_ID;
      const payloadDigest = current?.envelope.contentDigest ?? sha256({ sourceId: event.sourceId, providerObjectId: event.providerObjectId, missing: true });
      const change = await input.store.appendChange(changeInput({ event, kind: "deleted", policyId, payloadDigest, receiptId: receipt.receiptId }));
      await input.store.completeEvent(event.eventId, "processed", now);
      return { eventId: event.eventId, sourceId: event.sourceId, providerObjectId: event.providerObjectId, outcome: "processed", accessPolicyId: policyId, changeId: change.changeId, receiptIds, sanityCodes: [] };
    }

    if (event.eventType === "access-changed") {
      if (!input.connector.readAccess) throw new Error(`Source Connector '${input.connector.descriptor.connectorId}' does not implement readAccess for access-changed events.`);
      const fetched = await input.connector.readAccess(event);
      const access = validateSourceAccessSnapshotV2(fetched.access, { sourceId: event.sourceId, providerObjectId: event.providerObjectId });
      const providerReceipt = validateSourceReceiptV2(fetched.receipt, { sourceId: event.sourceId, connectorId: input.connector.descriptor.connectorId, connectorVersion: input.connector.descriptor.connectorVersion });
      await input.store.putReceipt(providerReceipt); receiptIds.push(providerReceipt.receiptId);
      await input.store.putAccessSnapshot(access);
      const current = await input.store.currentRawEvidence(event.sourceId, event.providerObjectId);
      if (!current) throw new Error(`Access change references unknown Source Object '${event.providerObjectId}'.`);
      const policy = await resolveObjectPolicy({ requirement: input.requirement, envelope: { providerTenantId: current.envelope.providerTenantId, providerObjectId: current.envelope.providerObjectId }, access, store: input.store, principalResolver: input.principalResolver });
      const result = await input.store.updateObjectAccess({ sourceId: event.sourceId, providerObjectId: event.providerObjectId, access, accessPolicyId: policy.policyId, observedAt: event.observedAt });
      const receipt = pipelineReceipt({ connector: input.connector, event, operation: "read-access", outcome: "succeeded", observedAt: now, reasonCode: policy.quarantined ? "access-quarantined" : `access-${result}`, evidence: { eventId: event.eventId, accessVersion: access.providerAccessVersion, policyId: policy.policyId, result } });
      await input.store.putReceipt(receipt); receiptIds.push(receipt.receiptId);
      const change = await input.store.appendChange(changeInput({ event, kind: policy.quarantined ? "quarantined" : "access-changed", policyId: policy.policyId, payloadDigest: current.envelope.contentDigest, receiptId: receipt.receiptId }));
      await input.store.completeEvent(event.eventId, policy.quarantined ? "quarantined" : "processed", now);
      return { eventId: event.eventId, sourceId: event.sourceId, providerObjectId: event.providerObjectId, outcome: policy.quarantined ? "quarantined" : "processed", accessPolicyId: policy.policyId, changeId: change.changeId, receiptIds, sanityCodes: policy.codes };
    }

    const fetched = await input.connector.fetch(event);
    const providerEnvelope = validateSourceEnvelopeV2(fetched.envelope, input.requirement);
    if (providerEnvelope.eventId !== event.eventId || providerEnvelope.providerObjectId !== event.providerObjectId || (event.providerVersion !== undefined && providerEnvelope.providerVersion !== event.providerVersion) || providerEnvelope.locator !== event.locator) throw new Error("Fetched Source envelope does not match its Source Event identity.");
    const access = validateSourceAccessSnapshotV2(fetched.access, { sourceId: event.sourceId, providerObjectId: event.providerObjectId });
    const providerReceipt = validateSourceReceiptV2(fetched.receipt, { sourceId: event.sourceId, connectorId: input.connector.descriptor.connectorId, connectorVersion: input.connector.descriptor.connectorVersion });
    await input.store.putReceipt(providerReceipt); receiptIds.push(providerReceipt.receiptId);
    await input.store.putAccessSnapshot(access);
    const policy = await resolveObjectPolicy({ requirement: input.requirement, envelope: providerEnvelope, access, store: input.store, principalResolver: input.principalResolver });
    const envelope: SourceEnvelopeV2 = { ...providerEnvelope, accessPolicyId: policy.policyId };
    const sanityEnvelope: SourceEnvelopeV2 = fetched.assetPayload && ["text/markdown", "text/plain", "text/html", "application/json"].includes(envelope.mediaType)
      ? { ...envelope, content: { inlineText: new TextDecoder("utf-8", { fatal: true }).decode(fetched.assetPayload) } }
      : envelope;
    const sanity = inspectSourceEnvelopeSanity(sanityEnvelope);
    const rejected = sanity.filter((finding) => finding.severity === "reject");
    if (rejected.length > 0) throw new Error(`Source content failed required integrity gates: ${rejected.map((entry) => entry.code).join(", ")}.`);
    const sanityCodes = [...policy.codes, ...sanity.map((finding) => finding.code)].sort();
    let quarantined = policy.quarantined || sanity.some((finding) => finding.severity === "quarantine");
    const rawAsset = "rawAsset" in envelope.content ? envelope.content.rawAsset : undefined;
    if (rawAsset && !fetched.assetPayload && !input.rawAssetVerifier) {
      quarantined = true;
      sanityCodes.push("raw-asset-verifier-unavailable");
    }
    const finalPolicyId = quarantined ? await quarantinePolicy(input.store, sha256({ policy: policy.policyId, sanityCodes })) : policy.policyId;

    if (rawAsset) {
      if (fetched.assetPayload) {
        const payloadDigest = createHash("sha256").update(fetched.assetPayload).digest("hex");
        if (fetched.assetPayload.byteLength !== envelope.size || payloadDigest !== envelope.contentDigest) throw new Error(`Raw Asset '${rawAsset.assetId}' staged payload failed integrity validation.`);
        await input.store.putRawAsset(rawAsset, {
          sourceId: envelope.sourceId,
          providerObjectId: envelope.providerObjectId,
          providerVersion: envelope.providerVersion,
          accessPolicyId: finalPolicyId,
          retentionClass: "durable",
        }, fetched.assetPayload);
      } else if (!input.rawAssetVerifier) {
        // The reference remains quarantined until a qualified adapter can verify it.
      } else {
        const verification = await input.rawAssetVerifier.verify(rawAsset);
        if (!verification.ok || verification.contentDigest !== envelope.contentDigest || verification.mediaType !== envelope.mediaType || verification.size !== envelope.size) throw new Error(`Raw Asset '${rawAsset.assetId}' failed adapter verification.`);
        await input.store.putRawAsset(rawAsset, {
          sourceId: envelope.sourceId,
          providerObjectId: envelope.providerObjectId,
          providerVersion: envelope.providerVersion,
          accessPolicyId: finalPolicyId,
          retentionClass: "durable",
        });
      }
    } else if (fetched.assetPayload) {
      throw new Error("Source Connector returned an Asset payload without a Raw Asset envelope reference.");
    }
    const finalEnvelope = { ...envelope, accessPolicyId: finalPolicyId };
    const { content, ...envelopeMetadata } = finalEnvelope;
    const rawEvidenceWrite = await input.store.putRawEvidence({
      envelope: envelopeMetadata,
      content,
      access,
      sanityCodes: [...new Set(sanityCodes)].sort(),
      modelReady: !quarantined,
      payloadState: "active",
      retentionUntil: sourceRetentionUntil(finalEnvelope.observedAt, input.requirement.retention),
      recordedAt: finalEnvelope.observedAt,
    });
    const receipt = pipelineReceipt({ connector: input.connector, event, operation: quarantined ? "quarantine" : "enqueue", outcome: "succeeded", observedAt: now, reasonCode: quarantined ? "raw-evidence-quarantined" : "raw-evidence-ready", evidence: { eventId: event.eventId, contentDigest: finalEnvelope.contentDigest, policyId: finalPolicyId, sanityCodes } });
    await input.store.putReceipt(receipt); receiptIds.push(receipt.receiptId);
    const change = await input.store.appendChange(changeInput({ event, kind: quarantined ? "quarantined" : "ingested", policyId: finalPolicyId, payloadDigest: finalEnvelope.contentDigest, receiptId: receipt.receiptId, objectVersion: finalEnvelope.providerVersion }));
    await input.store.completeEvent(event.eventId, quarantined ? "quarantined" : "processed", now);
    return { eventId: event.eventId, sourceId: event.sourceId, providerObjectId: event.providerObjectId, outcome: quarantined ? "quarantined" : "processed", accessPolicyId: finalPolicyId, rawEvidenceWrite, changeId: change.changeId, receiptIds, sanityCodes: [...new Set(sanityCodes)].sort() };
  } catch (error) {
    const failureClass = classifyFailure(error);
    const record = await input.store.getEvent(event.eventId);
    const attempt = record?.attempt ?? 1;
    const retryAfter = new Date(Date.parse(now) + Math.min(2 ** Math.max(0, attempt - 1), 60) * 1_000).toISOString();
    await input.store.failEvent(event.eventId, failureClass, retryAfter);
    const receipt = pipelineReceipt({ connector: input.connector, event, operation: "enqueue", outcome: "failed", observedAt: now, reasonCode: failureClass, evidence: { eventId: event.eventId, failureClass, attempt, errorDigest: sha256(error instanceof Error ? error.message : String(error)) } });
    await input.store.putReceipt(receipt); receiptIds.push(receipt.receiptId);
    return { eventId: event.eventId, sourceId: event.sourceId, providerObjectId: event.providerObjectId, outcome: "failed", receiptIds, sanityCodes: [], failureClass, retryAfter };
  }
}

export async function processSourceEventBatchV2(input: {
  events: readonly SourceEventV2[];
  requirement: SourceRequirementV2;
  connector: SourceConnectorV2;
  store: SourcePipelineStore;
  workerId: string;
  streamId: string;
  complete: boolean;
  cursor?: string;
  watermark?: string;
  principalResolver?: SourceExternalPrincipalResolver;
  rawAssetVerifier?: SourceRawAssetVerifier;
  now?: () => string;
}): Promise<SourceBatchProcessingResultV2> {
  const results: SourceEventProcessingResultV2[] = [];
  for (const event of input.events) results.push(await processSourceEventV2({ ...input, event }));
  const failed = results.filter((entry) => ["failed", "busy", "exhausted"].includes(entry.outcome)).length;
  let watermarkAdvanced = false;
  if (input.complete && failed === 0) {
    const updatedAt = input.now?.() ?? new Date().toISOString();
    const next: SourceWatermarkV2 = {
      sourceId: input.requirement.sourceId,
      streamId: input.streamId,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.watermark === undefined ? {} : { watermark: input.watermark }),
      completed: true,
      stateDigest: sha256({ sourceId: input.requirement.sourceId, streamId: input.streamId, cursor: input.cursor, watermark: input.watermark, completed: true, updatedAt }),
      updatedAt,
    };
    watermarkAdvanced = (await input.store.advanceWatermark(next)) === "advanced";
  }
  return {
    sourceId: input.requirement.sourceId,
    processed: results.filter((entry) => entry.outcome === "processed").length,
    quarantined: results.filter((entry) => entry.outcome === "quarantined").length,
    duplicate: results.filter((entry) => entry.outcome === "duplicate").length,
    failed,
    complete: input.complete && failed === 0,
    watermarkAdvanced,
    results,
  };
}

export async function requestSourceLifecycleDeletion(input: {
  store: SourcePipelineStore;
  sourceId: string;
  targetKind: SourceLifecycleTargetKind;
  targetId: string;
  targetVersion?: string;
  requestedBy: string;
  reason: string;
  accessPolicyId: string;
  connectorId: string;
  connectorVersion: string;
  requestedAt?: string;
}): Promise<SourceLifecycleRequestV2> {
  if (!input.requestedBy.trim() || !input.reason.trim()) throw new Error("Source lifecycle deletion requires an attributable requester and reason.");
  const requestedAt = input.requestedAt ?? new Date().toISOString();
  const dependencies = await input.store.previewDependencies(input);
  const requestId = sha256({ sourceId: input.sourceId, targetKind: input.targetKind, targetId: input.targetId, targetVersion: input.targetVersion, requestedBy: input.requestedBy, reason: input.reason, requestedAt });
  const receipt = lifecycleReceipt({ sourceId: input.sourceId, connectorId: input.connectorId, connectorVersion: input.connectorVersion, requestId, targetId: input.targetId, observedAt: requestedAt, reasonCode: "soft-delete-requested" });
  const request: SourceLifecycleRequestV2 = {
    requestId,
    sourceId: input.sourceId,
    targetKind: input.targetKind,
    targetId: input.targetId,
    ...(input.targetVersion ? { targetVersion: input.targetVersion } : {}),
    requestedBy: input.requestedBy,
    reason: input.reason,
    requestedAt,
    purgeAfter: new Date(Date.parse(requestedAt) + HOURS_72).toISOString(),
    dependencyIds: dependencies,
    accessPolicyId: input.accessPolicyId,
    status: "requested",
    legalHold: false,
    receiptId: receipt.receiptId,
  };
  await input.store.putReceipt(receipt);
  await input.store.putLifecycleRequest(request);
  return request;
}

export async function restoreSourceLifecycleDeletion(input: {
  store: SourcePipelineStore;
  requestId: string;
  connectorId: string;
  connectorVersion: string;
  restoredAt?: string;
}): Promise<"restored" | "unchanged" | "missing" | "purged"> {
  const request = await input.store.getLifecycleRequest(input.requestId);
  if (!request) return "missing";
  const restoredAt = input.restoredAt ?? new Date().toISOString();
  const receipt = lifecycleReceipt({ sourceId: request.sourceId, connectorId: input.connectorId, connectorVersion: input.connectorVersion, requestId: request.requestId, targetId: request.targetId, observedAt: restoredAt, reasonCode: "soft-delete-restored" });
  const result = await input.store.restoreLifecycleRequest(request.requestId, restoredAt, receipt);
  if (result === "restored") await input.store.appendChange({
    changeId: sha256({ requestId: request.requestId, changeKind: "restored", restoredAt }),
    sourceId: request.sourceId,
    objectKind: request.targetKind,
    objectId: request.targetId,
    ...(request.targetVersion ? { objectVersion: request.targetVersion } : {}),
    changeKind: "restored",
    accessPolicyId: request.accessPolicyId,
    payloadDigest: sha256({ requestId: request.requestId, restored: true }),
    receiptId: receipt.receiptId,
    occurredAt: restoredAt,
  });
  return result;
}

export async function setSourceLifecycleLegalHold(input: {
  store: SourcePipelineStore;
  requestId: string;
  enabled: boolean;
  actor: string;
  connectorId: string;
  connectorVersion: string;
  observedAt?: string;
}): Promise<"updated" | "unchanged" | "missing" | "purged"> {
  const request = await input.store.getLifecycleRequest(input.requestId);
  if (!request) return "missing";
  const observedAt = input.observedAt ?? new Date().toISOString();
  const receipt = lifecycleReceipt({ sourceId: request.sourceId, connectorId: input.connectorId, connectorVersion: input.connectorVersion, requestId: request.requestId, targetId: request.targetId, observedAt, reasonCode: input.enabled ? "legal-hold-enabled" : "legal-hold-released" });
  return input.store.setLifecycleLegalHold(request.requestId, input.enabled, input.actor, observedAt, receipt);
}

export async function purgeSourceLifecycleDeletion(input: {
  store: SourcePipelineStore;
  requestId: string;
  connectorId: string;
  connectorVersion: string;
  purgedAt?: string;
}): Promise<"purged" | "held" | "too-early" | "unchanged" | "missing"> {
  const request = await input.store.getLifecycleRequest(input.requestId);
  if (!request) return "missing";
  const purgedAt = input.purgedAt ?? new Date().toISOString();
  const receipt = lifecycleReceipt({ sourceId: request.sourceId, connectorId: input.connectorId, connectorVersion: input.connectorVersion, requestId: request.requestId, targetId: request.targetId, observedAt: purgedAt, reasonCode: "soft-delete-purged" });
  const result = await input.store.purgeLifecycleRequest(request.requestId, purgedAt, receipt);
  if (result === "purged") await input.store.appendChange({
    changeId: sha256({ requestId: request.requestId, changeKind: "purged", purgedAt }),
    sourceId: request.sourceId,
    objectKind: request.targetKind,
    objectId: request.targetId,
    ...(request.targetVersion ? { objectVersion: request.targetVersion } : {}),
    changeKind: "purged",
    accessPolicyId: request.accessPolicyId,
    payloadDigest: sha256({ requestId: request.requestId, purged: true }),
    receiptId: receipt.receiptId,
    occurredAt: purgedAt,
  });
  return result;
}
