import { defineSetupModelProviderAdapter } from "./model-provider-contracts.ts";

const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const VERCEL_AI_GATEWAY_MODEL_PROVIDER = defineSetupModelProviderAdapter({
  route: "vercel-ai-gateway",
  executionProvider: "vercel-ai-gateway",
  allowedCredentialModes: ["platform"],
  credentialRef: null,
  secretEntrySurface: "none",
  supports(model: string) {
    return MODEL_ID.test(model);
  },
});

export const ANTHROPIC_DIRECT_MODEL_PROVIDER = defineSetupModelProviderAdapter({
  route: "anthropic-direct",
  executionProvider: "anthropic",
  allowedCredentialModes: ["configure", "adopt"],
  credentialRef: "ANTHROPIC_API_KEY",
  secretEntrySurface: "runtime-host-dashboard",
  supports(model: string) {
    return /^anthropic\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model);
  },
});

export const SETUP_MODEL_PROVIDERS = Object.freeze({
  [VERCEL_AI_GATEWAY_MODEL_PROVIDER.route]: VERCEL_AI_GATEWAY_MODEL_PROVIDER,
  [ANTHROPIC_DIRECT_MODEL_PROVIDER.route]: ANTHROPIC_DIRECT_MODEL_PROVIDER,
});

export function setupModelProvider(route: string) {
  return SETUP_MODEL_PROVIDERS[route as keyof typeof SETUP_MODEL_PROVIDERS];
}
