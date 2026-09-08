import { SETUP_MODEL_PROVIDERS } from './model-providers.ts';
import { VERCEL_NEON_SLACK_PROFILE } from './profiles/vercel-neon-slack.ts';
import { CORE_MODEL_RECIPE_REGISTRY } from '../../../runner/model-execution.ts';

export const STANDARD_MODEL_PROVIDERS = Object.freeze([
  Object.freeze({ value: 'openai', label: 'OpenAI', route: 'openai-direct' }),
  Object.freeze({ value: 'anthropic', label: 'Anthropic', route: 'anthropic-direct' }),
]);

// Only an explicit answer selects a route. Other maintained routes and model
// overrides are accepted on request, without expanding the ordinary menu.
export function standardSetupModel(settings = {}) {
  const choice = STANDARD_MODEL_PROVIDERS.find(({ value }) => value === settings.model_provider);
  if (settings.model_provider !== undefined && !choice) throw new Error('Choose OpenAI or Anthropic, or explicitly request another supported model route.');
  if (choice && settings.model_route && settings.model_route !== choice.route) throw new Error('The selected provider and model route do not match.');
  const route = choice?.route ?? settings.model_route;
  if (!route) {
    if (settings.model) throw new Error('Choose a model provider before requesting a model.');
    return null;
  }
  const provider = Object.hasOwn(SETUP_MODEL_PROVIDERS, route) ? SETUP_MODEL_PROVIDERS[route] : undefined;
  if (!provider) throw new Error('That model route is not supported by this installer. Request a supported provider.');
  const model = settings.model?.trim() || CORE_MODEL_RECIPE_REGISTRY.resolve(route).defaultModels.agent;
  if (!model) throw new Error(`An exact model is required for ${provider.displayName}.`);
  if (!provider.supports(model)) throw new Error(`The requested model is not supported by ${provider.displayName}.`);
  return {
    route, model, provider: provider.displayName,
    credential_mode: provider.credentialRef ? 'configure' : 'platform',
    credential_ref: provider.credentialRef,
    pricing: {
      'openai-direct': 'https://developers.openai.com/api/docs/pricing',
      'anthropic-direct': 'https://platform.claude.com/docs/en/about-claude/pricing',
      'vercel-ai-gateway': 'https://vercel.com/docs/ai-gateway/pricing',
    }[route] ?? null,
  };
}

export const STANDARD_SETUP_DEFAULTS = Object.freeze({
  profile: VERCEL_NEON_SLACK_PROFILE.id,
  neon_plan: VERCEL_NEON_SLACK_PROFILE.stateService.qualifiedPlan,
  neon_region: VERCEL_NEON_SLACK_PROFILE.stateService.qualifiedRegion,
  vercel_plan: VERCEL_NEON_SLACK_PROFILE.runtimeHost.requiredPlan,
});
export const supportedSetupModelRoutes = () => Object.keys(SETUP_MODEL_PROVIDERS).sort();
export const setupReleaseMetadata = () => ({
  default_profile: STANDARD_SETUP_DEFAULTS.profile,
  default_model_route: null,
  default_model: null,
  model_provider_selection: 'required',
  model_provider_options: STANDARD_MODEL_PROVIDERS.map((choice) => ({ ...choice, model: standardSetupModel({ model_provider: choice.value }).model })),
  supported_model_routes: supportedSetupModelRoutes(),
});
