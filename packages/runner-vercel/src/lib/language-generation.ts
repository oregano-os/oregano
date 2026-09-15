import { sha256 } from "../../../runtime/canonical.ts";
import { attachmentParts } from "../../../runtime/attachments.ts";
import { attachmentPolicy } from "../../../runner/attachment-policy.ts";
import { generateText } from "ai";
import type { LanguageGenerator } from "../../../language/contracts.ts";
import { languageSystemInstructions, LanguageGenerationError } from "../../../language/contracts.ts";
import { modelExecutionEvidence, resolveModelExecution } from "./model-execution.ts";

/** Resolve a trusted phase binding or the existing owning-Agent default. */
export function createLanguageGenerator(dependencies: {
 resolve: typeof resolveModelExecution;
 generate: typeof generateText;
 reportIncomplete?: (diagnostic: Record<string, unknown>) => void;
} = { resolve: resolveModelExecution, generate: generateText }): LanguageGenerator {
 return async (request) => {
  const execution = dependencies.resolve({ profile: request.modelProfile ?? "agent", task: request.modelTask, requiredCapability: "language" });
  const messages = [{ role: "user" as const, content: request.attachments?.length ? [{ type: "text" as const, text: request.data }, ...attachmentParts(request.attachments, attachmentPolicy(execution.selection))] : request.data }];
  const system = languageSystemInstructions(request.instructions);
  const instructionEvidence = { system_prompt_digest: sha256(system), system_instruction_characters: system.length };
  await request.beforeDispatch?.(execution.selection, instructionEvidence);
  let result;
  try { result = await dependencies.generate({
    model: execution.model,
    system,
    messages,
    // Explicit portable effort keeps provider defaults from consuming the
    // bounded call's output budget before any answer text is produced.
    reasoning: "low",
    maxOutputTokens: Math.min(execution.selection.maxOutputTokens ?? 2_500, 4_000),
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(Math.min(execution.selection.timeoutMs ?? 55_000, 55_000)),
  }); } catch {
    throw new LanguageGenerationError("Language provider outcome is unavailable", "provider-error", {
      model_execution: modelExecutionEvidence(execution.selection, { response: { id: "", modelId: "" }, usage: {} }),
      finish_reason: null, reasoning: "low", ...instructionEvidence,
    });
  }
  const evidence = { model_execution: modelExecutionEvidence(execution.selection, { ...result, response: result.response ?? { id: "", modelId: "" } }), finish_reason: result.finishReason, reasoning: "low", ...instructionEvidence };
  if (result.finishReason !== "stop" || !result.text.trim()) {
    const diagnostic = { event: "language.generation-incomplete", model: execution.selection.model,
      route: execution.selection.route, reasoning: "low", finish_reason: result.finishReason,
      input_tokens: result.usage?.inputTokens ?? null, output_tokens: result.usage?.outputTokens ?? null,
      text_characters: result.text.length, reasoning_characters: result.reasoningText?.length ?? 0 };
    (dependencies.reportIncomplete ?? ((event) => console.warn(JSON.stringify(event))))(diagnostic);
    throw new LanguageGenerationError("Language generation did not complete; no successful text was produced", "incomplete", evidence);
  }
  return { text: result.text.trim(), evidence };
 };
}
export const generateLanguage = createLanguageGenerator();
