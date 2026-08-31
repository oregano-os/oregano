import { sha256 } from "../runtime/canonical.ts";
import type { CompiledCompanyTool } from "../companyos-builder/types.ts";
import type { CompanyToolContract } from "../tool-sdk/contracts.ts";

const source = `import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({
  async execute(input, context) {
    return await context.capabilities.call("records.query", input);
  }
});`;

const contract: CompanyToolContract = {
  grantId: "oregano:records/query",
  runtimeId: "oregano:records/query",
  agentId: "*",
  toolId: "records-query",
  version: "1.0.0",
  description: "Query one access-scoped Company Records projection.",
  risk: "R0",
  dataClass: "business",
  idempotency: "input-hash",
  capabilities: ["records.query"],
  inputSchema: { type: "object", required: ["projection_id"], additionalProperties: false, properties: { projection_id: { type: "string", minLength: 1, maxLength: 63 }, filters: { type: "object" }, limit: { type: "integer", minimum: 1, maximum: 200 }, cursor: { type: "string", minLength: 1, maxLength: 1_000 } } },
  outputSchema: { type: "object" },
  evidence: ["projection_id", "row_count", "observed_at", "fresh_until", "access_decision"],
  failure: "Fail closed when the subject or projection grant is unavailable; never expose SQL or provider credentials.",
};

export const STANDARD_RECORDS_TOOLS: readonly CompiledCompanyTool[] = [{ contract, compiledSource: source, sourceDigest: sha256(source) }];
