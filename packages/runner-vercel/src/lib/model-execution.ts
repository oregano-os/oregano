import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import {
  CORE_MODEL_RECIPE_REGISTRY,
  resolveModelExecutionSelection,
  type ModelBinding,
  type ModelCapability,
  type ModelExecutionEvidence,
  type ModelExecutionSelection,
  type ModelEnvironment,
  type ModelRuntimeConfiguration,
  type ModelTaskProfile,
} from "../../../runner/model-execution.ts";

export interface ResolvedModelExecution {
  readonly selection: ModelExecutionSelection;
  readonly model: LanguageModel;
}

export interface ModelExecutionContext {
  readonly profile?: ModelTaskProfile;
  readonly task?: string;
  readonly binding?: ModelBinding;
  readonly requiredCapability?: ModelCapability;
  readonly configuration?: ModelRuntimeConfiguration;
  readonly environment?: ModelEnvironment;
}

const isContext = (value: ModelEnvironment | ModelExecutionContext): value is ModelExecutionContext =>
  ["profile", "task", "binding", "requiredCapability", "configuration", "environment"].some((key) => Object.prototype.hasOwnProperty.call(value, key));

const providerModelId = (selection: ModelExecutionSelection): string => selection.model.slice(selection.model.indexOf("/") + 1);

const compatibleHeaders = (selection: ModelExecutionSelection, environment: ModelEnvironment): Record<string, string> | undefined => {
  if (selection.route !== "openrouter") return undefined;
  const referer = environment.OPENROUTER_REFERER;
  const title = environment.OPENROUTER_TITLE;
  if (!referer && !title) return undefined;
  return {
    ...(referer ? { "HTTP-Referer": referer } : {}),
    ...(title ? { "X-OpenRouter-Title": title, "X-Title": title } : {}),
  };
};

export function resolveModelExecution(input: ModelEnvironment | ModelExecutionContext = process.env): ResolvedModelExecution {
  const context = isContext(input) ? input : { environment: input };
  const environment = context.environment ?? process.env;
  const selection = resolveModelExecutionSelection({ ...context, environment });
  const selectedRecipe = CORE_MODEL_RECIPE_REGISTRY.resolve(selection.route);
  if (selection.route === "vercel-ai-gateway") return { selection, model: selection.model };
  const credential = selection.credentialRef ? environment[selection.credentialRef] : undefined;
  if (selectedRecipe.credentialRequired && selection.credentialRef && !credential) throw new Error(`Missing required runtime secret: ${selection.credentialRef}.`);
  const modelId = providerModelId(selection);
  if (selectedRecipe.transport === "anthropic-messages") {
    return { selection, model: createAnthropic({ apiKey: credential })(modelId) };
  }
  if (selectedRecipe.transport === "openai-responses") {
    return { selection, model: createOpenAI({ apiKey: credential })(modelId) };
  }
  if (selectedRecipe.transport === "google-generative-ai") {
    return { selection, model: createGoogleGenerativeAI({ apiKey: credential })(modelId) };
  }
  if (selectedRecipe.transport === "openai-compatible") {
    const baseURL = (selection.baseUrlRef ? environment[selection.baseUrlRef] : undefined) ?? selectedRecipe.defaultBaseUrl;
    if (!baseURL) throw new Error(`Missing required runtime setting: ${selection.baseUrlRef ?? "model provider base URL"}.`);
    return {
      selection,
      model: createOpenAICompatible({
        name: `companyos-${selectedRecipe.provider}`,
        baseURL,
        apiKey: credential,
        headers: compatibleHeaders(selection, environment),
        supportsStructuredOutputs: selectedRecipe.capabilities.includes("structured-output"),
      })(modelId),
    };
  }
  throw new Error(`Model recipe '${selection.route}' has no language-model executor.`);
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
