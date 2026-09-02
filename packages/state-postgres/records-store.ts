import { neon } from "@neondatabase/serverless";
import type {
  RecordObjectVersion,
  RecordProjectionRow,
} from "../records/contracts.ts";
import type { CompanyRecordsStore } from "../state-store/records.ts";
import { postgresTimestampToIso } from "./postgres-values.ts";
import { ensureCompanyRecordsSchema } from "./records-migrate.ts";

const connection = () => {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is not set — bind the Company Instance StateStore.");
  return neon(value);
};

const json = (value: unknown): any => typeof value === "string" ? JSON.parse(value) : value;

const objectVersion = (row: Record<string, any>): RecordObjectVersion => ({
  instance_id: String(row.instance_id),
  source_id: String(row.source_id),
  record_type: String(row.record_type),
  object_id: String(row.object_id),
  version_id: String(row.version_id),
  digest: String(row.digest),
  observed_at: postgresTimestampToIso(row.observed_at),
  deleted: Boolean(row.deleted),
  values: json(row.values_json),
  source_receipt: json(row.source_receipt),
});

const projectionRow = (row: Record<string, any>): RecordProjectionRow => ({
  instance_id: String(row.instance_id),
  projection_id: String(row.projection_id),
  record_id: String(row.record_id),
  record_type: String(row.record_type),
  source_version_id: String(row.source_version_id),
  projected_at: postgresTimestampToIso(row.projected_at),
  values: json(row.values_json),
});

export interface PostgresCompanyRecordSourceStatus {
  available: boolean;
  instance_id: string;
  source_id: string;
  source_events: number;
  current_objects: number;
  object_versions: number;
  watermark?: string;
  watermark_observed_at?: string;
  last_sync?: {
    run_id: string;
    started_at: string;
    completed_at: string;
    watermark?: string;
    observed: number;
    inserted: number;
    unchanged: number;
    deleted: number;
    errors: number;
    missing_from_provider?: number;
    repaired_projections?: number;
  };
}

export interface PostgresCompanyRecordProjectionStatus {
  available: boolean;
  projection_id: string;
  rows: number;
}

/** Payload-free lookup used to reuse one exact completed operation outcome. */
export async function inspectPostgresCompanyRecordSyncReceipt(
  instanceId: string,
  sourceId: string,
  runId: string,
): Promise<PostgresCompanyRecordSourceStatus["last_sync"] | undefined> {
  const sql = connection();
  const present = await sql`select to_regclass('companyos_records.sync_receipts') as sync_receipts`;
  if (!present[0]?.sync_receipts) return undefined;
  const rows = await sql`select run_id, started_at, completed_at, watermark, summary
    from companyos_records.sync_receipts
    where instance_id = ${instanceId} and source_id = ${sourceId} and run_id = ${runId}
    limit 1`;
  const receipt = rows[0];
  if (!receipt) return undefined;
  const summary = json(receipt.summary);
  return {
    run_id: String(receipt.run_id),
    started_at: postgresTimestampToIso(receipt.started_at),
    completed_at: postgresTimestampToIso(receipt.completed_at),
    ...(receipt.watermark ? { watermark: String(receipt.watermark) } : {}),
    observed: Number(summary?.observed ?? 0),
    inserted: Number(summary?.inserted ?? 0),
    unchanged: Number(summary?.unchanged ?? 0),
    deleted: Number(summary?.deleted ?? 0),
    errors: Number(summary?.errors ?? 0),
    ...(summary?.missing_from_provider !== undefined ? { missing_from_provider: Number(summary.missing_from_provider) } : {}),
    ...(summary?.repaired_projections !== undefined ? { repaired_projections: Number(summary.repaired_projections) } : {}),
  };
}

/** Payload-free projection counts for a bounded, declared projection set. */
export async function inspectPostgresCompanyRecordProjectionStatus(
  instanceId: string,
  projectionIds: readonly string[],
): Promise<PostgresCompanyRecordProjectionStatus[]> {
  if (projectionIds.length > 100) throw new Error("Company Records status supports at most one hundred projections");
  const sql = connection();
  const present = await sql`select to_regclass('companyos_records.projection_rows') as projection_rows`;
  if (!present[0]?.projection_rows) return projectionIds.map((projectionId) => ({ available: false, projection_id: projectionId, rows: 0 }));
  return Promise.all(projectionIds.map(async (projectionId) => {
    const rows = await sql`select count(*) as count from companyos_records.projection_rows
      where instance_id = ${instanceId} and projection_id = ${projectionId}`;
    return { available: true, projection_id: projectionId, rows: Number(rows[0]?.count ?? 0) };
  }));
}

/** Payload-free read. Unlike the mutating store, status never creates schema objects. */
export async function inspectPostgresCompanyRecordSourceStatus(
  instanceId: string,
  sourceId: string,
): Promise<PostgresCompanyRecordSourceStatus> {
  const sql = connection();
  const present = await sql`select to_regclass('companyos_records.source_events') as source_events`;
  if (!present[0]?.source_events) {
    return { available: false, instance_id: instanceId, source_id: sourceId, source_events: 0, current_objects: 0, object_versions: 0 };
  }
  const [eventRows, currentRows, versionRows, watermarkRows, receiptRows] = await Promise.all([
    sql`select count(*) as count from companyos_records.source_events where instance_id = ${instanceId} and source_id = ${sourceId}`,
    sql`select count(*) as count from companyos_records.current_objects where instance_id = ${instanceId} and source_id = ${sourceId}`,
    sql`select count(*) as count from companyos_records.object_versions where instance_id = ${instanceId} and source_id = ${sourceId}`,
    sql`select watermark, observed_at from companyos_records.source_watermarks where instance_id = ${instanceId} and source_id = ${sourceId} limit 1`,
    sql`select run_id, started_at, completed_at, watermark, summary from companyos_records.sync_receipts
      where instance_id = ${instanceId} and source_id = ${sourceId}
      order by completed_at desc, run_id desc limit 1`,
  ]);
  const receipt = receiptRows[0];
  const summary = receipt ? json(receipt.summary) : undefined;
  return {
    available: true,
    instance_id: instanceId,
    source_id: sourceId,
    source_events: Number(eventRows[0]?.count ?? 0),
    current_objects: Number(currentRows[0]?.count ?? 0),
    object_versions: Number(versionRows[0]?.count ?? 0),
    ...(watermarkRows[0] ? {
      watermark: String(watermarkRows[0].watermark),
      watermark_observed_at: postgresTimestampToIso(watermarkRows[0].observed_at),
    } : {}),
    ...(receipt ? {
      last_sync: {
        run_id: String(receipt.run_id),
        started_at: postgresTimestampToIso(receipt.started_at),
        completed_at: postgresTimestampToIso(receipt.completed_at),
        ...(receipt.watermark ? { watermark: String(receipt.watermark) } : {}),
        observed: Number(summary?.observed ?? 0),
        inserted: Number(summary?.inserted ?? 0),
        unchanged: Number(summary?.unchanged ?? 0),
        deleted: Number(summary?.deleted ?? 0),
        errors: Number(summary?.errors ?? 0),
        ...(summary?.missing_from_provider !== undefined ? { missing_from_provider: Number(summary.missing_from_provider) } : {}),
        ...(summary?.repaired_projections !== undefined ? { repaired_projections: Number(summary.repaired_projections) } : {}),
      },
    } : {}),
  };
}

export function createPostgresCompanyRecordsStore(): CompanyRecordsStore {
  return {
    async appendSourceEvent(event) {
      await ensureCompanyRecordsSchema();
      const rows = await connection()`
        insert into companyos_records.source_events
          (instance_id, source_id, event_id, object_id, event_kind, observed_at, cursor, receipt)
        values (${event.instance_id}, ${event.source_id}, ${event.event_id}, ${event.object_id},
          ${event.kind}, ${event.observed_at}, ${event.cursor ?? null}, ${JSON.stringify(event.receipt)})
        on conflict (instance_id, source_id, event_id) do nothing returning event_id`;
      return rows.length === 1;
    },

    async putObjectVersion(version) {
      await ensureCompanyRecordsSchema();
      const rows = await connection()`
        with inserted as (
          insert into companyos_records.object_versions
            (instance_id, source_id, record_type, object_id, version_id, digest,
             observed_at, deleted, values_json, source_receipt)
          values (${version.instance_id}, ${version.source_id}, ${version.record_type},
            ${version.object_id}, ${version.version_id}, ${version.digest}, ${version.observed_at},
            ${version.deleted}, ${JSON.stringify(version.values)}, ${JSON.stringify(version.source_receipt)})
          on conflict (instance_id, source_id, version_id) do nothing
          returning instance_id, source_id, object_id, version_id, observed_at
        ), current as (
          insert into companyos_records.current_objects
            (instance_id, source_id, object_id, version_id, updated_at)
          select instance_id, source_id, object_id, version_id, observed_at from inserted
          on conflict (instance_id, source_id, object_id) do update
            set version_id = excluded.version_id, updated_at = excluded.updated_at
          where companyos_records.current_objects.updated_at <= excluded.updated_at
          returning version_id
        )
        select count(*) as inserted from inserted`;
      return Number(rows[0]?.inserted ?? 0) === 1;
    },

    async getObjectVersion(instanceId, sourceId, versionId) {
      await ensureCompanyRecordsSchema();
      const rows = await connection()`select * from companyos_records.object_versions
        where instance_id = ${instanceId} and source_id = ${sourceId} and version_id = ${versionId} limit 1`;
      return rows[0] ? objectVersion(rows[0]) : undefined;
    },

    async getCurrentObjectVersion(instanceId, sourceId, objectId) {
      await ensureCompanyRecordsSchema();
      const rows = await connection()`select v.* from companyos_records.current_objects c
        join companyos_records.object_versions v
          on v.instance_id = c.instance_id and v.source_id = c.source_id and v.version_id = c.version_id
        where c.instance_id = ${instanceId} and c.source_id = ${sourceId} and c.object_id = ${objectId} limit 1`;
      return rows[0] ? objectVersion(rows[0]) : undefined;
    },

    async listCurrentObjectIds(instanceId, sourceId) {
      await ensureCompanyRecordsSchema();
      const rows = await connection()`select object_id from companyos_records.current_objects
        where instance_id = ${instanceId} and source_id = ${sourceId} order by object_id`;
      return rows.map((row) => String(row.object_id));
    },

    async upsertProjectionRow(row) {
      await ensureCompanyRecordsSchema();
      await connection()`insert into companyos_records.projection_rows
        (instance_id, projection_id, record_id, record_type, source_version_id, projected_at, values_json)
        values (${row.instance_id}, ${row.projection_id}, ${row.record_id}, ${row.record_type},
          ${row.source_version_id}, ${row.projected_at}, ${JSON.stringify(row.values)})
        on conflict (instance_id, projection_id, record_id) do update
          set record_type = excluded.record_type, source_version_id = excluded.source_version_id,
              projected_at = excluded.projected_at, values_json = excluded.values_json`;
    },

    async removeProjectionRow(instanceId, projectionId, recordId) {
      await ensureCompanyRecordsSchema();
      await connection()`delete from companyos_records.projection_rows
        where instance_id = ${instanceId} and projection_id = ${projectionId} and record_id = ${recordId}`;
    },

    async queryProjectionRows(args) {
      await ensureCompanyRecordsSchema();
      const filters = JSON.stringify(args.filters ?? {});
      const rows = await connection()`select * from companyos_records.projection_rows
        where instance_id = ${args.instanceId} and projection_id = ${args.projectionId}
          and values_json @> ${filters}::jsonb
          and (${args.cursor ?? null}::text is null or record_id > ${args.cursor ?? null})
        order by record_id asc limit ${args.limit + 1}`;
      const hasMore = rows.length > args.limit;
      const selected = rows.slice(0, args.limit).map(projectionRow);
      return { rows: selected, ...(hasMore ? { nextCursor: selected.at(-1)?.record_id } : {}) };
    },

    async appendAccessDecision(decision) {
      await ensureCompanyRecordsSchema();
      await connection()`insert into companyos_records.access_decisions
        (projection_id, principal_id, allowed, policy_digest, reason, decided_at)
        values (${decision.projection_id}, ${decision.principal_id}, ${decision.allowed},
          ${decision.policy_digest}, ${decision.reason}, ${decision.decided_at})`;
    },

    async appendSyncReceipt(receipt) {
      await ensureCompanyRecordsSchema();
      await connection()`insert into companyos_records.sync_receipts
        (instance_id, source_id, run_id, started_at, completed_at, watermark, summary)
        values (${receipt.instance_id}, ${receipt.source_id}, ${receipt.run_id}, ${receipt.started_at},
          ${receipt.completed_at}, ${receipt.watermark ?? null}, ${JSON.stringify(receipt)})
        on conflict (instance_id, source_id, run_id) do nothing`;
    },

    async getWatermark(instanceId, sourceId) {
      await ensureCompanyRecordsSchema();
      const rows = await connection()`select watermark from companyos_records.source_watermarks
        where instance_id = ${instanceId} and source_id = ${sourceId} limit 1`;
      return rows[0] ? String(rows[0].watermark) : undefined;
    },

    async setWatermark(instanceId, sourceId, watermark, observedAt) {
      await ensureCompanyRecordsSchema();
      await connection()`insert into companyos_records.source_watermarks
        (instance_id, source_id, watermark, observed_at)
        values (${instanceId}, ${sourceId}, ${watermark}, ${observedAt})
        on conflict (instance_id, source_id) do update
          set watermark = excluded.watermark, observed_at = excluded.observed_at
        where companyos_records.source_watermarks.observed_at <= excluded.observed_at`;
    },

    async claimSyncLease(args) {
      await ensureCompanyRecordsSchema();
      const rows = await connection()`insert into companyos_records.sync_leases
        (instance_id, source_id, lease_owner, lease_token, lease_expires_at, updated_at)
        values (${args.instanceId}, ${args.sourceId}, ${args.owner}, ${args.token}, ${args.expiresAt}, ${args.now})
        on conflict (instance_id, source_id) do update
          set lease_owner = excluded.lease_owner, lease_token = excluded.lease_token,
              lease_expires_at = excluded.lease_expires_at, updated_at = excluded.updated_at
        where companyos_records.sync_leases.lease_expires_at <= ${args.now}
        returning lease_token`;
      return rows.length === 1;
    },

    async releaseSyncLease(args) {
      await ensureCompanyRecordsSchema();
      const rows = await connection()`delete from companyos_records.sync_leases
        where instance_id = ${args.instanceId} and source_id = ${args.sourceId}
          and lease_token = ${args.token} returning lease_token`;
      return rows.length === 1;
    },
  };
}
