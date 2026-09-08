import type {
  RecordAccessDecision,
  RecordObjectVersion,
  RecordProjectionRow,
  RecordReconciliationReceipt,
  RecordSourceEvent,
  RecordSyncReceipt,
} from "../records/contracts.ts";

export interface ProjectionPage {
  rows: RecordProjectionRow[];
  nextCursor?: string;
}

export interface RecordReadSnapshot {
  rows: RecordProjectionRow[];
  /** Immutable normalized versions belonging to selected complete current scans. */
  scanVersions?: RecordObjectVersion[];
  sourceReceipts: RecordSyncReceipt[];
  /** Content-free provenance read atomically with rows and receipts. */
  rowSources?: Array<{ version_id: string; source_id: string; source_digest?: string }>;
}

/** Durable Company Records boundary. Agents never receive this interface. */
export interface CompanyRecordsStore {
  appendSourceEvent(event: RecordSourceEvent): Promise<boolean>;
  putObjectVersion(version: RecordObjectVersion): Promise<boolean>;
  getObjectVersion(instanceId: string, sourceId: string, versionId: string): Promise<RecordObjectVersion | undefined>;
  getCurrentObjectVersion(instanceId: string, sourceId: string, objectId: string): Promise<RecordObjectVersion | undefined>;
  listCurrentObjectIds(instanceId: string, sourceId: string): Promise<string[]>;
  applyProjectionMutationIfCurrent(args: {
    instanceId: string;
    sourceId: string;
    objectId: string;
    expectedVersionId: string;
    projectionId: string;
    recordId: string;
    row?: RecordProjectionRow;
  }): Promise<boolean>;
  queryProjectionRows(args: { instanceId: string; projectionId: string; filters?: Record<string, unknown>; limit: number; cursor?: string }): Promise<ProjectionPage>;
  /** Rows and receipts from one immutable read; return limit + 1 to expose overflow. */
  readProjectionSnapshot(args: { instanceId: string; projectionId: string; sourceIds: string[]; sourceDigests?: Record<string, string>; projectionDigest?: string; strictSourceScope?: boolean; currentScan?: boolean; limit: number }): Promise<RecordReadSnapshot>;
  appendAccessDecision(decision: RecordAccessDecision): Promise<void>;
  appendSyncReceipt(receipt: RecordSyncReceipt | RecordReconciliationReceipt): Promise<void>;
  getWatermark(instanceId: string, sourceId: string): Promise<string | undefined>;
  setWatermark(instanceId: string, sourceId: string, watermark: string, observedAt: string): Promise<void>;
  claimSyncLease(args: { instanceId: string; sourceId: string; owner: string; token: string; now: string; expiresAt: string }): Promise<boolean>;
  releaseSyncLease(args: { instanceId: string; sourceId: string; token: string }): Promise<boolean>;
}
