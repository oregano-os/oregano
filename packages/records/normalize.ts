import type { JsonValue } from "../capabilities/contracts.ts";
import type { CompanyRecordSourceDeclaration, RecordObjectVersion } from "./contracts.ts";
import { recordDigest, recordVersionId } from "./identity.ts";

const readPath = (value: Record<string, JsonValue>, path: string): JsonValue | undefined => {
  let current: JsonValue | undefined = value;
  for (const segment of path.split(".")) {
    if (current === null || Array.isArray(current) || typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
};

export function normalizeRecordObject(args: {
  instanceId: string;
  source: CompanyRecordSourceDeclaration;
  raw: Record<string, JsonValue>;
  observedAt: string;
  deleted?: boolean;
  receipt?: Record<string, JsonValue>;
}): RecordObjectVersion {
  const { instanceId, source, raw, observedAt } = args;
  const objectId = readPath(raw, source.identity.source_field);
  if (typeof objectId !== "string" && typeof objectId !== "number") throw new Error(`Record source '${source.id}' did not yield a scalar object identity`);
  const values: Record<string, JsonValue> = {};
  for (const field of source.fields) {
    const value = readPath(raw, field.source);
    if (value === undefined || value === null) {
      if (field.required) throw new Error(`Record source '${source.id}' is missing required field '${field.target}'`);
      continue;
    }
    values[field.target] = value;
  }
  const digest = recordDigest({ deleted: args.deleted ?? false, values });
  return {
    instance_id: instanceId,
    source_id: source.id,
    record_type: source.record_type,
    object_id: String(objectId),
    version_id: recordVersionId(source.id, String(objectId), digest),
    digest,
    observed_at: observedAt,
    deleted: args.deleted ?? false,
    values,
    source_receipt: args.receipt ?? {},
  };
}
