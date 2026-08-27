export const MODEL_RECIPE_CONTRACT_VERSION = "1.0.0" as const;
export const MODEL_RUNTIME_CONFIG_ENV = "COMPANYOS_MODEL_CONFIG_BASE64" as const;

export const MODEL_EXECUTION_ROUTES = [
  "vercel-ai-gateway",
  "anthropic-direct",
  "openai-direct",
  "google-direct",
  "openrouter",
  "litellm",
  "deepseek",
  "groq",
  "together",
  "ollama",
  "llama-server",
  "minimax",
  "zhipu",
  "moonshot",
  "mistral",
  "nvidia",
  "openai-compatible",
] as const;

export type ModelExecutionRoute = (typeof MODEL_EXECUTION_ROUTES)[number];

export const MODEL_TASK_PROFILES = [
  "agent",
  "utility",
  "reasoning",
  "deep",
  "subagent",
  "embedding",
  "reranker",
] as const;

export type ModelTaskProfile = (typeof MODEL_TASK_PROFILES)[number];
export type ModelCapability = "language" | "tools" | "structured-output" | "embedding" | "reranking";
export type ModelTransport = "ai-gateway" | "anthropic-messages" | "openai-responses" | "google-generative-ai" | "openai-compatible";
export type ModelEnvironment = Readonly<Record<string, string | undefined>>;

export interface ModelProviderRecipe {
  readonly contractVersion: typeof MODEL_RECIPE_CONTRACT_VERSION;
  readonly route: ModelExecutionRoute;
  readonly provider: string;
  readonly transport: ModelTransport;
  readonly credentialRefs: readonly string[];
  readonly credentialRequired: boolean;
  readonly baseUrlRef: string | null;
  readonly defaultBaseUrl: string | null;
  readonly capabilities: readonly ModelCapability[];
  readonly defaultModels: Readonly<Partial<Record<ModelTaskProfile, string>>>;
  supports(model: string): boolean;
}

export interface ModelBinding {
  readonly route: ModelExecutionRoute;
  readonly model: string;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly retries?: number;
}

export interface ModelRuntimeConfiguration {
  readonly version: 1;
  readonly default?: ModelBinding;
  readonly profiles?: Readonly<Partial<Record<ModelTaskProfile, ModelBinding>>>;
  readonly tasks?: Readonly<Record<string, ModelBinding>>;
}

export interface ModelExecutionSelection extends ModelBinding {
  readonly provider: string;
  readonly transport: ModelTransport;
  readonly credentialRef: string | null;
  readonly baseUrlRef: string | null;
  readonly recipeVersion: typeof MODEL_RECIPE_CONTRACT_VERSION;
}

export interface ModelExecutionEvidence extends ModelExecutionSelection {
  readonly responseId: string;
  readonly responseModel: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const TASK_ID = /^[a-z][a-z0-9._-]{0,255}$/;
const SECRET_REF = /^[A-Z][A-Z0-9_]{0,127}$/;

const recipe = (input: Omit<ModelProviderRecipe, "contractVersion">): ModelProviderRecipe => {
  const value: ModelProviderRecipe = { contractVersion: MODEL_RECIPE_CONTRACT_VERSION, ...input };
  if (!MODEL_EXECUTION_ROUTES.includes(value.route)) throw new Error(`Unsupported model recipe route '${value.route}'.`);
  if (!value.provider.trim() || !SECRET_REF.test(value.baseUrlRef ?? "COMPANYOS_BASE_URL")) throw new Error(`Model recipe '${value.route}' has invalid metadata.`);
  if (value.credentialRefs.some((entry) => !SECRET_REF.test(entry)) || new Set(value.credentialRefs).size !== value.credentialRefs.length) throw new Error(`Model recipe '${value.route}' has invalid credential references.`);
  if (value.credentialRequired && value.credentialRefs.length === 0) throw new Error(`Model recipe '${value.route}' requires a credential reference.`);
  if (value.defaultBaseUrl) {
    const parsed = new URL(value.defaultBaseUrl);
    if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) throw new Error(`Model recipe '${value.route}' has an invalid default base URL.`);
  }
  if (value.capabilities.length === 0 || new Set(value.capabilities).size !== value.capabilities.length) throw new Error(`Model recipe '${value.route}' requires distinct capabilities.`);
  Object.freeze(value.credentialRefs);
  Object.freeze(value.capabilities);
  Object.freeze(value.defaultModels);
  return Object.freeze(value);
};

const supportsProvider = (provider: string) => (model: string): boolean => MODEL_ID.test(model) && model.startsWith(`${provider}/`);

export const VERCEL_AI_GATEWAY_RECIPE = recipe({
  route: "vercel-ai-gateway",
  provider: "vercel-ai-gateway",
  transport: "ai-gateway",
  credentialRefs: [],
  credentialRequired: false,
  baseUrlRef: null,
  defaultBaseUrl: null,
  capabilities: ["language", "tools", "structured-output", "embedding"],
  defaultModels: {
    agent: "openai/gpt-5.4-nano",
    utility: "openai/gpt-5.4-nano",
    reasoning: "openai/gpt-5.4-nano",
    deep: "openai/gpt-5.4-nano",
    subagent: "openai/gpt-5.4-nano",
  },
  supports: (model) => MODEL_ID.test(model),
});

export const ANTHROPIC_DIRECT_RECIPE = recipe({
  route: "anthropic-direct",
  provider: "anthropic",
  transport: "anthropic-messages",
  credentialRefs: ["ANTHROPIC_API_KEY"],
  credentialRequired: true,
  baseUrlRef: null,
  defaultBaseUrl: null,
  capabilities: ["language", "tools", "structured-output"],
  defaultModels: {
    agent: "anthropic/claude-sonnet-4-6",
    utility: "anthropic/claude-haiku-4-5",
    reasoning: "anthropic/claude-sonnet-4-6",
    deep: "anthropic/claude-opus-4-6",
    subagent: "anthropic/claude-sonnet-4-6",
  },
  supports: supportsProvider("anthropic"),
});

export const OPENAI_DIRECT_RECIPE = recipe({
  route: "openai-direct",
  provider: "openai",
  transport: "openai-responses",
  credentialRefs: ["OPENAI_API_KEY"],
  credentialRequired: true,
  baseUrlRef: null,
  defaultBaseUrl: null,
  capabilities: ["language", "tools", "structured-output", "embedding"],
  defaultModels: {
    agent: "openai/gpt-5.4-nano",
    utility: "openai/gpt-5.4-nano",
    reasoning: "openai/gpt-5.4-mini",
    deep: "openai/gpt-5.4",
    subagent: "openai/gpt-5.4-mini",
  },
  supports: supportsProvider("openai"),
});

export const GOOGLE_DIRECT_RECIPE = recipe({
  route: "google-direct",
  provider: "google",
  transport: "google-generative-ai",
  credentialRefs: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
  credentialRequired: true,
  baseUrlRef: null,
  defaultBaseUrl: null,
  capabilities: ["language", "tools", "structured-output", "embedding"],
  defaultModels: {},
  supports: supportsProvider("google"),
});

export const OPENAI_COMPATIBLE_RECIPE = recipe({
  route: "openai-compatible",
  provider: "openai-compatible",
  transport: "openai-compatible",
  credentialRefs: ["OPENAI_COMPATIBLE_API_KEY"],
  credentialRequired: true,
  baseUrlRef: "COMPANYOS_OPENAI_COMPATIBLE_BASE_URL",
  defaultBaseUrl: null,
  capabilities: ["language", "tools", "structured-output", "embedding"],
  defaultModels: {},
  supports: supportsProvider("compatible"),
});

const compatibleRecipe = (input: {
  readonly route: ModelExecutionRoute;
  readonly provider: string;
  readonly credentialRefs: readonly string[];
  readonly credentialRequired?: boolean;
  readonly baseUrlRef?: string | null;
  readonly defaultBaseUrl: string;
  readonly capabilities: readonly ModelCapability[];
  readonly defaultModels?: Readonly<Partial<Record<ModelTaskProfile, string>>>;
}): ModelProviderRecipe => recipe({
  route: input.route,
  provider: input.provider,
  transport: "openai-compatible",
  credentialRefs: input.credentialRefs,
  credentialRequired: input.credentialRequired ?? true,
  baseUrlRef: input.baseUrlRef ?? null,
  defaultBaseUrl: input.defaultBaseUrl,
  capabilities: input.capabilities,
  defaultModels: input.defaultModels ?? {},
  supports: supportsProvider(input.route),
});

export const OPENROUTER_RECIPE = compatibleRecipe({
  route: "openrouter",
  provider: "openrouter",
  credentialRefs: ["OPENROUTER_API_KEY"],
  baseUrlRef: "OPENROUTER_BASE_URL",
  defaultBaseUrl: "https://openrouter.ai/api/v1",
  capabilities: ["language", "tools"],
  defaultModels: {
    agent: "openrouter/anthropic/claude-sonnet-4.6",
    utility: "openrouter/anthropic/claude-haiku-4.5",
    reasoning: "openrouter/anthropic/claude-sonnet-4.6",
    deep: "openrouter/anthropic/claude-opus-4.7",
    subagent: "openrouter/anthropic/claude-sonnet-4.6",
  },
});

export const LITELLM_RECIPE = compatibleRecipe({
  route: "litellm",
  provider: "litellm",
  credentialRefs: ["LITELLM_API_KEY"],
  credentialRequired: false,
  baseUrlRef: "LITELLM_BASE_URL",
  defaultBaseUrl: "http://localhost:4000",
  capabilities: ["language", "tools"],
});

export const DEEPSEEK_RECIPE = compatibleRecipe({
  route: "deepseek",
  provider: "deepseek",
  credentialRefs: ["DEEPSEEK_API_KEY"],
  defaultBaseUrl: "https://api.deepseek.com/v1",
  capabilities: ["language", "tools"],
  defaultModels: {
    agent: "deepseek/deepseek-v4-flash",
    utility: "deepseek/deepseek-v4-flash",
    reasoning: "deepseek/deepseek-v4-pro",
    deep: "deepseek/deepseek-v4-pro",
    subagent: "deepseek/deepseek-v4-pro",
  },
});

export const GROQ_RECIPE = compatibleRecipe({
  route: "groq",
  provider: "groq",
  credentialRefs: ["GROQ_API_KEY"],
  defaultBaseUrl: "https://api.groq.com/openai/v1",
  capabilities: ["language", "tools"],
  defaultModels: {
    agent: "groq/llama-3.3-70b-versatile",
    utility: "groq/llama-3.1-8b-instant",
    reasoning: "groq/llama-3.3-70b-versatile",
    deep: "groq/gpt-oss-120b",
    subagent: "groq/llama-3.3-70b-versatile",
  },
});

export const TOGETHER_RECIPE = compatibleRecipe({
  route: "together",
  provider: "together",
  credentialRefs: ["TOGETHER_API_KEY"],
  defaultBaseUrl: "https://api.together.xyz/v1",
  capabilities: ["language", "tools"],
  defaultModels: {
    agent: "together/Qwen/Qwen2.5-72B-Instruct-Turbo",
    utility: "together/meta-llama/Llama-3.3-70B-Instruct-Turbo",
    reasoning: "together/Qwen/Qwen2.5-72B-Instruct-Turbo",
    deep: "together/deepseek-ai/DeepSeek-V3",
    subagent: "together/meta-llama/Llama-3.3-70B-Instruct-Turbo",
  },
});

export const OLLAMA_RECIPE = compatibleRecipe({
  route: "ollama",
  provider: "ollama",
  credentialRefs: ["OLLAMA_API_KEY"],
  credentialRequired: false,
  baseUrlRef: "OLLAMA_BASE_URL",
  defaultBaseUrl: "http://localhost:11434/v1",
  capabilities: ["language"],
  defaultModels: {
    agent: "ollama/qwen2.5-coder:14b",
    utility: "ollama/qwen2.5-coder:14b",
    reasoning: "ollama/qwen2.5-coder:14b",
    deep: "ollama/qwen2.5-coder:14b",
  },
});

export const LLAMA_SERVER_RECIPE = compatibleRecipe({
  route: "llama-server",
  provider: "llama-server",
  credentialRefs: ["LLAMA_SERVER_API_KEY"],
  credentialRequired: false,
  baseUrlRef: "LLAMA_SERVER_BASE_URL",
  defaultBaseUrl: "http://localhost:8080/v1",
  capabilities: ["language", "tools"],
});

export const MINIMAX_RECIPE = compatibleRecipe({
  route: "minimax",
  provider: "minimax",
  credentialRefs: ["MINIMAX_API_KEY"],
  defaultBaseUrl: "https://api.minimaxi.com/v1",
  capabilities: ["language"],
  defaultModels: {
    agent: "minimax/MiniMax-M3",
    utility: "minimax/MiniMax-M2.7-highspeed",
    reasoning: "minimax/MiniMax-M3",
    deep: "minimax/MiniMax-M3",
  },
});

export const ZHIPU_RECIPE = compatibleRecipe({
  route: "zhipu",
  provider: "zhipu",
  credentialRefs: ["ZHIPUAI_API_KEY"],
  defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
  capabilities: ["language", "tools"],
  defaultModels: {
    agent: "zhipu/glm-5.1",
    utility: "zhipu/glm-4.5",
    reasoning: "zhipu/glm-5.1",
    deep: "zhipu/glm-5.1",
    subagent: "zhipu/glm-5.1",
  },
});

export const MOONSHOT_RECIPE = compatibleRecipe({
  route: "moonshot",
  provider: "moonshot",
  credentialRefs: ["MOONSHOT_API_KEY"],
  defaultBaseUrl: "https://api.moonshot.ai/v1",
  capabilities: ["language", "tools"],
  defaultModels: {
    agent: "moonshot/kimi-k2.7-code",
    utility: "moonshot/kimi-k2.7-code-highspeed",
    reasoning: "moonshot/kimi-k2.7-code",
    deep: "moonshot/kimi-k2.7-code",
  },
});

export const MISTRAL_RECIPE = compatibleRecipe({
  route: "mistral",
  provider: "mistral",
  credentialRefs: ["MISTRAL_API_KEY"],
  defaultBaseUrl: "https://api.mistral.ai/v1",
  capabilities: ["language", "tools"],
  defaultModels: {
    agent: "mistral/mistral-medium-latest",
    utility: "mistral/ministral-3b-latest",
    reasoning: "mistral/mistral-large-latest",
    deep: "mistral/mistral-large-latest",
  },
});

export const NVIDIA_RECIPE = compatibleRecipe({
  route: "nvidia",
  provider: "nvidia",
  credentialRefs: ["NVIDIA_API_KEY"],
  defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
  capabilities: ["language"],
  defaultModels: {
    agent: "nvidia/nvidia/nemotron-3-super-120b-a12b",
    utility: "nvidia/nvidia/nemotron-3-super-120b-a12b",
    reasoning: "nvidia/nvidia/nemotron-3-super-120b-a12b",
    deep: "nvidia/nvidia/nemotron-3-super-120b-a12b",
  },
});

export const CORE_MODEL_RECIPES = [
  VERCEL_AI_GATEWAY_RECIPE,
  ANTHROPIC_DIRECT_RECIPE,
  OPENAI_DIRECT_RECIPE,
  GOOGLE_DIRECT_RECIPE,
  OPENROUTER_RECIPE,
  LITELLM_RECIPE,
  DEEPSEEK_RECIPE,
  GROQ_RECIPE,
  TOGETHER_RECIPE,
  OLLAMA_RECIPE,
  LLAMA_SERVER_RECIPE,
  MINIMAX_RECIPE,
  ZHIPU_RECIPE,
  MOONSHOT_RECIPE,
  MISTRAL_RECIPE,
  NVIDIA_RECIPE,
  OPENAI_COMPATIBLE_RECIPE,
] as const;

export class ModelRecipeRegistry {
  readonly #recipes = new Map<ModelExecutionRoute, ModelProviderRecipe>();

  constructor(recipes: readonly ModelProviderRecipe[] = CORE_MODEL_RECIPES) {
    for (const entry of recipes) {
      if (entry.contractVersion !== MODEL_RECIPE_CONTRACT_VERSION) throw new Error(`Unsupported model recipe contract for '${entry.route}'.`);
      if (this.#recipes.has(entry.route)) throw new Error(`Duplicate model recipe route '${entry.route}'.`);
      this.#recipes.set(entry.route, entry);
    }
  }

  resolve(route: string): ModelProviderRecipe {
    const value = this.#recipes.get(route as ModelExecutionRoute);
    if (!value) throw new Error(`Unsupported model execution route '${route || "missing"}'.`);
    return value;
  }

  list(): ModelProviderRecipe[] {
    return [...this.#recipes.values()].sort((left, right) => left.route.localeCompare(right.route));
  }
}

export const CORE_MODEL_RECIPE_REGISTRY = new ModelRecipeRegistry();

const boundedInteger = (value: unknown, minimum: number, maximum: number, label: string): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${label} is outside its bounded range.`);
  return value as number;
};

export function normalizeModelBinding(value: unknown, label = "Model binding", registry = CORE_MODEL_RECIPE_REGISTRY): ModelBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !["route", "model", "maxOutputTokens", "timeoutMs", "retries"].includes(key))) throw new Error(`${label} has an unsupported field.`);
  const route = String(candidate.route ?? "").trim() as ModelExecutionRoute;
  const model = String(candidate.model ?? "").trim();
  const selectedRecipe = registry.resolve(route);
  if (!selectedRecipe.supports(model)) throw new Error(`Model '${model || "missing"}' is not supported by route '${route}'.`);
  const maxOutputTokens = boundedInteger(candidate.maxOutputTokens, 1, 200_000, `${label} maxOutputTokens`);
  const timeoutMs = boundedInteger(candidate.timeoutMs, 100, 600_000, `${label} timeoutMs`);
  const retries = boundedInteger(candidate.retries, 0, 10, `${label} retries`);
  return {
    route,
    model,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(retries === undefined ? {} : { retries }),
  };
}

export function decodeModelRuntimeConfiguration(encoded: string | undefined): ModelRuntimeConfiguration | undefined {
  if (!encoded) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    throw new Error(`${MODEL_RUNTIME_CONFIG_ENV} is malformed.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Model runtime configuration must be an object.");
  const candidate = parsed as Record<string, unknown>;
  if (candidate.version !== 1 || Object.keys(candidate).some((key) => !["version", "default", "profiles", "tasks"].includes(key))) throw new Error("Model runtime configuration has an unsupported shape.");
  const profiles: Partial<Record<ModelTaskProfile, ModelBinding>> = {};
  if (candidate.profiles !== undefined) {
    if (!candidate.profiles || typeof candidate.profiles !== "object" || Array.isArray(candidate.profiles)) throw new Error("Model runtime profiles must be an object.");
    for (const [profile, binding] of Object.entries(candidate.profiles)) {
      if (!MODEL_TASK_PROFILES.includes(profile as ModelTaskProfile)) throw new Error(`Unknown model task profile '${profile}'.`);
      profiles[profile as ModelTaskProfile] = normalizeModelBinding(binding, `Model profile '${profile}'`);
    }
  }
  const tasks: Record<string, ModelBinding> = {};
  if (candidate.tasks !== undefined) {
    if (!candidate.tasks || typeof candidate.tasks !== "object" || Array.isArray(candidate.tasks)) throw new Error("Model runtime tasks must be an object.");
    for (const [task, binding] of Object.entries(candidate.tasks)) {
      if (!TASK_ID.test(task)) throw new Error(`Invalid model task identity '${task}'.`);
      tasks[task] = normalizeModelBinding(binding, `Model task '${task}'`);
    }
  }
  return {
    version: 1,
    ...(candidate.default === undefined ? {} : { default: normalizeModelBinding(candidate.default, "Default model binding") }),
    ...(Object.keys(profiles).length === 0 ? {} : { profiles }),
    ...(Object.keys(tasks).length === 0 ? {} : { tasks }),
  };
}

export function normalizeModelExecution(routeValue: unknown, modelValue: unknown, options: Omit<ModelBinding, "route" | "model"> = {}): ModelExecutionSelection {
  const binding = normalizeModelBinding({ route: routeValue, model: modelValue, ...options });
  const selectedRecipe = CORE_MODEL_RECIPE_REGISTRY.resolve(binding.route);
  return {
    ...binding,
    provider: selectedRecipe.provider,
    transport: selectedRecipe.transport,
    credentialRef: selectedRecipe.credentialRefs[0] ?? null,
    baseUrlRef: selectedRecipe.baseUrlRef,
    recipeVersion: selectedRecipe.contractVersion,
  };
}

export function legacyGatewaySelection(modelValue: unknown, options: Omit<ModelBinding, "route" | "model"> = {}): ModelExecutionSelection {
  return normalizeModelExecution("vercel-ai-gateway", modelValue || "openai/gpt-5.4-nano", options);
}

const routeForConfiguredModel = (model: string, environment: ModelEnvironment): ModelExecutionRoute => {
  if (model.startsWith("anthropic/") && environment.ANTHROPIC_API_KEY) return "anthropic-direct";
  if (model.startsWith("openai/") && environment.OPENAI_API_KEY) return "openai-direct";
  if (model.startsWith("google/") && (environment.GOOGLE_GENERATIVE_AI_API_KEY || environment.GOOGLE_API_KEY)) return "google-direct";
  if (model.startsWith("compatible/") && environment.COMPANYOS_OPENAI_COMPATIBLE_BASE_URL) return "openai-compatible";
  const namedRecipe = CORE_MODEL_RECIPE_REGISTRY.list().find((entry) =>
    !new Set<ModelExecutionRoute>(["vercel-ai-gateway", "anthropic-direct", "openai-direct", "google-direct", "openai-compatible"]).has(entry.route)
    && entry.supports(model)
    && (!entry.credentialRequired || entry.credentialRefs.some((reference) => Boolean(environment[reference]))),
  );
  if (namedRecipe) return namedRecipe.route;
  return "vercel-ai-gateway";
};

const keyAwareDefault = (profile: ModelTaskProfile, environment: ModelEnvironment): ModelBinding | undefined => {
  if (environment.ANTHROPIC_API_KEY) {
    const model = ANTHROPIC_DIRECT_RECIPE.defaultModels[profile];
    if (model) return { route: ANTHROPIC_DIRECT_RECIPE.route, model };
  }
  if (environment.OPENAI_API_KEY) {
    const model = OPENAI_DIRECT_RECIPE.defaultModels[profile];
    if (model) return { route: OPENAI_DIRECT_RECIPE.route, model };
  }
  return undefined;
};

export function resolveModelExecutionSelection(input: {
  readonly profile?: ModelTaskProfile;
  readonly task?: string;
  readonly binding?: ModelBinding;
  readonly requiredCapability?: ModelCapability;
  readonly configuration?: ModelRuntimeConfiguration;
  readonly environment?: ModelEnvironment;
} = {}): ModelExecutionSelection {
  const environment = input.environment ?? process.env;
  const profile = input.profile ?? "agent";
  if (!MODEL_TASK_PROFILES.includes(profile)) throw new Error(`Unknown model task profile '${profile}'.`);
  if (input.task !== undefined && !TASK_ID.test(input.task)) throw new Error(`Invalid model task identity '${input.task}'.`);
  const configuration = input.configuration ?? decodeModelRuntimeConfiguration(environment[MODEL_RUNTIME_CONFIG_ENV]);
  let binding = input.binding
    ?? (input.task ? configuration?.tasks?.[input.task] : undefined)
    ?? configuration?.profiles?.[profile]
    ?? configuration?.default;
  if (!binding && environment.COMPANYOS_MODEL_ROUTE) binding = { route: environment.COMPANYOS_MODEL_ROUTE as ModelExecutionRoute, model: environment.COMPANYOS_MODEL ?? "" };
  if (!binding && environment.COMPANYOS_MODEL) binding = { route: routeForConfiguredModel(environment.COMPANYOS_MODEL, environment), model: environment.COMPANYOS_MODEL };
  binding ??= keyAwareDefault(profile, environment);
  binding ??= { route: "vercel-ai-gateway", model: VERCEL_AI_GATEWAY_RECIPE.defaultModels[profile] ?? "openai/gpt-5.4-nano" };
  const normalized = normalizeModelExecution(binding.route, binding.model, binding);
  const selectedRecipe = CORE_MODEL_RECIPE_REGISTRY.resolve(normalized.route);
  if (input.requiredCapability && !selectedRecipe.capabilities.includes(input.requiredCapability)) throw new Error(`Model recipe '${normalized.route}' does not support '${input.requiredCapability}'.`);
  const credentialRef = selectedRecipe.credentialRefs.find((entry) => Boolean(environment[entry])) ?? selectedRecipe.credentialRefs[0] ?? null;
  return { ...normalized, credentialRef };
}
