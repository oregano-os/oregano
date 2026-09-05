import type { JsonValue } from "../capabilities/contracts.ts";
import { canonicalJson, sha256 } from "../runtime/canonical.ts";
import type { ProjectionPage, RecordReadSnapshot } from "../state-store/records.ts";
import type { CompanyRecordProjectionDeclaration, RecordFilterDeclaration, RecordProjectionRow, RecordQuery, RecordSourceProof } from "./contracts.ts";

export const MAX_RECORD_QUERY_ROWS = 10_000;
const pathPattern = /^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*$/;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function recordQueryInstant(value: unknown, label: string): number {
  if (typeof value !== "string" || !instantPattern.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp with timezone`);
  }
  return Date.parse(value);
}

const readPath = (value: JsonValue, path: string): JsonValue | undefined => {
  let current: JsonValue | undefined = value;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
};
const missing = (value: JsonValue | undefined): boolean => value === undefined || value === null
  || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && value.length === 0);

export function validateRecordFilters(projection: CompanyRecordProjectionDeclaration): void {
  const exposed = new Set(projection.fields.map((field) => field.name));
  for (const [name, filter] of Object.entries(projection.filters ?? {})) {
    if (!pathPattern.test(name) || !pathPattern.test(filter.path) || !exposed.has(filter.path.split(".")[0]!)) {
      throw new Error(`Projection '${projection.id}' filter '${name}' must name an exposed field path`);
    }
    if (!["equals", "in", "after", "missing-any"].includes(filter.operator)) throw new Error(`Unknown Record filter operator '${filter.operator}'`);
    if (filter.operator === "missing-any") {
      if (!filter.fields?.length || filter.fields.some((field) => !pathPattern.test(field))) {
        throw new Error(`Projection '${projection.id}' filter '${name}' requires allowed field paths`);
      }
    } else if (filter.fields) throw new Error(`Filter '${name}' does not accept a fields allowlist`);
  }
}

function predicate(filter: RecordFilterDeclaration, expected: JsonValue, name: string): (row: RecordProjectionRow) => boolean {
  switch (filter.operator) {
    case "equals": return (row) => {
      const value = readPath(row.values, filter.path);
      return value !== undefined && canonicalJson(value) === canonicalJson(expected);
    };
    case "in": {
      if (!Array.isArray(expected) || expected.length > MAX_RECORD_QUERY_ROWS) throw new Error(`Filter '${name}' requires a bounded array`);
      const members = new Set(expected.map((value) => canonicalJson(value)));
      return (row) => {
        const value = readPath(row.values, filter.path);
        return value !== undefined && members.has(canonicalJson(value));
      };
    }
    case "after": {
      const since = recordQueryInstant(expected, `Filter '${name}'`);
      return (row) => {
        const value = readPath(row.values, filter.path);
        if (missing(value)) return false;
        return recordQueryInstant(value, `Projection value '${filter.path}'`) >= since;
      };
    }
    case "missing-any": {
      if (!Array.isArray(expected) || !expected.length || expected.some((field) => typeof field !== "string" || !filter.fields?.includes(field))) {
        throw new Error(`Filter '${name}' requires declared field names`);
      }
      return (row) => expected.some((field) => missing(readPath(row.values, `${filter.path}.${String(field)}`)));
    }
  }
}

export function filterRecordRows(projection: CompanyRecordProjectionDeclaration, filters: Record<string, JsonValue>, rows: RecordProjectionRow[]): RecordProjectionRow[] {
  const predicates = Object.entries(filters).map(([name, value]) => {
    const declaration = projection.filters?.[name] ?? (!projection.filters && projection.fields.some((field) => field.name === name)
      ? { operator: "equals" as const, path: name } : undefined);
    if (!declaration) throw new Error(`Filter '${name}' is not declared by projection '${projection.id}'`);
    return predicate(declaration, value, name);
  });
  return rows.filter((row) => predicates.every((matches) => matches(row)));
}

/** Defend the generic all-pages boundary even when a store adapter misbehaves. */
export async function drainRecordPages(read: (cursor?: string) => Promise<ProjectionPage>): Promise<RecordProjectionRow[]> {
  const rows: RecordProjectionRow[] = [];
  const cursors = new Set<string>();
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    for (const row of page.rows) {
      if (ids.has(row.record_id)) throw new Error("Record query returned a repeated record identity");
      ids.add(row.record_id);
      rows.push(row);
    }
    if (rows.length > MAX_RECORD_QUERY_ROWS) throw new Error(`Record query exceeds the ${MAX_RECORD_QUERY_ROWS}-row bound; narrow the projection`);
    cursor = page.nextCursor;
    if (cursor && (!page.rows.length || cursors.has(cursor))) throw new Error("Record query returned an empty or repeated continuation cursor");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return rows;
}

export async function queryRecordSnapshot(args: {
  snapshot: RecordReadSnapshot; projection: CompanyRecordProjectionDeclaration; sourceIds: string[]; sourceDigests: Record<string, string>; query: RecordQuery;
}): Promise<{ rows: RecordProjectionRow[]; next_cursor?: string; snapshot_id: string; source_proofs: RecordSourceProof[]; synced_through?: string }> {
  const { query, snapshot, projection, sourceIds } = args;
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Record page limit must be between 1 and 200");
  if (query.all_pages && query.cursor) throw new Error("A complete Record query cannot start at a partial cursor");
  if (snapshot.rows.length > MAX_RECORD_QUERY_ROWS) throw new Error(`Record projection exceeds the ${MAX_RECORD_QUERY_ROWS}-row snapshot bound; narrow the projection`);
  if (snapshot.rows.some((row) => row.projection_id !== projection.id)) throw new Error("Record snapshot contains a row from another projection");
  const sourceProofs = sourceIds.flatMap((sourceId) => {
    const receipt = snapshot.sourceReceipts.find((value) => value.source_id === sourceId && value.source_digest === args.sourceDigests[sourceId]
      && value.synced_through && value.watermark && value.errors === 0);
    if (!receipt?.synced_through || !receipt.watermark) return [];
    const through = recordQueryInstant(receipt.synced_through, "Source completeness");
    if (through > recordQueryInstant(receipt.completed_at, "Synchronization completion")) throw new Error("Source completeness cannot exceed synchronization completion");
    return [{ source_id: sourceId, source_digest: args.sourceDigests[sourceId]!, run_id: receipt.run_id, synced_through: new Date(through).toISOString(), watermark: receipt.watermark }];
  }).sort((a, b) => a.source_id.localeCompare(b.source_id));
  const through = sourceIds.length && sourceProofs.length === sourceIds.length
    ? sourceProofs.map((proof) => proof.synced_through).sort()[0] : undefined;
  if (query.require_synced_through) {
    const required = recordQueryInstant(query.require_synced_through, "Required source completeness");
    if (!through || Date.parse(through) < required) {
      throw new Error(`Projection '${projection.id}' is not completely synchronized through ${query.require_synced_through}; complete the declared source synchronization and retry`);
    }
  }
  const rows = filterRecordRows(projection, query.filters ?? {}, snapshot.rows)
    .sort((a, b) => a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0);
  const snapshotId = sha256(canonicalJson({ projection, filters: query.filters ?? {}, rows, source_proofs: sourceProofs }));
  const page = async (cursor?: string): Promise<ProjectionPage> => {
    let offset = 0;
    if (cursor) {
      const match = cursor.match(/^([a-f0-9]{64}):(\d+)$/);
      if (!match || match[1] !== snapshotId || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) > rows.length) {
        throw new Error("Record cursor belongs to a different snapshot or query; restart the query");
      }
      offset = Number(match[2]);
    }
    return { rows: rows.slice(offset, offset + limit), ...(offset + limit < rows.length ? { nextCursor: `${snapshotId}:${offset + limit}` } : {}) };
  };
  const first = query.all_pages ? { rows: await drainRecordPages(page) } : await page(query.cursor);
  return {
    rows: first.rows,
    ...("nextCursor" in first && first.nextCursor ? { next_cursor: first.nextCursor } : {}),
    snapshot_id: snapshotId,
    source_proofs: sourceProofs,
    ...(through ? { synced_through: through } : {}),
  };
}
