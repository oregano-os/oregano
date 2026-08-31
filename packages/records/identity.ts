import { createHash } from "node:crypto";
import type { JsonValue } from "../capabilities/contracts.ts";

const canonicalize = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])) as JsonValue;
  }
  return value;
};

export function recordDigest(value: JsonValue): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export function recordVersionId(sourceId: string, objectId: string, digest: string): string {
  return createHash("sha256").update(`${sourceId}\0${objectId}\0${digest}`).digest("hex");
}

export function projectionRecordId(projectionId: string, sourceId: string, objectId: string): string {
  return createHash("sha256").update(`${projectionId}\0${sourceId}\0${objectId}`).digest("hex");
}
