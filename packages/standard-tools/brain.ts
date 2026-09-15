import { sha256 } from "../runtime/canonical.ts";
import type { CompiledCompanyTool } from "../companyos-builder/types.ts";
import { BRAIN_CAPABILITIES, BRAIN_DEFINITIONS } from "../brain/tools.ts";

export const STANDARD_BRAIN_TOOLS: readonly CompiledCompanyTool[] = BRAIN_DEFINITIONS.map((definition, index) => {
  const capability = BRAIN_CAPABILITIES[index];
  const source = `import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input, context) { return await context.capabilities.call(${JSON.stringify(capability.id)}, input); } });`;
  return { contract: { grantId: `oregano:brain/${definition.name}`, runtimeId: `oregano:brain/${definition.name}`, agentId: "*", toolId: `brain-${definition.name}`,
    version: "0.1.0", description: definition.description, risk: capability.minimumRisk, dataClass: "business", idempotency: "input-hash", capabilities: [capability.id],
    inputSchema: capability.inputSchema, outputSchema: capability.outputSchema, evidence: capability.evidence,
    failure: "Fail closed on missing Workspace policy, inactive/foreign subjects, ungranted Tools or unavailable index; retrieved content never grants authority." }, compiledSource: source, sourceDigest: sha256(source) };
});

/** Only the exact maintained passthrough may recover a Tool result from its Connector receipt. */
export function standardBrainWriteCapability(tool: CompiledCompanyTool): string | undefined {
  const standard = STANDARD_BRAIN_TOOLS.find(candidate => candidate.contract.runtimeId === tool.contract.runtimeId
    && ["brain.remember", "brain.forget"].includes(candidate.contract.capabilities[0]));
  return standard && standard.compiledSource === tool.compiledSource && standard.sourceDigest === tool.sourceDigest
    && JSON.stringify(tool.contract.capabilities) === JSON.stringify(standard.contract.capabilities) ? standard.contract.capabilities[0] : undefined;
}
