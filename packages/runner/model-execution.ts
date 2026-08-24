export const MODEL_EXECUTION_ROUTES = ["vercel-ai-gateway", "anthropic-direct"] as const;

export type ModelExecutionRoute = (typeof MODEL_EXECUTION_ROUTES)[number];

export interface ModelExecutionSelection {
  readonly route: ModelExecutionRoute;
  readonly provider: string;
  readonly model: string;
  readonly credentialRef: string | null;
}

export interface ModelExecutionEvidence extends ModelExecutionSelection {
  readonly responseId: string;
  readonly responseModel: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function normalizeModelExecution(routeValue: unknown, modelValue: unknown): ModelExecutionSelection {
  const route = String(routeValue ?? "").trim() as ModelExecutionRoute;
  const model = String(modelValue ?? "").trim();
  if (!MODEL_EXECUTION_ROUTES.includes(route)) throw new Error(`Unsupported model execution route '${route || "missing"}'.`);
  if (!MODEL_ID.test(model)) throw new Error("Model must use exact provider/model syntax.");
  const provider = model.slice(0, model.indexOf("/"));
  if (route === "anthropic-direct" && provider !== "anthropic") {
    throw new Error("The anthropic-direct route accepts only anthropic/* models.");
  }
  return {
    route,
    provider: route === "vercel-ai-gateway" ? "vercel-ai-gateway" : "anthropic",
    model,
    credentialRef: route === "anthropic-direct" ? "ANTHROPIC_API_KEY" : null,
  };
}

export function legacyGatewaySelection(modelValue: unknown): ModelExecutionSelection {
  return normalizeModelExecution("vercel-ai-gateway", modelValue || "openai/gpt-5.4-nano");
}
