import { sha256 } from "../runtime/canonical.ts";
import type { CompiledCompanyTool } from "../companyos-builder/types.ts";
import type { CompanyToolContract } from "../tool-sdk/contracts.ts";

const create = (contract: CompanyToolContract, source: string): CompiledCompanyTool => {
  return { contract, compiledSource: source, sourceDigest: sha256(source) };
};

const searchSource = `import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({
  async execute(input, context) {
    return await context.capabilities.call("knowledge.search", input);
  }
});`;

const getSource = `import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({
  async execute(input, context) {
    return await context.capabilities.call("knowledge.get", input);
  }
});`;

const traverseSource = `import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({
  async execute(input, context) {
    return await context.capabilities.call("knowledge.traverse", input);
  }
});`;

export const STANDARD_KNOWLEDGE_TOOLS: readonly CompiledCompanyTool[] = [
  create({
    grantId: "oregano:knowledge/search",
    runtimeId: "oregano:knowledge/search",
    agentId: "*",
    toolId: "knowledge-search",
    version: "3.0.0",
    description: "Search active Company Knowledge and return cited evidence.",
    risk: "R0",
    dataClass: "business",
    idempotency: "input-hash",
    capabilities: ["knowledge.search"],
    inputSchema: { type: "object", required: ["query"], additionalProperties: false, properties: { query: { type: "string", minLength: 1, maxLength: 1_000 }, limit: { type: "integer", minimum: 1, maximum: 20 }, mode: { type: "string", enum: ["lexical", "hybrid"] } } },
    outputSchema: { type: "object" },
    evidence: ["snapshot_hash", "citations", "gaps"],
    failure: "Return an explicit gap when no active snapshot or cited result exists.",
  }, searchSource),
  create({
    grantId: "oregano:knowledge/get",
    runtimeId: "oregano:knowledge/get",
    agentId: "*",
    toolId: "knowledge-get",
    version: "3.0.0",
    description: "Fetch one exact OKF document by its Handbook-relative path.",
    risk: "R0",
    dataClass: "business",
    idempotency: "input-hash",
    capabilities: ["knowledge.get"],
    inputSchema: { type: "object", required: ["path"], additionalProperties: false, properties: { path: { type: "string", minLength: 1, maxLength: 1_000 } } },
    outputSchema: { type: "object" },
    evidence: ["snapshot_hash", "path", "found"],
    failure: "Return found=false without widening the requested identity.",
  }, getSource),
  create({
    grantId: "oregano:knowledge/traverse",
    runtimeId: "oregano:knowledge/traverse",
    agentId: "*",
    toolId: "knowledge-traverse",
    version: "3.0.0",
    description: "Traverse bounded links in the active OKF graph.",
    risk: "R0",
    dataClass: "business",
    idempotency: "input-hash",
    capabilities: ["knowledge.traverse"],
    inputSchema: { type: "object", required: ["path"], additionalProperties: false, properties: { path: { type: "string", minLength: 1, maxLength: 1_000 }, direction: { type: "string", enum: ["outbound", "inbound", "both"] }, max_depth: { type: "integer", minimum: 0, maximum: 5 }, max_nodes: { type: "integer", minimum: 1, maximum: 100 } } },
    outputSchema: { type: "object" },
    evidence: ["snapshot_hash", "start_path", "node_count", "truncated"],
    failure: "Return an explicit gap for an unknown path and never exceed traversal bounds.",
  }, traverseSource),
] as const;
