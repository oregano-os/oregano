import { existsSync, mkdirSync, readFileSync, realpathSync, openSync, closeSync, unlinkSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectCoreCheckout } from '../core-checkout.mjs';
import { advanceLiveSetup, createCommandExecutor, readLiveSetupState, writeLiveSetupState, verifyLiveSetup, safeProviderError, inspectVercelPlan } from '../live-setup.mjs';
import { standardSetupScope, standardSetupSummary } from './standard-defaults.mjs';
import { createFreshSetupState, setupDigest, standardSlackConnectorName } from './standard-contract.mjs';
import { readSetupDistribution } from '../../../../scripts/install-companyos.mjs';

const timestamp = () => new Date().toISOString();
const privatePath = (path) => {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('The setup state directory or file cannot be a symbolic link.');
};
const json = (result) => {
  for (const index of [result.stdout.indexOf('{'), result.stdout.indexOf('[')].filter((n) => n >= 0).sort((a,b) => a-b)) {
    try { return JSON.parse(result.stdout.slice(index)); } catch {}
  }
  throw new Error('The provider did not return a readable response.');
};
const providerRead = async (executor, file, args, options = {}) => {
  let result;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    result = executor.run(file, args, { ...options, sensitiveOutput: true });
    if (result.status === 0 || !/429|50[0234]|ECONNRESET|ETIMEDOUT|temporar|timeout/i.test(result.stderr ?? '')) return result;
    if (attempt < 2) await new Promise((done) => setTimeout(done, 250 * 2 ** attempt));
  }
  return result;
};
const requireJson = (result, label) => {
  if (result.status !== 0) throw new Error(`${label} could not be read. Check the account access and retry.`);
  return json(result);
};
const teams = async (executor, coreRoot) => {
  const all = []; const seen = new Set(); let until;
  for (let page = 0; page < 100; page += 1) {
    const data = requireJson(await providerRead(executor, 'vercel', ['api', `/v2/teams?limit=100${until === undefined ? '' : `&until=${until}`}`, '--method', 'GET', '--raw', '--cwd', coreRoot]), 'Vercel teams');
    if (!Array.isArray(data.teams)) throw new Error('Vercel teams are unavailable.');
    all.push(...data.teams.map(({ id, slug, name }) => ({ id, slug, name })));
    const next = data.pagination?.next;
    if (next === undefined || next === null || seen.has(next)) return all;
    if (!Number.isFinite(Number(next))) throw new Error('Invalid Vercel team pagination.');
    seen.add(next); until = next;
  }
  throw new Error('Vercel team discovery did not finish.');
};
const actionFromLive = (action) => {
  if (!action) return undefined;
  if (action.type === 'slack-round-trip') return { type: 'open-slack', url: action.url, message: 'Open Oregano in Slack and send your first message.' };
  return action;
};

// One session and one pending event are shared by both agent harnesses. Only
// the response to a displayed review authorizes creation and first deployment.
export async function runStandardSetup({ root = process.cwd(), coreRoot, reply, executor = createCommandExecutor(), fetchImpl = globalThis.fetch, coreIdentity, startedAt } = {}) {
  root = realpathSync(resolve(root));
  coreRoot = realpathSync(resolve(coreRoot));
  if (root === coreRoot || existsSync(join(root, 'company.md'))) throw new Error('Start the standard setup in a new setup folder. Use the explicit advanced flow for an existing company.');
  const directory = join(root, '.companyos-bootstrap'); privatePath(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const sessionPath = join(directory, 'standard-setup.json'); privatePath(sessionPath);
  const livePath = join(directory, 'live-state.json'); privatePath(livePath);
  const lock = join(directory, 'standard-setup.lock'); privatePath(lock);
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('The setup lock is invalid. Restore the session lock before resuming.');
    try { process.kill(pid, 0); throw new Error('This setup is already running. Wait for its current action.'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; unlinkSync(lock); }
  }
  const lockFd = openSync(lock, 'wx', 0o600);
  const { writeSync } = await import('node:fs'); writeSync(lockFd, String(process.pid)); closeSync(lockFd);
  try {
    let session = existsSync(sessionPath) ? JSON.parse(readFileSync(sessionPath, 'utf8')) : {
      version: 1, id: randomUUID(), started_at: startedAt ?? timestamp(), phase: 'connect', settings: {}, events: [], confirmations: 0, free_text_inputs: 0,
    };
    if (session.version !== 1 || !session.id) throw new Error('This setup needs its original compatible installer.');
    const save = () => writeLiveSetupState(sessionPath, session);
    const emit = (type, message, extra = {}) => {
      const event = { type, message, ...extra };
      session.pending = event;
      session.events.push({ type, at: timestamp(), phase: session.phase }); save();
      return { protocol_version: 1, session_id: session.id, ...event, elapsed_ms: Date.now() - Date.parse(session.started_at) };
    };
    if (session.phase === 'cancelled') return emit('cancelled', 'Setup cancelled. Existing resources have been retained.');
    if (reply?.action === 'cancel') { session.phase = 'cancelled'; return emit('cancelled', 'Setup cancelled. Existing resources have been retained.'); }
    if (reply && !['confirm', 'answer', 'edit', 'retry', 'cancel'].includes(reply.action)) throw new Error('Unknown setup response.');
    if (['answer', 'edit'].includes(reply?.action)) {
      if (session.phase === 'install' || session.phase === 'complete') throw new Error('An authorized installation cannot be retargeted. Resume it or use a separate explicit change.');
      const allowed = new Set(['company_name', 'language', 'timezone', 'responsible_name', 'github_owner', 'vercel_team']);
      if (!reply.values || Object.entries(reply.values).some(([key,value]) => !allowed.has(key) || typeof value !== 'string' || value.length > 160 || /[\u0000-\u001f]/.test(value))) throw new Error('Provide only the requested setup fields.');
      if (session.pending?.type === 'input' && reply.values.company_name) session.free_text_inputs += 1;
      session.settings = { ...session.settings, ...reply.values }; session.scope = null; session.phase = 'connect';
    }
    // Recover a decision saved immediately before an interrupted session write.
    if (session.phase === 'review' && existsSync(livePath)) {
      const recorded = readLiveSetupState(livePath);
      if (recorded.fresh?.authorization?.scope_hash !== setupDigest(session.scope) || recorded.fresh?.authorization?.session_id !== session.id) throw new Error('An existing live setup cannot be replaced.');
      session.authorization_revision = recorded.fresh.authorization.scope_hash;
      session.confirmations = 1; session.phase = 'install'; save();
    }
    if (reply?.action === 'confirm') {
      if (['install', 'complete'].includes(session.phase) && reply.revision === session.authorization_revision) { /* an idempotent response resumes */ }
      else {
        if (session.phase !== 'review' || session.pending?.type !== 'review' || reply.revision !== session.pending.revision || setupDigest(session.scope) !== reply.revision) throw new Error('The setup summary changed. Review the current summary before confirming.');
        if (existsSync(livePath)) {
          const recorded = readLiveSetupState(livePath);
          if (recorded.fresh?.authorization?.scope_hash !== reply.revision || recorded.fresh?.authorization?.session_id !== session.id) throw new Error('An existing live setup cannot be replaced.');
        } else writeLiveSetupState(livePath, createFreshSetupState(session.scope, reply.revision, session.started_at));
        session.authorization_revision = reply.revision; session.confirmations += 1; session.phase = 'install'; save();
      }
    }
    if (session.phase === 'install' || session.phase === 'complete') {
      if (!existsSync(livePath)) throw new Error('The live setup receipt is missing. Restore it before resuming.');
      const currentCore = coreIdentity ? { identity: coreIdentity, diagnostics: [] } : inspectCoreCheckout(coreRoot);
      if (currentCore.diagnostics.some((item) => item.severity === 'error')) throw new Error('The release checkout changed. Restore the confirmed release before resuming.');
      const recorded = readLiveSetupState(livePath);
      if (currentCore.identity.ref !== recorded.core.ref || currentCore.identity.core_version !== recorded.core.version) throw new Error('The release changed after setup confirmation. Resume with the original release.');
      if (recorded.core.root !== coreRoot) throw new Error('Resume using the original verified release installation.');
      if (setupDigest(readSetupDistribution(root, coreRoot, recorded.core.ref)) !== setupDigest(recorded.fresh.scope.distribution ?? { kind: 'stable' })) throw new Error('The installer distribution changed. Resume with the original candidate or release.');
      const result = await advanceLiveSetup({ statePath: livePath, executor, fetchImpl });
      session.phase = result.status === 'complete' ? 'complete' : 'install';
      session.last_phase = result.state.phase;
      if (result.status === 'complete') {
        const verified = await verifyLiveSetup({ statePath: livePath, executor, fetchImpl });
        if (!verified.verification.ok) return emit('recovery', 'Final verification needs attention.', { diagnostics: verified.diagnostics, action: { type: 'retry' } });
        session.completed_at ??= timestamp();
        session.first_response_at = result.state.verification.database.first_response_at ?? session.completed_at;
        return emit('complete', 'Oregano is ready. Open it in Slack.', { url: result.state.resources.slack.open_url, timing: { id: session.id, core_commit: recorded.core.ref, distribution: recorded.fresh.scope.distribution?.kind ?? 'stable', platform: `${process.platform}-${process.arch}`, started_at: session.started_at, first_response_at: session.first_response_at, completed_at: session.completed_at, technical_questions: 0 }, metrics: { confirmations: session.confirmations, free_text_inputs: session.free_text_inputs, first_response_ms: Date.parse(session.first_response_at) - Date.parse(session.started_at), completion_ms: Date.parse(session.completed_at) - Date.parse(session.started_at) } });
      }
      return emit(result.status === 'blocked' ? 'recovery' : 'action', result.message, { action: actionFromLive(result.next_action), ...(result.diagnostics?.length ? { diagnostics: result.diagnostics } : {}) });
    }
    // Discover everything needed for a concrete review without creating hosted resources.
    const inspected = coreIdentity ? { identity: coreIdentity, diagnostics: [] } : inspectCoreCheckout(coreRoot);
    if (inspected.diagnostics.some((item) => item.severity === 'error')) return emit('recovery', 'Use a clean verified Oregano release.', { diagnostics: inspected.diagnostics });
    const identity = inspected.identity;
    const core = { root: coreRoot, repository: identity.repository, ref: identity.ref, version: identity.core_version, workbench_version: identity.workbench_version };
    const distribution = readSetupDistribution(root, coreRoot, core.ref);
    for (const command of ['git', 'gh', 'vercel']) {
      if (executor.run(command, ['--version'], { cwd: coreRoot }).status !== 0) return emit('action', `The installer needs ${command}.`, { action: { type: 'install-prerequisite', command } });
    }
    if ((await providerRead(executor, 'gh', ['auth', 'status'])).status !== 0) return emit('action', 'Sign in to GitHub.', { action: { type: 'browser-login', command: ['gh', 'auth', 'login', '--web'] } });
    if (distribution.kind === 'candidate') {
      const source = await providerRead(executor, 'gh', ['api', `repos/${core.repository}/git/commits/${core.ref}`]);
      if (source.status !== 0 || json(source).sha !== core.ref) return emit('action', 'The test commit must be available on GitHub before the first Workspace check can run. Push the exact candidate branch, then retry.', { action: { type: 'publish-candidate-source', repository: core.repository, commit: core.ref } });
    }
    const rawAccount = requireJson(await providerRead(executor, 'gh', ['api', 'user']), 'GitHub account');
    const account = { id: rawAccount.id, login: rawAccount.login, name: rawAccount.name || rawAccount.login, email: rawAccount.email || '', type: 'User' };
    if (!Number.isSafeInteger(account.id) || !/^[A-Za-z0-9-]+$/.test(account.login ?? '')) throw new Error('GitHub did not identify the signed-in person.');
    const orgPages = requireJson(await providerRead(executor, 'gh', ['api', '--paginate', '--slurp', 'user/orgs']), 'GitHub organizations');
    const owners = [account, ...orgPages.flat().map(({ id, login }) => ({ id, login, type: 'Organization' }))];
    const selectedOwner = session.settings.github_owner;
    const owner = selectedOwner ? owners.find((item) => item.login === selectedOwner) : owners.length === 1 ? owners[0] : null;
    if (!owner) return emit('choice', 'Which GitHub account should own your company repository?', { field: 'github_owner', options: owners.map((item) => ({ value: item.login, label: item.login })) });
    if ((await providerRead(executor, 'vercel', ['whoami', '--cwd', coreRoot])).status !== 0) return emit('action', 'Sign in to Vercel.', { action: { type: 'browser-login', command: ['vercel', 'login'] } });
    const availableTeams = await teams(executor, coreRoot);
    const selectedTeam = session.settings.vercel_team;
    const team = selectedTeam ? availableTeams.find((item) => item.id === selectedTeam || item.slug === selectedTeam) : availableTeams.length === 1 ? availableTeams[0] : null;
    if (!availableTeams.length) return emit('action', 'No accessible Vercel team was found. Connect the team that should run Oregano.', { action: { type: 'browser-login', url: 'https://vercel.com/dashboard' } });
    if (!team) return emit('choice', 'Which Vercel team should run Oregano?', { field: 'vercel_team', options: availableTeams.map((item) => ({ value: item.id, label: item.name || item.slug })) });
    const plan = inspectVercelPlan(executor, coreRoot, { answers: { vercel_scope: team.slug }, resources: { vercel_plan: { team_id: team.id, team_slug: team.slug } } });
    if (plan.action) return emit('action', plan.message, { action: plan.action });
    const companyName = session.settings.company_name?.trim();
    // The maintained connector is created only after Review. A previously
    // selected name can be supplied by an authenticated host via this field.
    if (!companyName) return emit('input', 'What is your company called?', { field: 'company_name' });
    const resources = (data) => Array.isArray(data) ? data : data.resources ?? data.connectors ?? data.data ?? [];
    const slack = resources(requireJson(await providerRead(executor, 'vercel', ['connect', 'list', '--all-projects', '--service', 'slack', '--search', 'oregano', '--format', 'json', '--scope', team.slug, '--cwd', coreRoot]), 'Slack connectors'));
    const connectorName = standardSlackConnectorName({ distribution, session_id: session.id });
    if (slack.some((item) => item.uid === `slack/${connectorName}` || item.name === connectorName)) return emit('recovery', 'This setup connector already exists. Resume its installation or use the explicit adoption guide.', { action: { type: 'existing-installation' } });
    const neon = resources(requireJson(await providerRead(executor, 'vercel', ['integration', 'list', '--all', '--integration', 'neon', '--format', 'json', '--scope', team.slug, '--cwd', coreRoot]), 'Neon resources'));
    let scope; let available = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      scope = standardSetupScope({ root, core, distribution, account, owner, team, companyName, settings: session.settings, sessionId: session.id, suffix: attempt ? `-${attempt + 1}` : '' });
      if (existsSync(scope.workspace) || neon.some((item) => item.name === scope.answers.neon_resource_name)) continue;
      const repo = await providerRead(executor, 'gh', ['api', `repos/${owner.login}/${scope.answers.github_repository}`]);
      if (repo.status === 0) continue;
      if (!/404|not found/i.test(repo.stderr ?? '')) throw new Error('Repository availability could not be verified. Check GitHub access.');
      const project = await providerRead(executor, 'vercel', ['api', `/v9/projects/${scope.answers.vercel_project}`, '--method', 'GET', '--raw', '--scope', team.slug, '--cwd', coreRoot]);
      if (project.status === 0) continue;
      if (!/404|not found/i.test(project.stderr ?? '')) throw new Error('Project availability could not be verified. Check Vercel access.');
      available = true; break;
    }
    if (!available || !scope || existsSync(scope.workspace)) throw new Error('A new resource name could not be selected.');
    // Preserve the exact review until an explicit edit or material provider
    // change; generated timestamps do not silently change authorization.
    if (session.scope) scope.answers.change_date = session.scope.answers.change_date;
    session.scope = scope; session.phase = 'review';
    return emit('review', 'Review your setup. Set up includes the first deployment.', { revision: setupDigest(scope), summary: standardSetupSummary(scope), choices: ['set-up', 'edit', 'cancel'] });
  } catch (error) {
    return { protocol_version: 1, type: 'recovery', message: safeProviderError(error.message), action: { type: 'retry' } };
  } finally { unlinkSync(lock); }
}
