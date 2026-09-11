import type { JsonValue } from "../capabilities/contracts.ts";
import type { CompanyRecordsStore } from "../state-store/records.ts";
import type {
  RecordAccessDecision,
  RecordAccessSubject,
  RecordObjectVersion,
  RecordQuery,
  RecordQueryResult,
  RecordSourceEvent,
} from "./contracts.ts";
import { decideProjectionAccess } from "./access.ts";
import { projectionRecordId } from "./identity.ts";
import { projectRecord } from "./projection.ts";
import { CompanyRecordsRegistry } from "./registry.ts";
import { MAX_RECORD_QUERY_ROWS, queryRecordSnapshot } from "./query.ts";
import { compareRecordInstants } from "./instant.ts";
import { sha256 } from "../runtime/canonical.ts";

export class RecordAccessDeniedError extends Error {
  readonly decision: RecordAccessDecision;

  constructor(decision: RecordAccessDecision) {
    super(`Principal '${decision.principal_id}' cannot read projection '${decision.projection_id}': ${decision.reason}`);
    this.decision = decision;
  }
}

export class CompanyRecordsService {
  async history(args: { sourceId: string; from: string; to: string; limit: number; subject: RecordAccessSubject }): Promise<RecordObjectVersion[]> {
    const { instanceId, registry, store } = this.dependencies;
    const source = registry.source(args.sourceId);
    registry.assertSourceInstance(source.id, instanceId);
    if (args.subject.status !== "active" || !source.access.read_groups.some(group => args.subject.group_ids.includes(group))) {
      throw new Error("Record source history access denied by current source policy");
    }
    const versions = await store.readHistory({ instanceId, sourceId: source.id, from: args.from, to: args.to, limit: args.limit });
    if (versions.some(value => value.instance_id !== instanceId || value.source_id !== source.id
      || compareRecordInstants(value.observed_at, args.from) <= 0 || compareRecordInstants(value.observed_at, args.to) > 0)) throw new Error("Record history escaped its source or time scope");
    return versions;
  }
  readonly dependencies: {
    instanceId: string;
    registry: CompanyRecordsRegistry;
    store: CompanyRecordsStore;
    now: () => Date;
  };

  constructor(dependencies: {
    instanceId: string;
    registry: CompanyRecordsRegistry;
    store: CompanyRecordsStore;
    now: () => Date;
  }) {
    this.dependencies = { ...dependencies, store: dependencies.registry.scopeStore(dependencies.store) };
  }

  async ingest(args: {
    event: Omit<RecordSourceEvent, "instance_id">;
    raw: Record<string, JsonValue>;
    deleted?: boolean;
    receipt?: Record<string, JsonValue>;
  }): Promise<{ duplicate: boolean; version?: RecordObjectVersion; projected: string[] }> {
    const { instanceId, registry, store, now } = this.dependencies;
    const event: RecordSourceEvent = { ...args.event, instance_id: instanceId };
    const source = registry.source(event.source_id);
    const version = registry.normalize({
      instanceId,
      source,
      raw: args.raw,
      observedAt: event.observed_at,
      deleted: args.deleted,
      receipt: args.receipt,
    });
    if (version.object_id !== event.object_id) throw new Error("Record event identity does not match the provider object");
    // Invalid input must not consume the deduplication identity before a retry.
    if (!await store.appendSourceEvent(event)) return { duplicate: true, projected: [] };
    await store.putObjectVersion(version);

    const projected: string[] = [];
    for (const projection of registry.projectionsForRecordType(version.record_type)) {
      const row = projectRecord({ projection, version, projectedAt: now().toISOString() });
      const applied = await store.applyProjectionMutationIfCurrent({
        instanceId,
        sourceId: version.source_id,
        objectId: version.object_id,
        expectedVersionId: version.version_id,
        projectionId: projection.id,
        recordId: projectionRecordId(projection.id, version.source_id, version.object_id),
        ...(row ? { row } : {}),
      });
      if (applied) projected.push(projection.id);
    }
    if (event.cursor) await store.setWatermark(instanceId, source.id, event.cursor, event.observed_at);
    return { duplicate: false, version, projected };
  }

  async query(args: { query: RecordQuery; subject: RecordAccessSubject }): Promise<RecordQueryResult> {
    const { instanceId, registry, store, now } = this.dependencies;
    const projection = registry.projection(args.query.projection_id);
    const decidedAt = now().toISOString();
    const accessDecision = decideProjectionAccess({ projection, subject: args.subject, decidedAt });
    await store.appendAccessDecision(accessDecision);
    if (!accessDecision.allowed) throw new RecordAccessDeniedError(accessDecision);
    const sourceIds = projection.source_ids ?? registry.sourceForRecordType(projection.record_type).map((source) => source.id);
    if (sourceIds.some((sourceId) => registry.source(sourceId).record_type !== projection.record_type)) {
      throw new Error(`Projection '${projection.id}' names a source of another record type`);
    }
    for (const sourceId of sourceIds) registry.assertSourceInstance(sourceId, instanceId);
    const sourceDigests = Object.fromEntries(sourceIds.map((sourceId) => [sourceId, registry.sourceDigest(sourceId)]));
    const boundSourceIds = sourceIds.filter((sourceId) => registry.sourceBindingDigest(sourceId) !== undefined);
    const snapshot = await store.readProjectionSnapshot({
      instanceId,
      projectionId: projection.id,
      sourceIds,
      sourceDigests,
      ...(boundSourceIds.length ? { projectionDigest: sha256(projection) } : {}),
      ...(args.query.require_scan_started_after !== undefined ? { currentScan: true, projectionDigest: sha256(projection) } : {}),
      limit: MAX_RECORD_QUERY_ROWS,
    });
    if (snapshot.rows.some((row) => row.instance_id !== instanceId)
      || snapshot.sourceReceipts.some((receipt) => receipt.instance_id !== instanceId)) {
      throw new Error("Record snapshot belongs to another Company Instance");
    }
    const page = await queryRecordSnapshot({ snapshot, projection, sourceIds, sourceDigests, boundSourceIds, query: args.query });
    const observedAt = page.source_scan_proofs?.map((proof) => proof.scan_completed_at).sort(compareRecordInstants).at(-1)
      ?? page.rows.map((row) => row.projected_at).sort().at(-1) ?? decidedAt;
    const freshUntil = new Date(new Date(observedAt).getTime() + projection.freshness.max_age_minutes * 60_000).toISOString();
    return {
      projection_id: projection.id,
      ...page,
      observed_at: observedAt,
      fresh_until: freshUntil,
      access_decision: accessDecision,
    };
  }
}
