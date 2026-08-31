import type { JsonValue } from "../capabilities/contracts.ts";
import type { CompanyRecordProjectionDeclaration, RecordObjectVersion, RecordProjectionRow } from "./contracts.ts";
import { projectionRecordId } from "./identity.ts";

const readPath = (value: Record<string, JsonValue>, path: string): JsonValue | undefined => {
  let current: JsonValue | undefined = value;
  for (const segment of path.split(".")) {
    if (current === null || Array.isArray(current) || typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
};

const selected = (version: RecordObjectVersion, selection: Record<string, JsonValue> | undefined): boolean => {
  if (!selection) return true;
  return Object.entries(selection).every(([path, expected]) => JSON.stringify(readPath(version.values, path)) === JSON.stringify(expected));
};

export function projectRecord(args: {
  projection: CompanyRecordProjectionDeclaration;
  version: RecordObjectVersion;
  projectedAt: string;
}): RecordProjectionRow | null {
  const { projection, version, projectedAt } = args;
  if (projection.record_type !== version.record_type || version.deleted || !selected(version, projection.selection)) return null;
  const values: Record<string, JsonValue> = {};
  for (const field of projection.fields) {
    const value = readPath(version.values, field.path);
    if (value !== undefined) values[field.name] = value;
  }
  return {
    instance_id: version.instance_id,
    projection_id: projection.id,
    record_id: projectionRecordId(projection.id, version.source_id, version.object_id),
    record_type: version.record_type,
    source_version_id: version.version_id,
    projected_at: projectedAt,
    values,
  };
}
