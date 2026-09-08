import { sha256 } from "../runtime/canonical.ts";
import type { CompiledCompanyTool } from "../companyos-builder/types.ts";
import type { CompanyToolContract } from "../tool-sdk/contracts.ts";
import { RECORD_QUERY_INPUT_SCHEMA, RECORD_QUERY_OUTPUT_SCHEMA } from "../records/query-schema.ts";

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
  version: "2.0.0",
  description: "Query one access-scoped Company Records projection.",
  risk: "R0",
  dataClass: "business",
  idempotency: "input-hash",
  capabilities: ["records.query"],
  inputSchema: RECORD_QUERY_INPUT_SCHEMA,
  outputSchema: RECORD_QUERY_OUTPUT_SCHEMA,
  evidence: ["projection_id", "row_count", "observed_at", "fresh_until", "snapshot_id", "source_proofs", "access_decision"],
  failure: "Fail closed when the subject or projection grant is unavailable; never expose SQL or provider credentials.",
};

export const STANDARD_RECORDS_TOOLS: readonly CompiledCompanyTool[] = [{ contract, compiledSource: source, sourceDigest: sha256(source) }];
