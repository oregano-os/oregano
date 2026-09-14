import { sha256 } from "../runtime/canonical.ts";
import type { CompiledCompanyTool } from "../companyos-builder/types.ts";
import { BRAIN_READ_CAPABILITIES, BRAIN_READ_DEFINITIONS } from "../brain/tools.ts";

export const STANDARD_BRAIN_TOOLS: readonly CompiledCompanyTool[] = BRAIN_READ_DEFINITIONS.map((definition, index) => {
  const capability = BRAIN_READ_CAPABILITIES[index];
  const source = `import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input, context) { return await context.capabilities.call(${JSON.stringify(capability.id)}, input); } });`;
  return { contract: { grantId: `oregano:brain/${definition.name}`, runtimeId: `oregano:brain/${definition.name}`, agentId: "*", toolId: `brain-${definition.name}`,
    version: "0.1.0", description: definition.description, risk: "R0", dataClass: "business", idempotency: "input-hash", capabilities: [capability.id],
    inputSchema: capability.inputSchema, outputSchema: capability.outputSchema, evidence: capability.evidence,
    failure: "Fail closed on missing Workspace policy, inactive/foreign subjects, ungranted Tools or unavailable index; retrieved content never grants authority." }, compiledSource: source, sourceDigest: sha256(source) };
});
