import type { RecordReadSnapshot } from "../state-store/records.ts";
import type { CompanyRecordProjectionDeclaration, RecordProjectionRow, RecordSourceScanProof } from "./contracts.ts";
import { canonicalRecordInstant, compareRecordInstants, recordInstant } from "./instant.ts";
import { projectRecord } from "./projection.ts";
import { sha256 } from "../runtime/canonical.ts";

/** No qualifying inventory yet; never a substitute for complete-scan proof. */
export class RecordScanPendingError extends Error {
  readonly projectionId: string;
  readonly requiredAfter: string;
  constructor(projectionId: string, requiredAfter: string, message: string) {
    super(message);
    this.projectionId = projectionId;
    this.requiredAfter = requiredAfter;
    this.name = "RecordScanPendingError";
  }
}

/** Select one completed inventory per exact source, never mutable current rows. */
export function currentScanSnapshot(args: {
  snapshot: RecordReadSnapshot;
  projection: CompanyRecordProjectionDeclaration;
  sourceIds: string[];
  sourceDigests: Record<string, string>;
  boundSourceIds?: string[];
  requiredAfter: string;
  limit: number;
}): { rows: RecordProjectionRow[]; scan_started_at: string; source_scan_proofs: RecordSourceScanProof[] } {
  const { snapshot, projection, sourceIds, sourceDigests, limit } = args;
  const required = recordInstant(args.requiredAfter, "Required scan start");
  if (!Array.isArray(snapshot.scanVersions)) throw new Error("Current scan immutable inventory membership is unavailable");
  const versions = snapshot.scanVersions;
  if (!sourceIds.length || sourceIds.length > 100 || new Set(sourceIds).size !== sourceIds.length) {
    throw new Error("A current scan requires distinct bounded source identities");
  }
  if (versions.length > limit) throw new Error("Current scan exceeds the immutable inventory bound");
  const keys = new Set(versions.map((version) => `${version.source_id}:${version.version_id}`));
  if (keys.size !== versions.length || versions.some((version) => !sourceIds.includes(version.source_id))) {
    throw new Error("Current scan contains duplicate or foreign immutable versions");
  }
  const rows: RecordProjectionRow[] = [];
  const proofs: RecordSourceScanProof[] = [];
  for (const sourceId of sourceIds) {
    const receipts = snapshot.sourceReceipts.filter((receipt) => receipt.source_id === sourceId);
    const receipt = receipts[0];
    if (!receipt) throw new RecordScanPendingError(projection.id, args.requiredAfter,
      `Projection '${projection.id}' has no matching complete current scan for '${sourceId}'; synchronize its exact source and retry`);
    if (receipt && receipt.observed > limit) throw new Error("Current scan exceeds the immutable inventory bound; narrow the declared source scope");
    if (receipts.length !== 1 || !receipt?.scan_started_at || !receipt.watermark || !receipt.run_id
      || receipt.errors !== 0 || receipt.source_digest !== sourceDigests[sourceId]
      || receipt.projection_digests?.[projection.id] !== sha256(projection)
      || !Array.isArray(receipt.scan_version_ids)) {
      throw new Error(`Projection '${projection.id}' has no matching complete current scan for '${sourceId}'; synchronize its exact source and retry`);
    }
    const start = recordInstant(receipt.scan_started_at, "Scan start");
    if (start > recordInstant(receipt.completed_at, "Scan completion")) throw new Error("Current scan start exceeds its completion");
    const ids = receipt.scan_version_ids;
    const expected = new Set(ids);
    const selected = versions.filter((version) => version.source_id === sourceId);
    if (ids.length > limit || ids.length !== expected.size || ids.length !== receipt.observed
      || ids.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
      || selected.length !== ids.length || selected.some((version) => !expected.has(version.version_id)
        || version.instance_id !== receipt.instance_id || version.record_type !== projection.record_type)) {
      throw new Error("Current scan immutable inventory membership is incomplete or inconsistent");
    }
    if (args.boundSourceIds?.includes(sourceId) && selected.some((version) => version.source_receipt.source_digest !== sourceDigests[sourceId])) {
      throw new Error("Current scan lacks exact source-binding provenance");
    }
    if (start < required) throw new RecordScanPendingError(projection.id, args.requiredAfter,
      `Projection '${projection.id}' requires a complete scan started at or after ${args.requiredAfter}; synchronize and retry`);
    for (const version of selected) {
      const row = projectRecord({ projection, version, projectedAt: canonicalRecordInstant(receipt.completed_at) });
      if (row) rows.push(row);
    }
    proofs.push({ source_id: sourceId, source_digest: receipt.source_digest, run_id: receipt.run_id,
      scan_started_at: canonicalRecordInstant(receipt.scan_started_at), scan_completed_at: canonicalRecordInstant(receipt.completed_at),
      inventory_digest: sha256([...ids].sort()), watermark: receipt.watermark });
  }
  proofs.sort((a, b) => a.source_id.localeCompare(b.source_id));
  return { rows, scan_started_at: proofs.map((proof) => proof.scan_started_at).sort(compareRecordInstants)[0]!, source_scan_proofs: proofs };
}
