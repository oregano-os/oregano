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
