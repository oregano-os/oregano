import { sha256 } from "../runtime/canonical.ts";
import {
  SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
  createSourceEventV2,
  type SourceBindingV2,
  type SourceConnectorV2,
  type SourceEventV2,
  type SourceReceiptV2,
  type SourceRequirementV2,
} from "./source-contracts-v2.ts";
import { processSourceEventBatchV2, type SourceEventProcessingResultV2 } from "./source-ingestion-v2.ts";
import type { SourceExternalPrincipalResolver, SourcePipelineStore, SourceRawAssetVerifier, SourceWatermarkV2 } from "./source-pipeline-store.ts";

export interface SourcePullSyncResultV2 {
  sourceId: string;
  streamId: string;
  complete: boolean;
  watermarkAdvanced: boolean;
  enumerated: number;
  unchanged: number;
  deletionEvents: number;
  pages: number;
  results: SourceEventProcessingResultV2[];
  receiptIds: string[];
  completedWatermark?: string;
}

export interface SourceChangeSyncResultV2 {
  sourceId: string;
  streamId: string;
  complete: boolean;
  watermarkAdvanced: boolean;
  received: number;
  unchanged: number;
  pages: number;
  results: SourceEventProcessingResultV2[];
  receiptIds: string[];
  completedWatermark?: string;
}

const providerTenantId = (binding: SourceBindingV2): string => {
  if (binding.providerIdentity.kind === "repository") return `${binding.providerIdentity.accountId}/${binding.providerIdentity.repositoryId}`;
  if (binding.providerIdentity.kind === "workspace") return binding.providerIdentity.workspaceId;
  if (binding.providerIdentity.kind === "company-instance") return binding.providerIdentity.instanceId;
  return `local:${binding.sourceId}`;
};

const eventForObject = (input: {
  requirement: SourceRequirementV2;
  binding: SourceBindingV2;
  object: {
    providerObjectId: string;
    providerVersion: string;
    locator: string;
    accessVersion?: string;
  };
  eventType: "created" | "updated";
  observedAt: string;
  cursor?: string;
  watermark?: string;
}): SourceEventV2 => {
  const deliveryId = `pull:${sha256({
    sourceId: input.requirement.sourceId,
    providerObjectId: input.object.providerObjectId,
    providerVersion: input.object.providerVersion,
    observedAt: input.observedAt,
    cursor: input.cursor,
    watermark: input.watermark,
  })}`;
  return createSourceEventV2({
    deliveryId,
    sourceId: input.requirement.sourceId,
    providerTenantId: providerTenantId(input.binding),
    eventType: input.eventType,
    providerObjectId: input.object.providerObjectId,
    providerVersion: input.object.providerVersion,
    occurredAt: input.observedAt,
    observedAt: input.observedAt,
    locator: input.object.locator,
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.watermark ? { watermark: input.watermark } : {}),
    ...(input.object.accessVersion ? { accessVersion: input.object.accessVersion } : {}),
  });
};

const deletionEvent = (input: {
  requirement: SourceRequirementV2;
  binding: SourceBindingV2;
  providerObjectId: string;
  providerVersion: string;
  observedAt: string;
  watermark?: string;
}): SourceEventV2 => createSourceEventV2({
  deliveryId: `pull:${sha256({
    sourceId: input.requirement.sourceId,
    providerObjectId: input.providerObjectId,
    providerVersion: input.providerVersion,
    deletedAtWatermark: input.watermark,
  })}`,
  sourceId: input.requirement.sourceId,
  providerTenantId: providerTenantId(input.binding),
  eventType: "deleted",
  providerObjectId: input.providerObjectId,
  providerVersion: input.providerVersion,
  occurredAt: input.observedAt,
  observedAt: input.observedAt,
  locator: input.providerObjectId,
  ...(input.watermark ? { watermark: input.watermark } : {}),
});

const checkpoint = async (input: {
  store: SourcePipelineStore;
  sourceId: string;
  streamId: string;
  cursor?: string;
  watermark?: string;
  completed: boolean;
  updatedAt: string;
}): Promise<boolean> => {
  const value: SourceWatermarkV2 = {
    sourceId: input.sourceId,
    streamId: input.streamId,
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.watermark ? { watermark: input.watermark } : {}),
    completed: input.completed,
    stateDigest: sha256({
      sourceId: input.sourceId,
      streamId: input.streamId,
      cursor: input.cursor,
      watermark: input.watermark,
      completed: input.completed,
      updatedAt: input.updatedAt,
    }),
    updatedAt: input.updatedAt,
  };
  return (await input.store.advanceWatermark(value)) === "advanced";
};

const reconcileReceipt = (input: {
  connector: SourceConnectorV2;
  observedAt: string;
  watermark?: string;
  presentCount: number;
  deletionCount: number;
}): SourceReceiptV2 => {
  const evidenceDigest = sha256({
    watermark: input.watermark,
    presentCount: input.presentCount,
    deletionCount: input.deletionCount,
    inventoryComplete: true,
  });
  const value = {
    contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
    sourceId: input.connector.sourceId,
    connectorId: input.connector.descriptor.connectorId,
    connectorVersion: input.connector.descriptor.connectorVersion,
    operation: "reconcile" as const,
    outcome: "succeeded" as const,
    observedAt: input.observedAt,
    evidenceDigest,
    ...(input.watermark ? { cursorDigest: sha256(input.watermark) } : {}),
    reasonCode: "complete-inventory",
  };
  return { ...value, receiptId: sha256(value) };
};

export async function syncPullSourceV2(input: {
  requirement: SourceRequirementV2;
  binding: SourceBindingV2;
  connector: SourceConnectorV2;
  store: SourcePipelineStore;
  workerId: string;
  pageSize?: number;
  streamId?: string;
  principalResolver?: SourceExternalPrincipalResolver;
  rawAssetVerifier?: SourceRawAssetVerifier;
  now?: () => string;
}): Promise<SourcePullSyncResultV2> {
  if (input.requirement.deliveryMode !== "pull" || !input.connector.enumerate) throw new Error("Source pull synchronization requires an enumerable pull Connector.");
  if (input.requirement.sourceId !== input.binding.sourceId || input.requirement.sourceId !== input.connector.sourceId) throw new Error("Source pull synchronization identities differ.");
  const streamId = input.streamId ?? "pull-inventory";
  const receiptIds: string[] = [];
  const results: SourceEventProcessingResultV2[] = [];
  const presentObjectIds = new Set<string>();
  let enumerated = 0;
  let unchanged = 0;
  let pages = 0;
  let cursor: string | undefined;
  let completedWatermark: string | undefined;
  let finalObservedAt: string | undefined;

  const verification = await input.connector.verify();
  if (!verification.ok) throw new Error(`Source Connector '${input.connector.descriptor.connectorId}' failed verification.`);
  await input.store.putReceipt(verification.receipt);
  receiptIds.push(verification.receipt.receiptId);

  for (;;) {
    pages += 1;
    if (pages > 100_000) throw new Error("Source inventory exceeded the bounded page limit.");
    const page = await input.connector.enumerate({ ...(cursor ? { cursor } : {}), pageSize: Math.max(1, Math.min(input.pageSize ?? 100, 1_000)) });
    await input.store.putReceipt(page.receipt);
    receiptIds.push(page.receipt.receiptId);
    finalObservedAt = page.receipt.observedAt;
    completedWatermark = page.completedWatermark ?? completedWatermark;
    enumerated += page.objects.length;
    const pageEvents: SourceEventV2[] = [];
    for (const object of page.objects) {
      if (object.sourceId !== input.requirement.sourceId) throw new Error("Enumerated Source Object has a mismatched Source identity.");
      if (presentObjectIds.has(object.providerObjectId)) throw new Error(`Complete Source inventory contains duplicate object '${object.providerObjectId}'.`);
      presentObjectIds.add(object.providerObjectId);
      const current = await input.store.currentRawEvidence(input.requirement.sourceId, object.providerObjectId);
      if (current?.envelope.providerVersion === object.providerVersion && current.envelope.deletionState === "present") {
        unchanged += 1;
        continue;
      }
      pageEvents.push(eventForObject({
        requirement: input.requirement,
        binding: input.binding,
        object,
        eventType: current ? "updated" : "created",
        observedAt: page.receipt.observedAt,
        cursor,
        watermark: page.completedWatermark,
      }));
    }
    const batch = await processSourceEventBatchV2({
      events: pageEvents,
      requirement: input.requirement,
      connector: input.connector,
      store: input.store,
      workerId: input.workerId,
      streamId,
      complete: false,
      cursor: page.nextCursor,
      watermark: page.completedWatermark,
      principalResolver: input.principalResolver,
      rawAssetVerifier: input.rawAssetVerifier,
      now: input.now,
    });
    results.push(...batch.results);
    if (batch.failed > 0) return {
      sourceId: input.requirement.sourceId,
      streamId,
      complete: false,
      watermarkAdvanced: false,
      enumerated,
      unchanged,
      deletionEvents: 0,
      pages,
      results,
      receiptIds,
      ...(completedWatermark ? { completedWatermark } : {}),
    };
    if (!page.complete) {
      if (!page.nextCursor) throw new Error("Incomplete Source inventory page has no continuation cursor.");
      await checkpoint({
        store: input.store,
        sourceId: input.requirement.sourceId,
        streamId,
        cursor: page.nextCursor,
        watermark: page.completedWatermark,
        completed: false,
        updatedAt: page.receipt.observedAt,
      });
      cursor = page.nextCursor;
      continue;
    }
    if (page.nextCursor) throw new Error("Complete Source inventory page must not expose a continuation cursor.");
    break;
  }

  if (!finalObservedAt) throw new Error("Source inventory completed without observation evidence.");
  const inventory = await input.store.listCurrentSourceObjects(input.requirement.sourceId);
  const deletionEvents = inventory
    .filter((entry) => entry.deletionState === "present" && !presentObjectIds.has(entry.providerObjectId))
    .map((entry) => deletionEvent({
      requirement: input.requirement,
      binding: input.binding,
      providerObjectId: entry.providerObjectId,
      providerVersion: entry.providerVersion,
      observedAt: finalObservedAt!,
      watermark: completedWatermark,
    }));
  const finalBatch = await processSourceEventBatchV2({
    events: deletionEvents,
    requirement: input.requirement,
    connector: input.connector,
    store: input.store,
    workerId: input.workerId,
    streamId,
    complete: true,
    watermark: completedWatermark,
    principalResolver: input.principalResolver,
    rawAssetVerifier: input.rawAssetVerifier,
    now: input.now,
  });
  results.push(...finalBatch.results);
  if (finalBatch.complete) {
    const receipt = reconcileReceipt({
      connector: input.connector,
      observedAt: finalObservedAt,
      watermark: completedWatermark,
      presentCount: presentObjectIds.size,
      deletionCount: deletionEvents.length,
    });
    await input.store.putReceipt(receipt);
    receiptIds.push(receipt.receiptId);
  }
  return {
    sourceId: input.requirement.sourceId,
    streamId,
    complete: finalBatch.complete,
    watermarkAdvanced: finalBatch.watermarkAdvanced,
    enumerated,
    unchanged,
    deletionEvents: deletionEvents.length,
    pages,
    results,
    receiptIds,
    ...(completedWatermark ? { completedWatermark } : {}),
  };
}

export async function acceptSourceWebhookV2(input: {
  connector: SourceConnectorV2;
  store: SourcePipelineStore;
  rawBody: Uint8Array;
  headers: Readonly<Record<string, string>>;
  observedAt: string;
}): Promise<{ accepted: number; duplicate: number; eventIds: string[]; receiptId: string }> {
  if (!input.connector.acceptWebhook) throw new Error(`Source Connector '${input.connector.descriptor.connectorId}' does not accept webhooks.`);
  const accepted = await input.connector.acceptWebhook({ rawBody: input.rawBody, headers: input.headers, observedAt: input.observedAt });
  await input.store.putReceipt(accepted.receipt);
  let inserted = 0;
  let duplicate = 0;
  for (const event of accepted.events) {
    if (event.sourceId !== input.connector.sourceId) throw new Error("Webhook Source Event identity does not match its Connector.");
    const result = await input.store.putEvent(event);
    if (result === "inserted") inserted += 1;
    else duplicate += 1;
  }
  return { accepted: inserted, duplicate, eventIds: accepted.events.map((entry) => entry.eventId), receiptId: accepted.receipt.receiptId };
}

export async function syncChangedSourceV2(input: {
  requirement: SourceRequirementV2;
  connector: SourceConnectorV2;
  store: SourcePipelineStore;
  workerId: string;
  pageSize?: number;
  maxPages?: number;
  streamId?: string;
  overlapSeconds?: number;
  overlapFrom?: string;
  principalResolver?: SourceExternalPrincipalResolver;
  rawAssetVerifier?: SourceRawAssetVerifier;
  now?: () => string;
}): Promise<SourceChangeSyncResultV2> {
  if (!["hybrid", "pull"].includes(input.requirement.deliveryMode) || !input.connector.readChanges) throw new Error("Source change synchronization requires a change-readable pull or hybrid Connector.");
  if (input.requirement.sourceId !== input.connector.sourceId) throw new Error("Source change synchronization identities differ.");
  const streamId = input.streamId ?? "hybrid-changes";
  const prior = await input.store.getWatermark(input.requirement.sourceId, streamId);
  const overlapSeconds = Math.max(0, Math.min(input.overlapSeconds ?? 86_400, 7 * 86_400));
  const overlapFrom = input.overlapFrom
    ?? (prior?.watermark
      ? new Date(Date.parse(prior.watermark) - overlapSeconds * 1_000).toISOString()
      : "1970-01-01T00:00:00.000Z");
  const results: SourceEventProcessingResultV2[] = [];
  const receiptIds: string[] = [];
  let received = 0;
  let unchanged = 0;
  let pages = 0;
  let cursor: string | undefined = prior?.completed === false ? prior.cursor : undefined;
  let completedWatermark: string | undefined = prior?.watermark;
  let watermarkAdvanced = false;

  const verification = await input.connector.verify();
  if (!verification.ok) throw new Error(`Source Connector '${input.connector.descriptor.connectorId}' failed verification.`);
  await input.store.putReceipt(verification.receipt);
  receiptIds.push(verification.receipt.receiptId);

  for (;;) {
    pages += 1;
    if (pages > 100_000) throw new Error("Source change reconciliation exceeded the bounded page limit.");
    const page = await input.connector.readChanges({
      ...(cursor ? { cursor } : {}),
      pageSize: Math.max(1, Math.min(input.pageSize ?? 30, 30)),
      ...(cursor ? {} : { overlapFrom }),
    });
    await input.store.putReceipt(page.receipt);
    receiptIds.push(page.receipt.receiptId);
    received += page.events.length;
    completedWatermark = page.completedWatermark ?? completedWatermark;
    const pending: SourceEventV2[] = [];
    for (const event of page.events) {
      if (event.sourceId !== input.requirement.sourceId) throw new Error("Change page contains an event for another Source.");
      const current = await input.store.currentRawEvidence(event.sourceId, event.providerObjectId);
      if (event.providerVersion && current?.envelope.providerVersion === event.providerVersion && current.envelope.deletionState === "present") {
        unchanged += 1;
        continue;
      }
      pending.push(event);
    }
    const batch = await processSourceEventBatchV2({
      events: pending,
      requirement: input.requirement,
      connector: input.connector,
      store: input.store,
      workerId: input.workerId,
      streamId,
      complete: page.complete,
      cursor: page.nextCursor,
      watermark: page.completedWatermark,
      principalResolver: input.principalResolver,
      rawAssetVerifier: input.rawAssetVerifier,
      now: input.now,
    });
    results.push(...batch.results);
    watermarkAdvanced ||= batch.watermarkAdvanced;
    if (batch.failed > 0) return {
      sourceId: input.requirement.sourceId,
      streamId,
      complete: false,
      watermarkAdvanced: false,
      received,
      unchanged,
      pages,
      results,
      receiptIds,
      ...(completedWatermark ? { completedWatermark } : {}),
    };
    if (page.complete) {
      if (page.nextCursor) throw new Error("Complete Source change page must not expose a continuation cursor.");
      return {
        sourceId: input.requirement.sourceId,
        streamId,
        complete: true,
        watermarkAdvanced,
        received,
        unchanged,
        pages,
        results,
        receiptIds,
        ...(completedWatermark ? { completedWatermark } : {}),
      };
    }
    if (!page.nextCursor) throw new Error("Incomplete Source change page has no continuation cursor.");
    await checkpoint({
      store: input.store,
      sourceId: input.requirement.sourceId,
      streamId,
      cursor: page.nextCursor,
      watermark: page.completedWatermark,
      completed: false,
      updatedAt: page.receipt.observedAt,
    });
    if (pages >= Math.max(1, Math.min(input.maxPages ?? 100_000, 100_000))) {
      return {
        sourceId: input.requirement.sourceId,
        streamId,
        complete: false,
        watermarkAdvanced: false,
        received,
        unchanged,
        pages,
        results,
        receiptIds,
        ...(completedWatermark ? { completedWatermark } : {}),
      };
    }
    cursor = page.nextCursor;
  }
}
