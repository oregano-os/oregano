import { attachmentParts } from "../../../runtime/attachments.ts";
import { attachmentPolicy } from "../../../runner/attachment-policy.ts";
import { generateText } from "ai";
import type { LanguageGenerator } from "../../../language/contracts.ts";
import { LANGUAGE_SYSTEM_PREFIX } from "../../../language/contracts.ts";
import { modelExecutionEvidence, resolveModelExecution } from "./model-execution.ts";

/** Resolve a trusted phase binding or the existing owning-Agent default. */
export function createLanguageGenerator(dependencies: {
 resolve: typeof resolveModelExecution;
 generate: typeof generateText;
 reportIncomplete?: (diagnostic: Record<string, unknown>) => void;
} = { resolve: resolveModelExecution, generate: generateText }): LanguageGenerator {
 return async (request) => {
  const execution = dependencies.resolve({ profile: request.modelProfile ?? "agent", task: request.modelTask, requiredCapability: "language" });
  const result = await dependencies.generate({
    model: execution.model,
    system: LANGUAGE_SYSTEM_PREFIX + request.instructions,
    messages: [{ role: "user", content: request.attachments?.length ? [{ type: "text", text: request.data }, ...attachmentParts(request.attachments, attachmentPolicy(execution.selection))] : request.data }],
    // Explicit portable effort keeps provider defaults from consuming the
    // bounded call's output budget before any answer text is produced.
    reasoning: "low",
    maxOutputTokens: Math.min(execution.selection.maxOutputTokens ?? 2_500, 4_000),
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(Math.min(execution.selection.timeoutMs ?? 55_000, 55_000)),
  });
  if (result.finishReason !== "stop" || !result.text.trim()) {
    const diagnostic = { event: "language.generation-incomplete", model: execution.selection.model,
      route: execution.selection.route, reasoning: "low", finish_reason: result.finishReason,
      input_tokens: result.usage?.inputTokens ?? null, output_tokens: result.usage?.outputTokens ?? null,
      text_characters: result.text.length, reasoning_characters: result.reasoningText?.length ?? 0 };
    (dependencies.reportIncomplete ?? ((event) => console.warn(JSON.stringify(event))))(diagnostic);
    throw new Error("Language generation did not complete; no successful text was produced");
  }
  return { text: result.text.trim(), evidence: { model_execution: modelExecutionEvidence(execution.selection, result), finish_reason: result.finishReason, reasoning: "low" } };
 };
}
export const generateLanguage = createLanguageGenerator();
