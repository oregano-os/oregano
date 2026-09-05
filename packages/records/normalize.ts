import type { JsonValue } from "../capabilities/contracts.ts";
import type { CompanyRecordSourceDeclaration, RecordObjectVersion } from "./contracts.ts";
import { recordDigest, recordVersionId } from "./identity.ts";
import { readRecordPath, validateRecordFieldValue, validateRecordSource } from "./source-validation.ts";
import { parseRecordText } from "./text-parser.ts";
import type { RecordIdentityDirectory } from "./identity-directory.ts";

export function normalizeRecordObject(args: {
  instanceId: string;
  source: CompanyRecordSourceDeclaration;
  raw: Record<string, JsonValue>;
  observedAt: string;
  deleted?: boolean;
  receipt?: Record<string, JsonValue>;
  identities?: RecordIdentityDirectory;
}): RecordObjectVersion {
  const { instanceId, source, raw, observedAt } = args;
  validateRecordSource(source);
  if (source.fields.some((field) => field.resolve_identity) && !args.identities) throw new Error(`Record source '${source.id}' requires a frozen roster identity directory`);
  const objectId = readRecordPath(raw, source.identity.source_field);
  if (typeof objectId !== "string" && typeof objectId !== "number") throw new Error(`Record source '${source.id}' did not yield a scalar object identity`);
  if (objectId === "" || (typeof objectId === "number" && !Number.isFinite(objectId))) throw new Error(`Record source '${source.id}' yielded an invalid object identity`);
  const input = source.parser ? { ...raw, parsed: parseRecordText(source.parser, readRecordPath(raw, source.parser.source)) } : raw;
  const values: Record<string, JsonValue> = {};
  for (const field of source.fields) {
    const value = readRecordPath(input, field.source);
    if (value === undefined || value === null) {
      if (field.required) throw new Error(`Record source '${source.id}' is missing required field '${field.target}'`);
      continue;
    }
    validateRecordFieldValue(field, value);
    if (field.resolve_identity) {
      if (!args.identities) throw new Error(`Record source '${source.id}' requires a frozen roster identity directory`);
      values[field.target] = Array.isArray(value)
        ? value.map((principal) => args.identities!.resolve(principal as string))
        : args.identities.resolve(value as string);
    } else values[field.target] = structuredClone(value);
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
    source_receipt: {
      ...args.receipt,
      ...(source.fields.some((field) => field.resolve_identity) ? { identity_directory_digest: args.identities!.digest } : {}),
    },
  };
}
