import type { JsonValue } from "../capabilities/contracts.ts";
import type { CompanyRecordsStore } from "../state-store/records.ts";
import type { RecordObjectVersion, RecordReconciliationReceipt, RecordSourceEvent } from "./contracts.ts";
import { projectionRecordId, recordDigest, recordVersionId } from "./identity.ts";
import { normalizeRecordObject } from "./normalize.ts";
import { projectRecord } from "./projection.ts";
import { CompanyRecordsRegistry } from "./registry.ts";

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
}): Promise<RecordReconciliationReceipt> {
  const { store, registry } = args;
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
  let inserted = 0;
  let unchanged = 0;
  let deleted = 0;
  let repairedProjections = 0;
  const observedIds = new Set<string>();
  const source = registry.source(args.sourceId);
  try {
    for (const raw of args.objects) {
      const version = normalizeRecordObject({ instanceId: args.instanceId, source, raw, observedAt: args.observedAt, receipt: { operation: "reconcile", run_id: args.runId } });
      observedIds.add(version.object_id);
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
      if (!await store.appendSourceEvent(event)) { unchanged += 1; continue; }
      if (await store.putObjectVersion(version)) inserted += 1;
      else unchanged += 1;
      for (const projection of registry.projectionsForRecordType(version.record_type)) {
        const row = projectRecord({ projection, version, projectedAt: args.observedAt });
        if (row) { await store.upsertProjectionRow(row); repairedProjections += 1; }
      }
    }

    for (const objectId of await store.listCurrentObjectIds(args.instanceId, args.sourceId)) {
      if (observedIds.has(objectId)) continue;
      const current = await store.getCurrentObjectVersion(args.instanceId, args.sourceId, objectId);
      if (!current || current.deleted) continue;
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
      await store.putObjectVersion(version);
      for (const projection of registry.projectionsForRecordType(current.record_type)) {
        await store.removeProjectionRow(args.instanceId, projection.id, projectionRecordId(projection.id, args.sourceId, objectId));
      }
      deleted += 1;
    }
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
