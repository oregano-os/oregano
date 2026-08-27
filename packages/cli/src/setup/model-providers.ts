import { defineSetupModelProviderAdapter } from "./model-provider-contracts.ts";
import {
  ANTHROPIC_DIRECT_RECIPE,
  DEEPSEEK_RECIPE,
  GOOGLE_DIRECT_RECIPE,
  GROQ_RECIPE,
  MINIMAX_RECIPE,
  MISTRAL_RECIPE,
  MOONSHOT_RECIPE,
  NVIDIA_RECIPE,
  OPENAI_DIRECT_RECIPE,
  OPENROUTER_RECIPE,
  TOGETHER_RECIPE,
  VERCEL_AI_GATEWAY_RECIPE,
  ZHIPU_RECIPE,
  type ModelProviderRecipe,
} from "../../../runner/model-execution.ts";

export const VERCEL_AI_GATEWAY_MODEL_PROVIDER = defineSetupModelProviderAdapter({
  route: "vercel-ai-gateway",
  executionProvider: "vercel-ai-gateway",
  displayName: "Vercel AI Gateway",
  allowedCredentialModes: ["platform"],
  credentialRef: null,
  keyCreationUrl: null,
  secretEntrySurface: "none",
  supports: VERCEL_AI_GATEWAY_RECIPE.supports,
});

export const ANTHROPIC_DIRECT_MODEL_PROVIDER = defineSetupModelProviderAdapter({
  route: "anthropic-direct",
  executionProvider: "anthropic",
  displayName: "Anthropic",
  allowedCredentialModes: ["configure", "adopt"],
  credentialRef: "ANTHROPIC_API_KEY",
  keyCreationUrl: "https://platform.claude.com/settings/keys",
  secretEntrySurface: "runtime-host-dashboard",
  supports: ANTHROPIC_DIRECT_RECIPE.supports,
});

export const OPENAI_DIRECT_MODEL_PROVIDER = defineSetupModelProviderAdapter({
  route: "openai-direct",
  executionProvider: "openai",
  displayName: "OpenAI",
  allowedCredentialModes: ["configure", "adopt"],
  credentialRef: "OPENAI_API_KEY",
  keyCreationUrl: "https://platform.openai.com/api-keys",
  secretEntrySurface: "runtime-host-dashboard",
  supports: OPENAI_DIRECT_RECIPE.supports,
});

export const GOOGLE_DIRECT_MODEL_PROVIDER = defineSetupModelProviderAdapter({
  route: "google-direct",
  executionProvider: "google",
  displayName: "Google AI",
  allowedCredentialModes: ["configure", "adopt"],
  credentialRef: "GOOGLE_GENERATIVE_AI_API_KEY",
  keyCreationUrl: "https://aistudio.google.com/app/apikey",
  secretEntrySurface: "runtime-host-dashboard",
  supports: GOOGLE_DIRECT_RECIPE.supports,
});

const compatibleCloudProvider = (
  selectedRecipe: ModelProviderRecipe,
  displayName: string,
  keyCreationUrl: string,
) => defineSetupModelProviderAdapter({
  route: selectedRecipe.route,
  executionProvider: selectedRecipe.provider,
  displayName,
  allowedCredentialModes: ["configure", "adopt"],
  credentialRef: selectedRecipe.credentialRefs[0] ?? null,
  keyCreationUrl,
  secretEntrySurface: "runtime-host-dashboard",
  supports: selectedRecipe.supports,
});

export const OPENROUTER_MODEL_PROVIDER = compatibleCloudProvider(OPENROUTER_RECIPE, "OpenRouter", "https://openrouter.ai/settings/keys");
export const DEEPSEEK_MODEL_PROVIDER = compatibleCloudProvider(DEEPSEEK_RECIPE, "DeepSeek", "https://platform.deepseek.com/api_keys");
export const GROQ_MODEL_PROVIDER = compatibleCloudProvider(GROQ_RECIPE, "Groq", "https://console.groq.com/keys");
export const TOGETHER_MODEL_PROVIDER = compatibleCloudProvider(TOGETHER_RECIPE, "Together AI", "https://api.together.ai/settings/api-keys");
export const MINIMAX_MODEL_PROVIDER = compatibleCloudProvider(MINIMAX_RECIPE, "MiniMax", "https://www.minimaxi.com");
export const ZHIPU_MODEL_PROVIDER = compatibleCloudProvider(ZHIPU_RECIPE, "Zhipu AI", "https://open.bigmodel.cn/");
export const MOONSHOT_MODEL_PROVIDER = compatibleCloudProvider(MOONSHOT_RECIPE, "Moonshot AI / Kimi", "https://platform.kimi.ai/console/api-keys");
export const MISTRAL_MODEL_PROVIDER = compatibleCloudProvider(MISTRAL_RECIPE, "Mistral AI", "https://console.mistral.ai/api-keys");
export const NVIDIA_MODEL_PROVIDER = compatibleCloudProvider(NVIDIA_RECIPE, "NVIDIA NIM", "https://build.nvidia.com");

export const SETUP_MODEL_PROVIDERS = Object.freeze({
  [VERCEL_AI_GATEWAY_MODEL_PROVIDER.route]: VERCEL_AI_GATEWAY_MODEL_PROVIDER,
  [ANTHROPIC_DIRECT_MODEL_PROVIDER.route]: ANTHROPIC_DIRECT_MODEL_PROVIDER,
  [OPENAI_DIRECT_MODEL_PROVIDER.route]: OPENAI_DIRECT_MODEL_PROVIDER,
  [GOOGLE_DIRECT_MODEL_PROVIDER.route]: GOOGLE_DIRECT_MODEL_PROVIDER,
  [OPENROUTER_MODEL_PROVIDER.route]: OPENROUTER_MODEL_PROVIDER,
  [DEEPSEEK_MODEL_PROVIDER.route]: DEEPSEEK_MODEL_PROVIDER,
  [GROQ_MODEL_PROVIDER.route]: GROQ_MODEL_PROVIDER,
  [TOGETHER_MODEL_PROVIDER.route]: TOGETHER_MODEL_PROVIDER,
  [MINIMAX_MODEL_PROVIDER.route]: MINIMAX_MODEL_PROVIDER,
  [ZHIPU_MODEL_PROVIDER.route]: ZHIPU_MODEL_PROVIDER,
  [MOONSHOT_MODEL_PROVIDER.route]: MOONSHOT_MODEL_PROVIDER,
  [MISTRAL_MODEL_PROVIDER.route]: MISTRAL_MODEL_PROVIDER,
  [NVIDIA_MODEL_PROVIDER.route]: NVIDIA_MODEL_PROVIDER,
});

export function setupModelProvider(route: string) {
  return SETUP_MODEL_PROVIDERS[route as keyof typeof SETUP_MODEL_PROVIDERS];
}
