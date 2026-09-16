import { sha256 } from "../../../runtime/canonical.ts";
import { attachmentParts } from "../../../runtime/attachments.ts";
import { attachmentPolicy } from "../../../runner/attachment-policy.ts";
import { generateText } from "ai";
import type { LanguageGenerator } from "../../../language/contracts.ts";
import { languageSystemInstructions, LanguageGenerationError } from "../../../language/contracts.ts";
import { modelExecutionEvidence, resolveModelExecution } from "./model-execution.ts";

/** Decode only one complete JSON transport fence; never extract a value from prose.
 * The inner bytes are preserved, including every field and uncertainty. All semantic
 * validation remains with the caller. Non-JSON Markdown and code samples stay text.
 */
export function decodeSingleJsonFence(text: string): { text: string; encoding: "plain" | "single-json-fence" } {
 const plain = text.trim();
 const match = /^```json\r?\n([\s\S]*?)\r?\n```$/.exec(plain);
 if (match) {
  try {
   const value: unknown = JSON.parse(match[1]!);
   if (value !== null && typeof value === "object") return { text: match[1]!, encoding: "single-json-fence" };
  } catch { /* Invalid or multiple blocks remain visible to the downstream validator. */ }
 }
 return { text: plain, encoding: "plain" };
}

/** Resolve a trusted phase binding or the existing owning-Agent default. */
export function createLanguageGenerator(dependencies: {
 resolve: typeof resolveModelExecution;
 generate: typeof generateText;
 reportIncomplete?: (diagnostic: Record<string, unknown>) => void;
} = { resolve: resolveModelExecution, generate: generateText }): LanguageGenerator {
 return async (request) => {
  const execution = dependencies.resolve({ profile: request.modelProfile ?? "agent", task: request.modelTask, requiredCapability: "language" });
  const reasoning = execution.selection.reasoningEffort ?? "low";
  const selection = { ...execution.selection, reasoningEffort: reasoning };
  const messages = [{ role: "user" as const, content: request.attachments?.length ? [{ type: "text" as const, text: request.data }, ...attachmentParts(request.attachments, attachmentPolicy(execution.selection))] : request.data }];
  const system = languageSystemInstructions(request.instructions);
  const instructionEvidence = { system_prompt_digest: sha256(system), system_instruction_characters: system.length };
  await request.beforeDispatch?.(selection, instructionEvidence);
  let result;
  try { result = await dependencies.generate({
    model: execution.model,
    system,
    messages,
    // Trusted bindings may opt in; unconfigured calls keep the bounded low default.
    reasoning,
    maxOutputTokens: Math.min(execution.selection.maxOutputTokens ?? 2_500, 12_000),
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(Math.min(execution.selection.timeoutMs ?? 55_000, 120_000)),
  }); } catch {
    throw new LanguageGenerationError("Language provider outcome is unavailable", "provider-error", {
      model_execution: modelExecutionEvidence(selection, { response: { id: "", modelId: "" }, usage: {} }),
      finish_reason: null, reasoning, ...instructionEvidence,
    });
  }
  const evidence = { model_execution: modelExecutionEvidence(selection, { ...result, response: result.response ?? { id: "", modelId: "" } }), finish_reason: result.finishReason, reasoning, ...instructionEvidence };
  if (result.finishReason !== "stop" || !result.text.trim()) {
    const diagnostic = { event: "language.generation-incomplete", model: execution.selection.model,
      route: execution.selection.route, reasoning, finish_reason: result.finishReason,
      input_tokens: result.usage?.inputTokens ?? null, output_tokens: result.usage?.outputTokens ?? null,
      text_characters: result.text.length, reasoning_characters: result.reasoningText?.length ?? 0 };
    (dependencies.reportIncomplete ?? ((event) => console.warn(JSON.stringify(event))))(diagnostic);
    throw new LanguageGenerationError("Language generation did not complete; no successful text was produced", "incomplete", evidence);
  }
  const decoded = decodeSingleJsonFence(result.text);
  return { text: decoded.text, evidence: { ...evidence,
    response_encoding: decoded.encoding, provider_text_digest: sha256(result.text),
    delivered_text_digest: sha256(decoded.text) } };
 };
}
export const generateLanguage = createLanguageGenerator();
