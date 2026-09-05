import type { JsonValue } from "../capabilities/contracts.ts";
import { sha256 } from "../runtime/canonical.ts";

export interface DerivedRecordReference {
  relation: string;
  record_type: string;
  record_id: string;
  source_version_id?: string;
}

/** Generic envelope; business meaning and payload validation stay in a Domain. */
export interface DerivedRecordEnvelope<Payload extends JsonValue = JsonValue> {
  schema_version: 1;
  domain: string;
  type: string;
  record_id: string;
  occurred_at: string;
  subject_id?: string;
  source: {
    projection_id: string;
    record_id: string;
    source_version_id: string;
  };
  references: DerivedRecordReference[];
  payload: Payload;
  digest: string;
}

const identifier = /^[a-z][a-z0-9-]{1,62}$/;
const text = (value: string, label: string, maximum = 255): void => {
  if (!value || value.length > maximum) throw new Error(`${label} must contain 1 to ${maximum} characters`);
};
const exactIso = (value: string, label: string): void => {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${label} must be an exact ISO timestamp`);
};

export function createDerivedRecord<Payload extends JsonValue>(args: Omit<DerivedRecordEnvelope<Payload>, "schema_version" | "digest">): DerivedRecordEnvelope<Payload> {
  if (!identifier.test(args.domain)) throw new Error("Derived Record domain is invalid");
  if (!identifier.test(args.type)) throw new Error("Derived Record type is invalid");
  text(args.record_id, "Derived Record id");
  exactIso(args.occurred_at, "Derived Record occurred_at");
  if (args.subject_id !== undefined) text(args.subject_id, "Derived Record subject id");
  text(args.source.projection_id, "Derived Record source projection id", 127);
  text(args.source.record_id, "Derived Record source record id");
  text(args.source.source_version_id, "Derived Record source version id");
  if (args.references.length > 1_000) throw new Error("Derived Record references exceed the supported limit");
  const identities = new Set<string>();
  for (const reference of args.references) {
    text(reference.relation, "Derived Record reference relation", 127);
    text(reference.record_type, "Derived Record reference type", 127);
    text(reference.record_id, "Derived Record reference id");
    if (reference.source_version_id !== undefined) text(reference.source_version_id, "Derived Record reference source version id");
    const identity = `${reference.relation}\0${reference.record_type}\0${reference.record_id}`;
    if (identities.has(identity)) throw new Error("Derived Record references must be unique");
    identities.add(identity);
  }
  const value = { schema_version: 1 as const, ...structuredClone(args) };
  return { ...value, digest: sha256(value) };
}
