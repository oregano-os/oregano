import type { JsonValue } from "../capabilities/contracts.ts";
import type { CompanyRecordsStore } from "../state-store/records.ts";
import type { CompanyRecordSourceDeclaration } from "./contracts.ts";
import { normalizeRecordObject } from "./normalize.ts";
import type { CompanyRecordsRegistry } from "./registry.ts";
import { CompanyRecordsService } from "./service.ts";
import type { RecordSourceInventory } from "./source-connector.ts";

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
}) {
  const { instanceId, source, inventory, registry, store, runId, leaseOwner, leaseToken, leaseExpiresAt } = args;
  const claimed = await store.claimSyncLease({
    instanceId,
    sourceId: source.id,
    owner: leaseOwner,
    token: leaseToken,
    now: inventory.observed_at,
    expiresAt: leaseExpiresAt,
  });
  if (!claimed) throw new Error(`Record source '${source.id}' already has an active synchronization lease`);
  let inserted = 0;
  let unchanged = 0;
  const service = new CompanyRecordsService({ instanceId, registry, store, now: () => new Date(inventory.observed_at) });
  try {
    for (const raw of inventory.objects) {
      const receipt: Record<string, JsonValue> = { operation: "sync", run_id: runId, inventory_digest: inventory.receipt.inventory_digest ?? "unavailable" };
      const normalized = normalizeRecordObject({ instanceId, source, raw, observedAt: inventory.observed_at, receipt });
      const current = await store.getCurrentObjectVersion(instanceId, source.id, normalized.object_id);
      if (current?.digest === normalized.digest) unchanged += 1;
      else inserted += 1;
      await service.ingest({
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
    }
    await store.setWatermark(instanceId, source.id, inventory.watermark, inventory.observed_at);
    const receipt = {
      instance_id: instanceId,
      source_id: source.id,
      run_id: runId,
      started_at: inventory.observed_at,
      completed_at: inventory.observed_at,
      watermark: inventory.watermark,
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
