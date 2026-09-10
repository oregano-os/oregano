import { generateText, jsonSchema, Output } from "ai";
import { BUILDER_TURN_INTENT_INSTRUCTIONS, BUILDER_TURN_INTENT_SCHEMA, resolveBuilderTurnIntent, type BuilderIntakeInput } from "../../../../runtime/builder/turn-intent.ts";
import { modelExecutionEvidence, resolveModelExecution } from "../model-execution.ts";
import type { ModelExecutionEvidence } from "../../../../runner/model-execution.ts";

/** Shared by live chat and the protected, synthetic deployed intake qualification. */
export async function classifyBuilderTurn(input: BuilderIntakeInput, signal?: AbortSignal) {
  const executions: ModelExecutionEvidence[] = [];
  const outcome = await resolveBuilderTurnIntent({ input, signal, classify: async current => {
    const resolved = resolveModelExecution({ profile: "utility", task: "builder.turn-intent", requiredCapability: "structured-output" });
    const timeout = AbortSignal.timeout(resolved.selection.timeoutMs ?? 30_000);
    const result = await generateText({ model: resolved.model, system: BUILDER_TURN_INTENT_INSTRUCTIONS,
      prompt: JSON.stringify(current), output: Output.object({ schema: jsonSchema(JSON.parse(JSON.stringify(BUILDER_TURN_INTENT_SCHEMA))) }),
      maxOutputTokens: resolved.selection.maxOutputTokens ?? 2048, maxRetries: 0,
      abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    executions.push(modelExecutionEvidence(resolved.selection, result));
    return result.output;
  } });
  return { ...outcome, executions };
}
