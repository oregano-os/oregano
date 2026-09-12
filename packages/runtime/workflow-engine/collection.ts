import type { CompiledWorkflowStep } from "../../companyos-builder/workflow-types.ts";
import type { JsonValue } from "../../capabilities/contracts.ts";
import type { CompanyOSArtifact } from "../../companyos-builder/types.ts";
import { validateJsonSchemaValue } from "../../capabilities/validation.ts";
import { executeIsolatedCompanyTool } from "../../tool-sdk/isolated-runner.ts";
import { sha256 } from "../canonical.ts";

/** Business feedback stays inside the Agent turn; it is not a workflow failure. */
export class CollectionNeedsInput extends Error {
  readonly feedback: string;
  constructor(feedback: string) { super("Collection needs further conversation"); this.feedback = feedback; }
}

/** Called only after the engine verifies the current human, assignment and lease. */
export async function validateCollectionCandidate(args: {
  artifact: CompanyOSArtifact; agentId: string; runId: string; step: CompiledWorkflowStep;
  context: JsonValue; facts: JsonValue;
}): Promise<void> {
  const selected = args.step.collect?.validator;
  if (!selected) return;
  const agent = args.artifact.agents.find(a => a.id === args.agentId);
  const grant = agent?.toolSet.tools.find(t => t.grantId === selected.grantId);
  const tool = agent?.tools.find(t => t.contract.runtimeId === selected.runtimeId);
  if (!selected.grantId.startsWith("company:") || !grant || !tool || grant.runtimeId !== selected.runtimeId
    || selected.risk !== "R0" || grant.risk !== "R0" || tool.contract.risk !== "R0" || tool.contract.capabilities.length
    || selected.contractDigest !== sha256(tool.contract) || grant.contractDigest !== selected.contractDigest
    || selected.version !== tool.contract.version || grant.version !== selected.version)
    throw new Error("Collection validator differs from its pinned pure Tool grant");
  const input = { context: args.context, facts: args.facts };
  if (validateJsonSchemaValue(tool.contract.inputSchema, input).length) throw new Error("Collection validator input violates its contract");
  const result = await executeIsolatedCompanyTool({
    compiledSource: tool.compiledSource, input,
    context: { instanceId: args.artifact.instance.id, runId: args.runId, stepId: args.step.id, agentId: args.agentId, toolId: selected.runtimeId },
    allowedCapabilities: [], invokeCapability: async () => { throw new Error("Collection validation cannot invoke capabilities"); },
  });
  if (validateJsonSchemaValue(tool.contract.outputSchema, result).length || !result || typeof result !== "object" || Array.isArray(result))
    throw new Error("Collection validator output violates its contract");
  const value = result as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "accepted,feedback" || typeof value.accepted !== "boolean"
    || typeof value.feedback !== "string" || value.feedback.length > 2000 || (!value.accepted && !value.feedback.trim()))
    throw new Error("Collection validator must return bounded accepted/feedback data");
  if (!value.accepted) throw new CollectionNeedsInput(value.feedback);
}

export const COLLECTION_TOOL_DESCRIPTION = "Finish the current conversation step by submitting ALL complete discussed facts. This immediately advances the workflow and closes this question; it is NOT a tool for saving partial notes. If any required answer, clarification, or Workspace-required preview agreement is still missing, ask the person and DO NOT call this tool. Keep partial facts in conversation history. Never fill unanswered fields with placeholders such as not yet asked, pending, or a made-up answer. This does not approve or write any external change.";

/** Flat, bounded facts are data. They cannot name Tools, targets or decisions. */
export function collectionSchema(fields: readonly string[]) {
  return { type: "object" as const, additionalProperties: false, required: [...fields],
    properties: Object.fromEntries(fields.map((field) => [field, { type: "string" as const, minLength: 1, maxLength: 4000 }])) };
}
export function validateCollection(step: CompiledWorkflowStep, value: unknown): asserts value is Record<string, string> {
  const fields = step.collect?.fields;
  if (!fields || !value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.length || Object.keys(value).some((key) => !fields.includes(key))
    || fields.some((key) => !Object.hasOwn(value, key) || typeof (value as Record<string, JsonValue>)[key] !== "string"
      || !(value as Record<string, string>)[key]!.trim() || (value as Record<string, string>)[key]!.length > 4000)) throw new Error("Collected facts must contain exactly the declared nonempty bounded fields");
}
