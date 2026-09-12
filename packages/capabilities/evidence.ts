import type { JsonSchema } from "./contracts.ts";

const text = { type: "string", minLength: 1, maxLength: 255 } as const;
export const EVIDENCE_QUERY_INPUT: JsonSchema = {
  type: "object", additionalProperties: false,
  required: ["kind", "references", "from", "to"],
  properties: {
    kind: { type: "string", enum: ["workflows", "records", "context"] },
    references: { type: "array", minItems: 1, maxItems: 10, uniqueItems: true, items: text },
    from: { ...text, format: "date-time" }, to: { ...text, format: "date-time" },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    step_ids: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: text },
    include_linked_builds: { type: "boolean" },
  },
};
export const EVIDENCE_QUERY_OUTPUT: JsonSchema = {
  type: "object", additionalProperties: false,
  required: ["items", "coverage", "artifact_hash"],
  properties: {
    artifact_hash: text,
    items: { type: "array", maxItems: 100, items: { type: "object" } },
    coverage: { type: "object", additionalProperties: false,
      required: ["from", "to", "observed_at", "complete", "limitations"],
      properties: { from: text, to: text, observed_at: text, complete: { type: "boolean" },
        limitations: { type: "array", items: text } } },
  },
};

/** Reviewed technical read grants. Domain event meanings remain in Company Tools. */
export interface EvidenceScope {
  agent_id: string;
  /** null explicitly permits a non-workflow Tool invocation, never any workflow. */
  workflow_id: string | null;
  read_groups: string[];
  workflow_ids: string[];
  source_ids: string[];
  paths: string[];
  max_history_days: number;
}
export interface EvidenceQuery {
  kind: "workflows" | "records" | "context";
  references: string[];
  from: string;
  to: string;
  limit?: number;
  step_ids?: string[];
  include_linked_builds?: boolean;
}
