import type { CompanyRecordsStore, RecordReadSnapshot } from "../state-store/records.ts";
import type { RecordObjectVersion, RecordProjectionRow } from "./contracts.ts";
import type { CompanyRecordsRegistry } from "./registry.ts";
import { canonicalJson } from "../runtime/canonical.ts";
import { MAX_RECORD_QUERY_ROWS } from "./query.ts";

const owners = new WeakMap<CompanyRecordsStore, CompanyRecordsRegistry>();

/** Keep logical Workspace IDs at the service boundary and immutable IDs in storage. */
export function createRecordGenerationStore(registry: CompanyRecordsRegistry, store: CompanyRecordsStore): CompanyRecordsStore {
  if (owners.has(store)) {
    if (owners.get(store) !== registry) throw new Error("A Records store cannot be rebound to another registry");
    return store;
  }
  const source = (id: string) => registry.sourceStorageId(id);
  const projection = (id: string) => registry.projectionStorageId(id);
  const record = (sourceId: string, id: string) => registry.sourceBindingDigest(sourceId) ? `${registry.sourceDigest(sourceId)}:${id}` : id;
  const version = (value: RecordObjectVersion | undefined, sourceId: string): RecordObjectVersion | undefined => {
    if (!value) return undefined;
    if (value.source_id !== source(sourceId)) throw new Error("Record version belongs to another storage generation");
    return { ...value, source_id: sourceId };
  };
  const row = (value: RecordProjectionRow, projectionId: string): RecordProjectionRow => {
    if (value.projection_id !== projection(projectionId)) throw new Error("Record row belongs to another projection generation");
    return { ...value, projection_id: projectionId };
  };
  const snapshot = async (args: Parameters<CompanyRecordsStore["readProjectionSnapshot"]>[0]): Promise<RecordReadSnapshot> => {
    const ids = new Map(args.sourceIds.map((id) => [source(id), id]));
    const logicalSource = (id: string) => {
      const logical = ids.get(id);
      if (!logical) throw new Error("Record snapshot contains another source generation");
      return logical;
    };
    const result = await store.readProjectionSnapshot({ ...args, projectionId: projection(args.projectionId),
      sourceIds: [...ids.keys()], strictSourceScope: true,
      ...(args.sourceDigests ? { sourceDigests: Object.fromEntries(args.sourceIds.map((id) => [source(id), args.sourceDigests![id]!])) } : {}),
    });
    return { ...(result.scanVersions ? { scanVersions: result.scanVersions.map((value) => version(value, logicalSource(value.source_id))!) } : {}),
      rows: result.rows.map((value) => row(value, args.projectionId)),
      sourceReceipts: result.sourceReceipts.map((value) => ({ ...value, source_id: logicalSource(value.source_id),
        ...(value.projection_digests?.[projection(args.projectionId)] ? { projection_digests: {
          [args.projectionId]: value.projection_digests[projection(args.projectionId)]!,
        } } : { projection_digests: {} }),
      })),
      ...(result.rowSources ? { rowSources: result.rowSources.map((value) => ({ ...value, source_id: logicalSource(value.source_id) })) } : {}),
    };
  };
  const scoped: CompanyRecordsStore = {
    appendSourceEvent: (event) => store.appendSourceEvent({ ...event, source_id: source(event.source_id) }),
    putObjectVersion: (value) => store.putObjectVersion({ ...value, source_id: source(value.source_id) }),
    getObjectVersion: async (instanceId, sourceId, versionId) => version(await store.getObjectVersion(instanceId, source(sourceId), versionId), sourceId),
    getCurrentObjectVersion: async (instanceId, sourceId, objectId) => version(await store.getCurrentObjectVersion(instanceId, source(sourceId), objectId), sourceId),
    listCurrentObjectIds: (instanceId, sourceId) => store.listCurrentObjectIds(instanceId, source(sourceId)),
    applyProjectionMutationIfCurrent: (args) => store.applyProjectionMutationIfCurrent({ ...args,
      sourceId: source(args.sourceId), projectionId: projection(args.projectionId), recordId: record(args.sourceId, args.recordId),
      ...(args.row ? { row: { ...args.row, projection_id: projection(args.row.projection_id), record_id: record(args.sourceId, args.row.record_id) } } : {}),
    }),
    async queryProjectionRows(args) {
      const definition = registry.projection(args.projectionId);
      const result = await snapshot({ ...args, sourceIds: definition.source_ids ?? registry.sourceForRecordType(definition.record_type).map((value) => value.id), limit: MAX_RECORD_QUERY_ROWS });
      if (result.rows.length > MAX_RECORD_QUERY_ROWS) throw new Error("Record generation exceeds the immutable query bound");
      if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200) throw new Error("Record page limit must be between 1 and 200");
      const rows = result.rows.filter((value) => Object.entries(args.filters ?? {}).every(([key, expected]) =>
        Object.hasOwn(value.values, key) && canonicalJson(value.values[key]) === canonicalJson(expected)))
        .sort((a, b) => a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0);
      const at = args.cursor ? rows.findIndex((value) => value.record_id === args.cursor) : -1;
      if (args.cursor && at < 0) throw new Error("Record cursor is absent from this generation");
      const selected = rows.slice(at + 1, at + 1 + args.limit);
      return { rows: selected, ...(at + 1 + args.limit < rows.length ? { nextCursor: selected.at(-1)!.record_id } : {}) };
    },
    readProjectionSnapshot: snapshot,
    appendAccessDecision: (decision) => store.appendAccessDecision({ ...decision, projection_id: projection(decision.projection_id) }),
    appendSyncReceipt: (receipt) => store.appendSyncReceipt({ ...receipt, source_id: source(receipt.source_id),
      ...(receipt.projection_digests ? { projection_digests: Object.fromEntries(Object.entries(receipt.projection_digests).map(([id, digest]) => [projection(id), digest])) } : {}),
    }),
    getWatermark: (instanceId, sourceId) => store.getWatermark(instanceId, source(sourceId)),
    setWatermark: (instanceId, sourceId, watermark, observedAt) => store.setWatermark(instanceId, source(sourceId), watermark, observedAt),
    claimSyncLease: (args) => store.claimSyncLease({ ...args, sourceId: source(args.sourceId) }),
    releaseSyncLease: (args) => store.releaseSyncLease({ ...args, sourceId: source(args.sourceId) }),
  };
  owners.set(scoped, registry);
  return scoped;
}
