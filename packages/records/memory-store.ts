import { compareRecordInstants } from "./instant.ts";
import type {
  RecordAccessDecision,
  RecordObjectVersion,
  RecordProjectionRow,
  RecordReconciliationReceipt,
  RecordSourceEvent,
  RecordSyncReceipt,
} from "./contracts.ts";
import type { CompanyRecordsStore, ProjectionPage, RecordReadSnapshot } from "../state-store/records.ts";

const key = (...parts: string[]) => parts.join("\0");

export class InMemoryCompanyRecordsStore implements CompanyRecordsStore {
  readonly sourceEvents = new Map<string, RecordSourceEvent>();
  readonly objectVersions = new Map<string, RecordObjectVersion>();
  readonly currentObjects = new Map<string, string>();
  readonly projectionRows = new Map<string, RecordProjectionRow>();
  readonly accessDecisions: RecordAccessDecision[] = [];
  readonly syncReceipts: Array<RecordSyncReceipt | RecordReconciliationReceipt> = [];
  readonly watermarks = new Map<string, string>();
  readonly syncLeases = new Map<string, { owner: string; token: string; expiresAt: string }>();

  async appendSourceEvent(event: RecordSourceEvent): Promise<boolean> {
    const eventKey = key(event.instance_id, event.source_id, event.event_id);
    if (this.sourceEvents.has(eventKey)) return false;
    this.sourceEvents.set(eventKey, structuredClone(event));
    return true;
  }

  async putObjectVersion(version: RecordObjectVersion): Promise<boolean> {
    const versionKey = key(version.instance_id, version.source_id, version.version_id);
    if (this.objectVersions.has(versionKey)) return false;
    this.objectVersions.set(versionKey, structuredClone(version));
    this.currentObjects.set(key(version.instance_id, version.source_id, version.object_id), version.version_id);
    return true;
  }

  async getObjectVersion(instanceId: string, sourceId: string, versionId: string): Promise<RecordObjectVersion | undefined> {
    const value = this.objectVersions.get(key(instanceId, sourceId, versionId));
    return value ? structuredClone(value) : undefined;
  }

  async getCurrentObjectVersion(instanceId: string, sourceId: string, objectId: string): Promise<RecordObjectVersion | undefined> {
    const versionId = this.currentObjects.get(key(instanceId, sourceId, objectId));
    return versionId ? this.getObjectVersion(instanceId, sourceId, versionId) : undefined;
  }

  async listCurrentObjectIds(instanceId: string, sourceId: string): Promise<string[]> {
    const prefix = key(instanceId, sourceId, "");
    return [...this.currentObjects.keys()].filter((item) => item.startsWith(prefix)).map((item) => item.slice(prefix.length)).sort();
  }

  async applyProjectionMutationIfCurrent(args: {
    instanceId: string;
    sourceId: string;
    objectId: string;
    expectedVersionId: string;
    projectionId: string;
    recordId: string;
    row?: RecordProjectionRow;
  }): Promise<boolean> {
    if (this.currentObjects.get(key(args.instanceId, args.sourceId, args.objectId)) !== args.expectedVersionId) return false;
    const projectionKey = key(args.instanceId, args.projectionId, args.recordId);
    if (args.row) this.projectionRows.set(projectionKey, structuredClone(args.row));
    else this.projectionRows.delete(projectionKey);
    return true;
  }

  async queryProjectionRows(args: { instanceId: string; projectionId: string; filters?: Record<string, unknown>; limit: number; cursor?: string }): Promise<ProjectionPage> {
    const rows = [...this.projectionRows.values()]
      .filter((row) => row.instance_id === args.instanceId && row.projection_id === args.projectionId)
      .filter((row) => Object.entries(args.filters ?? {}).every(([field, expected]) => JSON.stringify(row.values[field]) === JSON.stringify(expected)))
      .sort((a, b) => a.record_id.localeCompare(b.record_id));
    const start = args.cursor ? Math.max(0, rows.findIndex((row) => row.record_id === args.cursor) + 1) : 0;
    const page = rows.slice(start, start + args.limit).map((row) => structuredClone(row));
    const nextCursor = start + args.limit < rows.length ? page.at(-1)?.record_id : undefined;
    return { rows: page, ...(nextCursor ? { nextCursor } : {}) };
  }

  async appendAccessDecision(decision: RecordAccessDecision): Promise<void> {
    this.accessDecisions.push(structuredClone(decision));
  }

  async readProjectionSnapshot(args: { instanceId: string; projectionId: string; sourceIds: string[]; limit: number }): Promise<RecordReadSnapshot> {
    // No await: rows and receipts are copied at the same observation boundary.
    const rows = [...this.projectionRows.values()]
      .filter((row) => row.instance_id === args.instanceId && row.projection_id === args.projectionId)
      .sort((a, b) => a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0)
      .slice(0, args.limit + 1);
    const sourceReceipts = args.sourceIds.flatMap((sourceId) => {
      const receipt = this.syncReceipts.filter((value) => value.instance_id === args.instanceId && value.source_id === sourceId
        && value.synced_through && value.watermark && value.errors === 0)
        .sort((a, b) => compareRecordInstants(b.synced_through!, a.synced_through!) || b.run_id.localeCompare(a.run_id))[0];
      return receipt ? [receipt] : [];
    });
    return structuredClone({ rows, sourceReceipts });
  }

  async appendSyncReceipt(receipt: RecordSyncReceipt | RecordReconciliationReceipt): Promise<void> {
    this.syncReceipts.push(structuredClone(receipt));
  }

  async getWatermark(instanceId: string, sourceId: string): Promise<string | undefined> {
    return this.watermarks.get(key(instanceId, sourceId));
  }

  async setWatermark(instanceId: string, sourceId: string, watermark: string): Promise<void> {
    this.watermarks.set(key(instanceId, sourceId), watermark);
  }

  async claimSyncLease(args: { instanceId: string; sourceId: string; owner: string; token: string; now: string; expiresAt: string }): Promise<boolean> {
    const leaseKey = key(args.instanceId, args.sourceId);
    const existing = this.syncLeases.get(leaseKey);
    if (existing && existing.expiresAt > args.now) return false;
    this.syncLeases.set(leaseKey, { owner: args.owner, token: args.token, expiresAt: args.expiresAt });
    return true;
  }

  async releaseSyncLease(args: { instanceId: string; sourceId: string; token: string }): Promise<boolean> {
    const leaseKey = key(args.instanceId, args.sourceId);
    if (this.syncLeases.get(leaseKey)?.token !== args.token) return false;
    this.syncLeases.delete(leaseKey);
    return true;
  }
}
