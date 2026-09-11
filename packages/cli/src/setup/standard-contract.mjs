import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ordered = (value) => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value;
export const setupDigest = (value) => createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
export const standardTemplateDigest = () => setupDigest(['../workspace-generator.mjs', '../operating-starter.mjs', './release-defaults.mjs'].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')));
export const standardSlackConnectorName = (scope) => scope.distribution?.kind === 'candidate' ? `oregano-test-${setupDigest(scope.session_id).slice(0, 12)}` : 'oregano';
export const isFreshSetup = (state) => state?.flow === 'fresh-initialization';
export function assertFreshSetupAuthority(state) {
  if (!isFreshSetup(state)) throw new Error('Only current fresh setup sessions are supported.');
  const { scope, authorization } = state.fresh ?? {};
  if (state.schema_version !== 5 || !scope || !authorization || authorization.scope_hash !== setupDigest(scope)
    || !scope.session_id || authorization.session_id !== scope.session_id
    || authorization.actor_id !== scope.installer.id || authorization.actor_login !== scope.installer.login
    || !/^\d{4}-\d{2}-\d{2}T/.test(authorization.accepted_at ?? '')
    || scope.template_digest !== standardTemplateDigest()
    || setupDigest(scope.core) !== setupDigest(state.core)
    || setupDigest(scope.answers) !== setupDigest(state.answers)
    || scope.answers.slack_connector_name !== standardSlackConnectorName(scope)
    || scope.workspace !== state.workspace
    || ['github_repository_mode', 'vercel_project_mode', 'neon_resource_mode', 'slack_connector_mode'].some((field) => state.answers[field] !== 'create')) {
    throw new Error('The initial setup decision no longer matches this installation. Review the changed setup before continuing.');
  }
}
export function createFreshSetupState(scope, confirmedRevision, startedAt = new Date().toISOString()) {
  if (confirmedRevision !== setupDigest(scope)) throw new Error('Confirm the currently displayed setup summary.');
  const state = {
    schema_version: 5, profile: 'vercel-neon-slack', flow: 'fresh-initialization',
    plan_hash: confirmedRevision, created_at: startedAt, updated_at: startedAt,
    phase: 'preflight', workspace: scope.workspace, core: scope.core, answers: scope.answers,
    fresh: { scope, authorization: { session_id: scope.session_id, scope_hash: confirmedRevision, actor_id: scope.installer.id, actor_login: scope.installer.login, accepted_at: new Date().toISOString() } },
    resources: {}, intents: {}, operating: {}, artifact: {}, deployment: {}, verification: {}, history: [],
  };
  assertFreshSetupAuthority(state);
  return state;
}
export function assertFreshInitializationEvidence(state) {
  assertFreshSetupAuthority(state);
  const initial = state.fresh?.initialization;
  if (!initial || initial.kind !== 'fresh-initialization' || initial.check !== 'passed'
    || initial.scope_hash !== state.fresh.authorization.scope_hash
    || !/^[0-9a-f]{40}$/.test(initial.workspace_commit ?? '')
    || initial.workspace_commit !== state.artifact?.workspace_commit
    || initial.actor_id !== state.fresh.scope.installer.id
    || state.resources.github?.authenticated_login !== state.fresh.scope.installer.login
    || state.resources.github?.mode !== 'create'
    || state.artifact?.core_commit !== state.core.ref
    || state.resources.github?.repository !== `${state.answers.github_owner}/${state.answers.github_repository}`
    || state.resources.vercel?.project !== state.answers.vercel_project || state.resources.vercel?.scope !== state.answers.vercel_scope
    || state.resources.neon?.name !== state.answers.neon_resource_name || state.resources.neon?.mode !== 'create'
    || state.resources.slack?.uid !== `slack/${standardSlackConnectorName(state.fresh.scope)}` || state.resources.slack?.mode !== 'create') throw new Error('Fresh initialization, responsible person, check, or exact commit evidence is missing or mismatched.');
  for (const key of ['github-repository-create', 'vercel-project-create', 'neon-resource-create', 'slack-connector-create']) {
    if (state.intents?.[key]?.status !== 'completed') throw new Error(`Fresh resource receipt is missing: ${key}.`);
  }
}
