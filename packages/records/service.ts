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
import { normalizeRecordObject } from "./normalize.ts";
import { projectRecord } from "./projection.ts";
import { CompanyRecordsRegistry } from "./registry.ts";
import { MAX_RECORD_QUERY_ROWS, queryRecordSnapshot } from "./query.ts";
import { sha256 } from "../runtime/canonical.ts";

export class RecordAccessDeniedError extends Error {
  readonly decision: RecordAccessDecision;

  constructor(decision: RecordAccessDecision) {
    super(`Principal '${decision.principal_id}' cannot read projection '${decision.projection_id}': ${decision.reason}`);
    this.decision = decision;
  }
}

export class CompanyRecordsService {
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
    this.dependencies = dependencies;
  }

  async ingest(args: {
    event: Omit<RecordSourceEvent, "instance_id">;
    raw: Record<string, JsonValue>;
    deleted?: boolean;
    receipt?: Record<string, JsonValue>;
  }): Promise<{ duplicate: boolean; version?: RecordObjectVersion; projected: string[] }> {
    const { instanceId, registry, store, now } = this.dependencies;
    const event: RecordSourceEvent = { ...args.event, instance_id: instanceId };
    if (!await store.appendSourceEvent(event)) return { duplicate: true, projected: [] };

    const source = registry.source(event.source_id);
    const version = normalizeRecordObject({
      instanceId,
      source,
      raw: args.raw,
      observedAt: event.observed_at,
      deleted: args.deleted,
      receipt: args.receipt,
    });
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
    const snapshot = await store.readProjectionSnapshot({
      instanceId,
      projectionId: projection.id,
      sourceIds,
      limit: MAX_RECORD_QUERY_ROWS,
    });
    if (snapshot.rows.some((row) => row.instance_id !== instanceId)
      || snapshot.sourceReceipts.some((receipt) => receipt.instance_id !== instanceId)) {
      throw new Error("Record snapshot belongs to another Company Instance");
    }
    const sourceDigests = Object.fromEntries(sourceIds.map((sourceId) => [sourceId, sha256(registry.source(sourceId))]));
    const page = await queryRecordSnapshot({ snapshot, projection, sourceIds, sourceDigests, query: args.query });
    const observedAt = page.rows.map((row) => row.projected_at).sort().at(-1) ?? decidedAt;
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
