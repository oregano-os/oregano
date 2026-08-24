import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import {
  legacyGatewaySelection,
  normalizeModelExecution,
  type ModelExecutionEvidence,
  type ModelExecutionSelection,
} from "../../../runner/model-execution.ts";

export interface ResolvedModelExecution {
  readonly selection: ModelExecutionSelection;
  readonly model: LanguageModel;
}

export function resolveModelExecution(environment: NodeJS.ProcessEnv = process.env): ResolvedModelExecution {
  const selection = environment.COMPANYOS_MODEL_ROUTE
    ? normalizeModelExecution(environment.COMPANYOS_MODEL_ROUTE, environment.COMPANYOS_MODEL)
    : legacyGatewaySelection(environment.COMPANYOS_MODEL);
  if (selection.route === "vercel-ai-gateway") return { selection, model: selection.model };
  const credential = environment[selection.credentialRef!];
  if (!credential) throw new Error(`Missing required runtime secret: ${selection.credentialRef}.`);
  const provider = createAnthropic({ apiKey: credential });
  return { selection, model: provider(selection.model.slice("anthropic/".length)) };
}

export function modelExecutionEvidence(
  selection: ModelExecutionSelection,
  result: { response: { id: string; modelId: string }; usage: { inputTokens?: number; outputTokens?: number } },
): ModelExecutionEvidence {
  return {
    ...selection,
    responseId: result.response.id,
    responseModel: result.response.modelId,
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
  };
}
