import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonSchema } from "../../capabilities/contracts.ts";
import { validateJsonSchemaValue } from "../../capabilities/validation.ts";

test("Tool and Capability values are enforced by JSON Schema", () => {
  const schema = {
    type: "object" as const,
    additionalProperties: false,
    required: ["assets", "budget"],
    properties: {
      assets: { type: "array" as const, minItems: 1, items: { type: "string" as const, minLength: 1 } },
      budget: { type: "number" as const, minimum: 1, maximum: 1000 },
    },
  };
  assert.deepEqual(validateJsonSchemaValue(schema, { assets: ["creative-a"], budget: 50 }), []);
  const errors = validateJsonSchemaValue(schema, { assets: [], budget: 0, provider_token: "forbidden" });
  assert.ok(errors.some((error) => error.includes("assets") && error.includes("fewer than 1")));
  assert.ok(errors.some((error) => error.includes("budget") && error.includes(">= 1")));
  assert.ok(errors.some((error) => error.includes("provider_token") && error.includes("not allowed")));
});

test("invalid JSON Schemas fail closed during compilation", () => {
  assert.throws(
    () => validateJsonSchemaValue({ type: "definitely-not-a-json-schema-type" } as unknown as JsonSchema, {}),
    /schema is invalid|must be equal to one of the allowed values/,
  );
});
