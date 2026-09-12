import type { CompiledWorkflowStep } from "../../companyos-builder/workflow-types.ts";
import type { JsonValue } from "../../capabilities/contracts.ts";

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
