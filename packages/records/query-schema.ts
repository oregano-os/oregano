import type { JsonSchema } from "../capabilities/contracts.ts";

const text: JsonSchema = { type: "string" };
const instant: JsonSchema = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$" };
const object = (required: string[], properties: Record<string, JsonSchema>): JsonSchema => ({ type: "object", required, additionalProperties: false, properties });

export const RECORD_QUERY_INPUT_SCHEMA = object(["projection_id"], {
  projection_id: { type: "string", minLength: 1, maxLength: 63 },
  filters: { type: "object", maxProperties: 100 },
  limit: { type: "integer", minimum: 1, maximum: 200 },
  cursor: { type: "string", minLength: 1, maxLength: 1_000 },
  all_pages: { type: "boolean" },
  require_synced_through: instant,
});

export const RECORD_QUERY_OUTPUT_SCHEMA = object(["projection_id", "rows", "observed_at", "fresh_until", "access_decision", "snapshot_id", "source_proofs"], {
  projection_id: text,
  rows: { type: "array", maxItems: 10_000, items: object(["instance_id", "projection_id", "record_id", "record_type", "source_version_id", "projected_at", "values"], {
    instance_id: text, projection_id: text, record_id: text, record_type: text, source_version_id: text, projected_at: instant, values: { type: "object" },
  }) },
  next_cursor: text,
  observed_at: instant,
  fresh_until: instant,
  snapshot_id: { type: "string", pattern: "^[a-f0-9]{64}$" },
  synced_through: instant,
  source_proofs: { type: "array", items: object(["source_id", "source_digest", "run_id", "synced_through", "watermark"], {
    source_id: text, source_digest: text, run_id: text, synced_through: instant, watermark: text,
  }) },
  access_decision: object(["allowed", "projection_id", "principal_id", "policy_digest", "reason", "decided_at"], {
    allowed: { type: "boolean" }, projection_id: text, principal_id: text, policy_digest: text,
    reason: { type: "string", enum: ["group-allowed", "role-allowed", "no-matching-grant", "inactive-subject"] }, decided_at: instant,
  }),
});
