import type { CapabilityContract, JsonSchema } from "./contracts.ts";

const object = (required: string[], properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object" as const,
  required,
  additionalProperties: false,
  properties,
});

/**
 * The maintained seed catalog. These contracts are provider-neutral and are
 * intentionally smaller than any provider SDK. Additions are Core changes.
 */
export const CORE_CAPABILITY_CATALOG: readonly CapabilityContract[] = [
  {
    id: "knowledge.search",
    version: "3.0.0",
    description: "Search the active Company Knowledge snapshot and return bounded cited evidence.",
    mode: "read",
    minimumRisk: "R0",
    inputSchema: object(["query"], {
      query: { type: "string", minLength: 1, maxLength: 1_000 },
      limit: { type: "integer", minimum: 1, maximum: 20 },
      mode: { type: "string", enum: ["lexical", "hybrid"] },
    }),
    outputSchema: object(["query", "snapshot_hash", "hits", "gaps", "mode", "degradations"], {
      query: { type: "string" },
      snapshot_hash: { type: ["string", "null"] },
      hits: {
        type: "array",
        maxItems: 20,
        items: object(["score", "excerpt", "signals", "citation"], {
          score: { type: "number" },
          excerpt: { type: "string" },
          signals: { type: "array", items: { type: "string", enum: ["stale", "contested"] } },
          lexical_rank: { type: "integer", minimum: 1 },
          semantic_rank: { type: "integer", minimum: 1 },
          citation: object(["snapshot_hash", "path", "fragment_id", "heading", "start_line", "end_line", "digest"], {
            snapshot_hash: { type: "string" },
            path: { type: "string" },
            fragment_id: { type: "string" },
            heading: { type: "string" },
            start_line: { type: "integer" },
            end_line: { type: "integer" },
            digest: { type: "string" },
          }),
        }),
      },
      gaps: { type: "array", items: { type: "string", enum: ["no-active-snapshot", "no-results"] } },
      mode: { type: "string", enum: ["lexical", "hybrid"] },
      degradations: { type: "array", items: { type: "string", enum: ["embedding-disabled", "embedding-unavailable", "vector-index-unavailable"] } },
    }),
    idempotency: "none",
    evidence: ["snapshot_hash", "result_count", "connector"],
  },
  {
    id: "knowledge.get",
    version: "3.0.0",
    description: "Fetch one exact OKF document from the active Company Knowledge snapshot.",
    mode: "read",
    minimumRisk: "R0",
    inputSchema: object(["path"], {
      path: { type: "string", minLength: 1, maxLength: 1_000 },
    }),
    outputSchema: object(["found"], {
      found: { type: "boolean" },
      snapshot_hash: { type: "string" },
      document: { type: "object" },
    }),
    idempotency: "none",
    evidence: ["snapshot_hash", "path", "found", "connector"],
  },
  {
    id: "knowledge.traverse",
    version: "3.0.0",
    description: "Traverse bounded inbound or outbound OKF links from one exact document path.",
    mode: "read",
    minimumRisk: "R0",
    inputSchema: object(["path"], {
      path: { type: "string", minLength: 1, maxLength: 1_000 },
      direction: { type: "string", enum: ["outbound", "inbound", "both"] },
      max_depth: { type: "integer", minimum: 0, maximum: 5 },
      max_nodes: { type: "integer", minimum: 1, maximum: 100 },
    }),
    outputSchema: object(["snapshot_hash", "start_path", "direction", "paths", "truncated", "gaps"], {
      snapshot_hash: { type: ["string", "null"] },
      start_path: { type: "string" },
      direction: { type: "string", enum: ["outbound", "inbound", "both"] },
      paths: { type: "array", maxItems: 100, items: { type: "object" } },
      truncated: { type: "boolean" },
      gaps: { type: "array", items: { type: "string", enum: ["no-active-snapshot", "unknown-start-path"] } },
    }),
    idempotency: "none",
    evidence: ["snapshot_hash", "start_path", "node_count", "truncated", "connector"],
  },
  {
    id: "artifact.publish",
    version: "1.0.0",
    description: "Publish one immutable content artifact and return its address.",
    mode: "effect",
    minimumRisk: "R3",
    inputSchema: object(["artifact_id", "content", "content_type"], {
      artifact_id: { type: "string", minLength: 1 },
      content: { type: "string" },
      content_type: { type: "string", minLength: 1 },
    }),
    outputSchema: object(["artifact_id", "url", "digest"], {
      artifact_id: { type: "string" },
      url: { type: "string" },
      digest: { type: "string" },
    }),
    idempotency: "required",
    evidence: ["artifact_id", "url", "digest", "connector"],
  },
  {
    id: "marketing-campaign.launch",
    version: "1.0.0",
    description: "Launch a bounded marketing campaign from approved assets and spend limits.",
    mode: "effect",
    minimumRisk: "R4",
    inputSchema: object(["campaign_key", "daily_budget", "days", "assets"], {
      campaign_key: { type: "string", minLength: 1 },
      daily_budget: { type: "number", minimum: 0 },
      days: { type: "integer", minimum: 1 },
      assets: { type: "array", items: { type: "string" } },
    }),
    outputSchema: object(["campaign_id", "status", "max_spend", "simulated"], {
      campaign_id: { type: "string" },
      status: { type: "string" },
      max_spend: { type: "number" },
      simulated: { type: "boolean" },
    }),
    idempotency: "required",
    evidence: ["campaign_id", "status", "max_spend", "simulated", "connector"],
  },
  {
    id: "marketing-campaign.read-report",
    version: "1.0.0",
    description: "Read normalized campaign delivery and conversion facts.",
    mode: "read",
    minimumRisk: "R0",
    inputSchema: object(["campaign_key"], {
      campaign_key: { type: "string", minLength: 1 },
    }),
    outputSchema: { type: "object" },
    idempotency: "none",
    evidence: ["campaign_id", "observed_at", "connector"],
  },
  {
    id: "marketing-campaign.stop-asset",
    version: "1.0.0",
    description: "Stop one campaign asset without increasing the approved maximum spend.",
    mode: "effect",
    minimumRisk: "R2",
    inputSchema: object(["campaign_key", "asset"], {
      campaign_key: { type: "string", minLength: 1 },
      asset: { type: "string", minLength: 1 },
    }),
    outputSchema: { type: "object" },
    idempotency: "required",
    evidence: ["campaign_id", "stopped_asset", "max_spend", "connector"],
  },
  {
    id: "conversion.record",
    version: "1.0.0",
    description: "Record a conversion attributed to one campaign asset.",
    mode: "effect",
    minimumRisk: "R0",
    inputSchema: object(["campaign_key", "asset", "conversion_id"], {
      campaign_key: { type: "string", minLength: 1 },
      asset: { type: "string", minLength: 1 },
      conversion_id: { type: "string", minLength: 1 },
    }),
    outputSchema: { type: "object" },
    idempotency: "required",
    evidence: ["conversion_id", "recorded", "connector"],
  },
] as const;
