import { SETUP_MODEL_PROVIDERS } from './model-providers.ts';
import { VERCEL_NEON_SLACK_PROFILE } from './profiles/vercel-neon-slack.ts';

export const STANDARD_SETUP_DEFAULTS = Object.freeze({
  profile: VERCEL_NEON_SLACK_PROFILE.id,
  model_route: 'vercel-ai-gateway',
  model: 'openai/gpt-5.4-nano',
  neon_plan: VERCEL_NEON_SLACK_PROFILE.stateService.qualifiedPlan,
  neon_region: VERCEL_NEON_SLACK_PROFILE.stateService.qualifiedRegion,
  vercel_plan: VERCEL_NEON_SLACK_PROFILE.runtimeHost.requiredPlan,
});
export const supportedSetupModelRoutes = () => Object.keys(SETUP_MODEL_PROVIDERS).sort();
export const setupReleaseMetadata = () => ({
  default_profile: STANDARD_SETUP_DEFAULTS.profile,
  default_model_route: STANDARD_SETUP_DEFAULTS.model_route,
  default_model: STANDARD_SETUP_DEFAULTS.model,
  supported_model_routes: supportedSetupModelRoutes(),
});
