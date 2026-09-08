import type { JsonSchema } from "../capabilities/contracts.ts";

const text: JsonSchema = { type: "string" };
const texts: JsonSchema = { type: "array", items: text };
export const DIRECTORY_QUERY_INPUT_SCHEMA: JsonSchema = { type: "object", additionalProperties: false, properties: {} };
export const DIRECTORY_QUERY_OUTPUT_SCHEMA: JsonSchema = {
  type: "object", additionalProperties: false, required: ["directory_digest", "members"],
  properties: {
    directory_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    members: { type: "array", maxItems: 1_000, items: {
      type: "object", additionalProperties: false,
      required: ["member_id", "display_name", "type", "status", "group_ids", "principals"],
      properties: {
        member_id: { type: ["string", "null"] }, display_name: text, type: text, status: text,
        group_ids: texts, principals: texts,
      },
    } },
  },
};
