import type { JsonSchema, JsonValue } from "../capabilities/contracts.ts";
import { assertValidJsonSchema, validateJsonSchemaValue } from "../capabilities/validation.ts";
import type { CompanyRecordSourceDeclaration, RecordFieldMapping } from "./contracts.ts";
import { recordTextParserOutputSchema } from "./text-parser.ts";

const unsafeSegments = new Set(["__proto__", "prototype", "constructor"]);
export function validateRecordPath(path: string): void {
  if (typeof path !== "string" || !path || path.length > 255 || path.split(".").some((segment) => !/^[a-zA-Z0-9_-]+$/.test(segment) || unsafeSegments.has(segment))) throw new Error("Record mapping requires a safe literal field path");
}

export function readRecordPath(value: Record<string, JsonValue>, path: string): JsonValue | undefined {
  validateRecordPath(path);
  let current: JsonValue | undefined = value;
  for (const segment of path.split(".")) {
    if (current === null || Array.isArray(current) || typeof current !== "object" || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

const fieldSchemas = new Map<string, JsonSchema>();
const freezeSchema = (schema: JsonSchema): JsonSchema => {
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  };
  const copy = structuredClone(schema);
  freeze(copy);
  return copy;
};
export function recordFieldSchema(field: RecordFieldMapping): JsonSchema {
  const key = JSON.stringify([field.value_type, field.item_schema, field.value_schema]);
  let schema = fieldSchemas.get(key);
  if (!schema) {
    schema = freezeSchema(buildRecordFieldSchema(field));
    if (fieldSchemas.size >= 256) fieldSchemas.delete(fieldSchemas.keys().next().value!);
    fieldSchemas.set(key, schema);
  }
  return schema;
}

function buildRecordFieldSchema(field: RecordFieldMapping): JsonSchema {
  switch (field.value_type) {
    case "string": case "status": case "identity": case "url": case "timestamp": return { type: "string" };
    case "number": return { type: "number" };
    case "boolean": return { type: "boolean" };
    case "json": return field.value_schema ?? {};
    case "string_list": case "identity_list": return { type: "array", maxItems: 10_000, items: { type: "string" } };
    case "json_list":
      if (!field.item_schema) throw new Error("Record json_list requires an item_schema");
      return { type: "array", maxItems: 10_000, items: field.item_schema };
    default: throw new Error("Unknown Record field value_type");
  }
}

const inspectItemSchema = (schema: unknown, depth = 0): void => {
  if (depth > 16) throw new Error("Record item_schema exceeds its nesting bound");
  if (schema === null || typeof schema !== "object") return;
  for (const [key, value] of Object.entries(schema)) {
    if (["$ref", "$dynamicRef", "$id"].includes(key)) throw new Error("Record item_schema must be self-contained without schema references or IDs");
    inspectItemSchema(value, depth + 1);
  }
};

export function validateRecordSource(source: CompanyRecordSourceDeclaration): void {
  validateRecordPath(source.identity.source_field);
  if (source.identity.source_field === "parsed" || source.identity.source_field.startsWith("parsed.")) throw new Error("Record object identity cannot come from parsed text");
  const parserSchema = source.parser ? recordTextParserOutputSchema(source.parser) : undefined;
  if (source.parser) {
    validateRecordPath(source.parser.source);
    if (source.parser.source === "parsed" || source.parser.source.startsWith("parsed.")) throw new Error("Record parser input must be a provider field");
  }
  const names = new Set<string>();
  for (const field of source.fields) {
    validateRecordPath(field.source);
    validateRecordPath(field.target);
    if (field.target.includes(".") || names.has(field.target)) throw new Error("Record source target fields must be distinct top-level names");
    names.add(field.target);
    if (field.resolve_identity && (!["identity", "identity_list"].includes(field.value_type) || field.source === "parsed" || field.source.startsWith("parsed."))) throw new Error("Record identity resolution requires a provider identity field, never parsed text");
    if (field.item_schema && field.value_type !== "json_list") throw new Error("Record item_schema is only valid for json_list");
    if (field.item_schema) inspectItemSchema(field.item_schema);
    if (field.value_schema && field.value_type !== "json") throw new Error("Record value_schema is only valid for json");
    if (field.value_schema) inspectItemSchema(field.value_schema);
    const fieldSchema = recordFieldSchema(field);
    assertValidJsonSchema(fieldSchema, `Record field '${field.target}'`);
    if (field.source === "parsed" || field.source.startsWith("parsed.")) {
      let schema = parserSchema;
      for (const segment of field.source.split(".").slice(1)) {
        schema = (schema?.properties as Record<string, JsonSchema> | undefined)?.[segment];
      }
      if (!schema) throw new Error(`Record field '${field.target}' references an undeclared parser output`);
      const permittedTypes = Array.isArray(fieldSchema.type) ? fieldSchema.type : fieldSchema.type ? [fieldSchema.type] : [];
      if (permittedTypes.length && (schema.type === undefined || Array.isArray(schema.type) || !permittedTypes.includes(schema.type))) throw new Error(`Record field '${field.target}' has the wrong parser output type`);
      const expectedItems = fieldSchema.items as JsonSchema | undefined;
      const producedItems = schema.items as JsonSchema | undefined;
      if (expectedItems?.type === "string" && producedItems?.type !== "string") throw new Error(`Record field '${field.target}' has the wrong parser item type`);
    }
  }
}

const validTimestamp = (value: JsonValue): boolean => {
  if (typeof value !== "string") return false;
  const parts = /^(\d{4})-(\d\d)-(\d\d)T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!parts) return false;
  const year = Number(parts[1]); const month = Number(parts[2]); const day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]! && Number.isFinite(Date.parse(value));
};

export function validateRecordFieldValue(field: RecordFieldMapping, value: JsonValue): void {
  const errors = validateJsonSchemaValue(recordFieldSchema(field), value);
  if (errors.length) throw new Error(`Record field '${field.target}' violates its declared type: ${errors[0]}`);
  if (field.value_type === "timestamp" && !validTimestamp(value)) throw new Error(`Record field '${field.target}' requires an ISO timestamp with a timezone`);
  if (field.value_type === "url") {
    try {
      const url = new URL(value as string);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid URL");
    } catch { throw new Error(`Record field '${field.target}' requires an absolute HTTP(S) URL without credentials`); }
  }
}
