import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { suggestSlug, normalizeCreateWorkspaceInput } from '../workspace-generator.mjs';
import { STANDARD_SETUP_DEFAULTS, standardSetupModel } from './release-defaults.mjs';
import { standardTemplateDigest, standardSlackConnectorName } from './standard-contract.mjs';

export function standardSetupScope({ root, core, account, owner, team, companyName, settings = {}, suffix = '', sessionId = randomUUID(), distribution = { kind: 'stable' } }) {
  const model = standardSetupModel(settings);
  if (!model) throw new Error('Choose OpenAI or Anthropic before reviewing the setup.');
  const slug = suggestSlug(companyName).slice(0, 40) || 'company';
  const stem = `${slug}${suffix}`;
  const locale = Intl.DateTimeFormat().resolvedOptions();
  const input = {
    company_name: companyName, workspace_slug: stem,
    language: settings.language ?? locale.locale.split('-')[0], timezone: settings.timezone ?? locale.timeZone,
    steward_name: settings.responsible_name ?? account.name ?? account.login,
    steward_id: suggestSlug(account.login), codeowner: `@${account.login}`, target_directory: `${stem}-companyos`,
  };
  const normalized = normalizeCreateWorkspaceInput(input);
  if (normalized.diagnostics.some((item) => item.severity === 'error')) throw new Error(normalized.diagnostics.map((item) => item.message).join(' '));
  return {
    version: 1, session_id: sessionId, template_digest: standardTemplateDigest(), core, distribution,
    workspace: join(root, input.target_directory), company: input,
    installer: { id: String(account.id), login: account.login }, vercel_team_id: team.id,
    answers: {
      change_date: new Date().toISOString().slice(0, 10),
      steward_email: account.email || `${account.id}+${account.login}@users.noreply.github.com`,
      github_owner: owner.login, github_repository: `${stem}-companyos`, github_account_type: owner.type === 'Organization' ? 'organization' : 'personal', github_repository_mode: 'create',
      vercel_scope: team.slug, vercel_project: `${stem}-companyos`, vercel_project_mode: 'create',
      neon_resource_name: `${stem}-companyos-db`, neon_resource_mode: 'create', neon_plan: STANDARD_SETUP_DEFAULTS.neon_plan, neon_region: STANDARD_SETUP_DEFAULTS.neon_region,
      slack_connector_name: standardSlackConnectorName({ distribution, session_id: sessionId }), slack_connector_mode: 'create', slack_channel_id: '',
      model_route: model.route, model_credential_mode: model.credential_mode, model: model.model,
    },
    costs: {
      vercel: { plan: 'pro-or-enterprise', pricing: 'https://vercel.com/docs/plans/pro-plan' },
      database: { plan: STANDARD_SETUP_DEFAULTS.neon_plan, region: STANDARD_SETUP_DEFAULTS.neon_region, pricing: 'https://neon.com/pricing' },
      model: { provider: model.provider, route: model.route, model: model.model, pricing: model.pricing,
        credential: model.credential_ref ? { variable: model.credential_ref, destination: 'Vercel Sensitive Production environment' } : null },
      usage: 'Provider subscriptions and usage charges apply. No subscription upgrade is performed by Oregano.',
    },
    effect: 'Create these new resources, initialize the supervised Slack assistant, and deploy it to production once. No business Tools or unattended workflows.',
  };
}
export function standardSetupSummary(scope) {
  return {
    ...(scope.distribution?.kind === 'candidate' ? { installation: 'Unpublished test candidate', core_commit: scope.core.ref } : {}),
    github_person: `@${scope.installer.login}`, company: scope.company.company_name, responsible_person: scope.company.steward_name,
    language: scope.company.language, timezone: scope.company.timezone,
    github: `${scope.answers.github_owner}/${scope.answers.github_repository}`,
    vercel: `${scope.answers.vercel_scope}/${scope.answers.vercel_project}`,
    database: scope.answers.neon_resource_name, region: scope.answers.neon_region,
    slack: `${scope.answers.slack_connector_name} in the Slack workspace you authorize`, costs: scope.costs,
    includes: 'New private company repository, Oregano in Slack, and the first production deployment.',
  };
}
