import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { JsonSchema } from "./contracts.ts";

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: false,
});

const cache = new WeakMap<JsonSchema, ValidateFunction>();
const cacheById = new Map<string, { serialized: string; validate: ValidateFunction }>();

const validatorFor = (schema: JsonSchema): ValidateFunction => {
  const existing = cache.get(schema);
  if (existing) return existing;
  const id = typeof schema.$id === "string" ? schema.$id : null;
  if (id) {
    const registered = cacheById.get(id);
    if (registered) {
      if (registered.serialized !== JSON.stringify(schema)) throw new Error(`Conflicting JSON Schema declarations use id '${id}'`);
      cache.set(schema, registered.validate);
      return registered.validate;
    }
  }
  const compiled = ajv.compile(schema);
  cache.set(schema, compiled);
  if (id) cacheById.set(id, { serialized: JSON.stringify(schema), validate: compiled });
  return compiled;
};

const describe = (error: ErrorObject): string => {
  const path = error.instancePath ? `$${error.instancePath}` : "$";
  if (error.keyword === "required") {
    return `${path}.${String(error.params.missingProperty)} is required`;
  }
  if (error.keyword === "additionalProperties") {
    return `${path}.${String(error.params.additionalProperty)} is not allowed`;
  }
  return `${path} ${error.message ?? `violates ${error.keyword}`}`;
};

/**
 * Enforce the declared JSON Schema with AJV. Invalid schemas fail during
 * compilation; invalid values return deterministic, human-readable paths.
 */
export function validateJsonSchemaValue(schema: JsonSchema, value: unknown): string[] {
  const validate = validatorFor(schema);
  if (validate(value)) return [];
  return (validate.errors ?? []).map(describe);
}

export function assertValidJsonSchema(schema: JsonSchema, label: string): void {
  try {
    validatorFor(schema);
  } catch (error) {
    throw new Error(`${label} is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`);
  }
}
