import type { JsonValue } from "../capabilities/contracts.ts";
import type { CompanyRecordsStore } from "../state-store/records.ts";
import type { RecordObjectVersion, RecordReconciliationReceipt, RecordSourceEvent } from "./contracts.ts";
import { projectionRecordId, recordDigest, recordVersionId } from "./identity.ts";
import { normalizeRecordObject } from "./normalize.ts";
import { projectRecord } from "./projection.ts";
import { CompanyRecordsRegistry } from "./registry.ts";
import {
  DEFAULT_RECORD_SNAPSHOT_CONCURRENCY,
  mapRecordSnapshotWithBoundedConcurrency,
} from "./synchronization.ts";

/** Reconcile a complete provider snapshot under one durable lease. */
export async function reconcileRecordSnapshot(args: {
  instanceId: string;
  sourceId: string;
  runId: string;
  leaseOwner: string;
  leaseToken: string;
  observedAt: string;
  leaseExpiresAt: string;
  objects: Array<Record<string, JsonValue>>;
  watermark?: string;
  registry: CompanyRecordsRegistry;
  store: CompanyRecordsStore;
  concurrency?: number;
}): Promise<RecordReconciliationReceipt> {
  const { store, registry } = args;
  const concurrency = args.concurrency ?? DEFAULT_RECORD_SNAPSHOT_CONCURRENCY;
  const claimed = await store.claimSyncLease({
    instanceId: args.instanceId,
    sourceId: args.sourceId,
    owner: args.leaseOwner,
    token: args.leaseToken,
    now: args.observedAt,
    expiresAt: args.leaseExpiresAt,
  });
  if (!claimed) throw new Error(`Record source '${args.sourceId}' already has an active synchronization lease`);

  const startedAt = args.observedAt;
  const source = registry.source(args.sourceId);
  try {
    const versions = args.objects.map((raw) => normalizeRecordObject({
      instanceId: args.instanceId,
      source,
      raw,
      observedAt: args.observedAt,
      receipt: { operation: "reconcile", run_id: args.runId },
    }));
    const observedIds = new Set(versions.map((version) => version.object_id));
    const outcomes = await mapRecordSnapshotWithBoundedConcurrency(versions, concurrency, async (version) => {
      const event: RecordSourceEvent = {
        instance_id: args.instanceId,
        source_id: args.sourceId,
        event_id: `reconcile:${args.runId}:${version.object_id}:${version.digest}`,
        object_id: version.object_id,
        kind: "reconcile",
        observed_at: args.observedAt,
        ...(args.watermark ? { cursor: args.watermark } : {}),
        receipt: { operation: "reconcile", run_id: args.runId },
      };
      await store.appendSourceEvent(event);
      const inserted = await store.putObjectVersion(version);
      let repairedProjections = 0;
      for (const projection of registry.projectionsForRecordType(version.record_type)) {
        const row = projectRecord({ projection, version, projectedAt: args.observedAt });
        const applied = await store.applyProjectionMutationIfCurrent({
          instanceId: args.instanceId,
          sourceId: args.sourceId,
          objectId: version.object_id,
          expectedVersionId: version.version_id,
          projectionId: projection.id,
          recordId: projectionRecordId(projection.id, args.sourceId, version.object_id),
          ...(row ? { row } : {}),
        });
        if (applied) repairedProjections += 1;
      }
      return { inserted: inserted ? 1 : 0, unchanged: inserted ? 0 : 1, repairedProjections };
    });

    const currentObjectIds = await store.listCurrentObjectIds(args.instanceId, args.sourceId);
    const missingObjectIds = currentObjectIds.filter((objectId) => !observedIds.has(objectId));
    const deletionOutcomes = await mapRecordSnapshotWithBoundedConcurrency(missingObjectIds, concurrency, async (objectId) => {
      const current = await store.getCurrentObjectVersion(args.instanceId, args.sourceId, objectId);
      if (!current) return { deleted: 0, repairedProjections: 0 };
      if (current.deleted) {
        let repairedProjections = 0;
        for (const projection of registry.projectionsForRecordType(current.record_type)) {
          const applied = await store.applyProjectionMutationIfCurrent({
            instanceId: args.instanceId,
            sourceId: args.sourceId,
            objectId,
            expectedVersionId: current.version_id,
            projectionId: projection.id,
            recordId: projectionRecordId(projection.id, args.sourceId, objectId),
          });
          if (applied) repairedProjections += 1;
        }
        return { deleted: 0, repairedProjections };
      }
      const digest = recordDigest({ deleted: true, values: {} });
      const version: RecordObjectVersion = {
        ...current,
        version_id: recordVersionId(args.sourceId, objectId, digest),
        digest,
        observed_at: args.observedAt,
        deleted: true,
        values: {},
        source_receipt: { operation: "reconcile-delete", run_id: args.runId },
      };
      await store.appendSourceEvent({
        instance_id: args.instanceId, source_id: args.sourceId,
        event_id: `reconcile:${args.runId}:${objectId}:deleted`, object_id: objectId,
        kind: "deleted", observed_at: args.observedAt, receipt: { operation: "reconcile-delete", run_id: args.runId },
      });
      const inserted = await store.putObjectVersion(version);
      let repairedProjections = 0;
      for (const projection of registry.projectionsForRecordType(current.record_type)) {
        const applied = await store.applyProjectionMutationIfCurrent({
          instanceId: args.instanceId,
          sourceId: args.sourceId,
          objectId,
          expectedVersionId: version.version_id,
          projectionId: projection.id,
          recordId: projectionRecordId(projection.id, args.sourceId, objectId),
        });
        if (applied) repairedProjections += 1;
      }
      return { deleted: inserted ? 1 : 0, repairedProjections };
    });
    const inserted = outcomes.reduce((total, outcome) => total + outcome.inserted, 0);
    const unchanged = outcomes.reduce((total, outcome) => total + outcome.unchanged, 0);
    const deleted = deletionOutcomes.reduce((total, outcome) => total + outcome.deleted, 0);
    const repairedProjections = [...outcomes, ...deletionOutcomes]
      .reduce((total, outcome) => total + outcome.repairedProjections, 0);
    if (args.watermark) await store.setWatermark(args.instanceId, args.sourceId, args.watermark, args.observedAt);
    const receipt: RecordReconciliationReceipt = {
      instance_id: args.instanceId,
      source_id: args.sourceId,
      run_id: args.runId,
      started_at: startedAt,
      completed_at: args.observedAt,
      ...(args.watermark ? { watermark: args.watermark } : {}),
      observed: args.objects.length,
      inserted,
      unchanged,
      deleted,
      errors: 0,
      missing_from_provider: deleted,
      repaired_projections: repairedProjections,
    };
    await store.appendSyncReceipt(receipt);
    return receipt;
  } finally {
    await store.releaseSyncLease({ instanceId: args.instanceId, sourceId: args.sourceId, token: args.leaseToken });
  }
}
