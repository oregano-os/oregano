import type { JsonValue } from "../capabilities/contracts.ts";
import type { CompanyRecordsStore } from "../state-store/records.ts";
import type { CompanyRecordSourceDeclaration } from "./contracts.ts";
import { projectionRecordId } from "./identity.ts";
import { normalizeRecordObject } from "./normalize.ts";
import { projectRecord } from "./projection.ts";
import type { CompanyRecordsRegistry } from "./registry.ts";
import { CompanyRecordsService } from "./service.ts";
import type { RecordSourceInventory } from "./source-connector.ts";
import { sha256 } from "../runtime/canonical.ts";
import { recordQueryInstant } from "./query.ts";

export const DEFAULT_RECORD_SNAPSHOT_CONCURRENCY = 8;
export const MAX_RECORD_SNAPSHOT_CONCURRENCY = 32;

export async function mapRecordSnapshotWithBoundedConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_RECORD_SNAPSHOT_CONCURRENCY) {
    throw new Error(`Record snapshot concurrency must be between 1 and ${MAX_RECORD_SNAPSHOT_CONCURRENCY}`);
  }
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length && failure === undefined) {
      const index = nextIndex++;
      try {
        results[index] = await operation(values[index]!, index);
      } catch (error) {
        failure ??= error;
      }
    }
  });
  await Promise.all(workers);
  if (failure !== undefined) throw failure;
  return results;
}

/** Append one complete source inventory without inferring deletion from absence. */
export async function synchronizeRecordSnapshot(args: {
  instanceId: string;
  source: CompanyRecordSourceDeclaration;
  inventory: RecordSourceInventory;
  registry: CompanyRecordsRegistry;
  store: CompanyRecordsStore;
  runId: string;
  leaseOwner: string;
  leaseToken: string;
  leaseExpiresAt: string;
  concurrency?: number;
}) {
  const { instanceId, source, inventory, registry, store, runId, leaseOwner, leaseToken, leaseExpiresAt } = args;
  if (inventory.complete !== true) throw new Error("A partial inventory cannot be synchronized as complete");
  if (sha256(source) !== sha256(registry.source(source.id))) throw new Error("Synchronization source differs from its registered declaration");
  const observedAt = recordQueryInstant(inventory.observed_at, "Inventory observation");
  if (inventory.synced_through !== undefined && recordQueryInstant(inventory.synced_through, "Source completeness") > observedAt) {
    throw new Error("Source completeness must be an instant no later than the inventory observation");
  }
  const concurrency = args.concurrency ?? DEFAULT_RECORD_SNAPSHOT_CONCURRENCY;
  const claimed = await store.claimSyncLease({
    instanceId,
    sourceId: source.id,
    owner: leaseOwner,
    token: leaseToken,
    now: inventory.observed_at,
    expiresAt: leaseExpiresAt,
  });
  if (!claimed) throw new Error(`Record source '${source.id}' already has an active synchronization lease`);
  const service = new CompanyRecordsService({ instanceId, registry, store, now: () => new Date(inventory.observed_at) });
  try {
    const outcomes = await mapRecordSnapshotWithBoundedConcurrency(inventory.objects, concurrency, async (raw) => {
      const receipt: Record<string, JsonValue> = { operation: "sync", run_id: runId, inventory_digest: inventory.receipt.inventory_digest ?? "unavailable" };
      const normalized = normalizeRecordObject({ instanceId, source, raw, observedAt: inventory.observed_at, receipt });
      const current = await store.getCurrentObjectVersion(instanceId, source.id, normalized.object_id);
      const ingested = await service.ingest({
        event: {
          source_id: source.id,
          event_id: `sync:${runId}:${normalized.object_id}:${normalized.digest}`,
          object_id: normalized.object_id,
          kind: current ? "updated" : "created",
          observed_at: inventory.observed_at,
          receipt,
        },
        raw,
        receipt,
      });
      if (ingested.duplicate) {
        await store.putObjectVersion(normalized);
        for (const projection of registry.projectionsForRecordType(normalized.record_type)) {
          const row = projectRecord({ projection, version: normalized, projectedAt: inventory.observed_at });
          await store.applyProjectionMutationIfCurrent({
            instanceId,
            sourceId: normalized.source_id,
            objectId: normalized.object_id,
            expectedVersionId: normalized.version_id,
            projectionId: projection.id,
            recordId: projectionRecordId(projection.id, normalized.source_id, normalized.object_id),
            ...(row ? { row } : {}),
          });
        }
      }
      return current?.digest === normalized.digest ? "unchanged" as const : "inserted" as const;
    });
    const inserted = outcomes.filter((outcome) => outcome === "inserted").length;
    const unchanged = outcomes.length - inserted;
    await store.setWatermark(instanceId, source.id, inventory.watermark, inventory.observed_at);
    const receipt = {
      instance_id: instanceId,
      source_id: source.id,
      run_id: runId,
      started_at: inventory.observed_at,
      completed_at: inventory.observed_at,
      watermark: inventory.watermark,
      ...(inventory.synced_through ? { synced_through: inventory.synced_through } : {}),
      source_digest: sha256(source),
      observed: inventory.objects.length,
      inserted,
      unchanged,
      deleted: 0,
      errors: 0,
    };
    await store.appendSyncReceipt(receipt);
    return receipt;
  } finally {
    await store.releaseSyncLease({ instanceId, sourceId: source.id, token: leaseToken });
  }
}
