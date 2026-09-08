import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { runStandardSetup } from '../src/setup/standard-setup.mjs';
import { standardSetupScope } from '../src/setup/standard-defaults.mjs';
import { createFreshSetupState, assertFreshSetupAuthority, assertFreshInitializationEvidence, setupDigest } from '../src/setup/standard-contract.mjs';
import { advanceLiveSetup, readLiveSetupState, writeLiveSetupState, SUPPORTED_VERCEL_CLI_VERSION } from '../src/live-setup.mjs';
import { CORE_VERSION, PNPM_VERSION } from '../src/core-version.mjs';
import { WORKBENCH_VERSION } from '../src/workbench-version.mjs';

const ok = (data = {}) => ({ status: 0, stdout: typeof data === 'string' ? data : JSON.stringify(data), stderr: '' });
const missing = { status: 1, stdout: '', stderr: '404 Not Found' };
const account = { id: 12345, login: 'anna-example', name: 'Anna Example', email: null };
const team = { id: 'team_example', slug: 'example-company', name: 'Example', billing: { plan: 'pro' } };
const fixture = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'oregano-standard-test-')); const coreRoot = join(root, 'core'); const setupRoot = join(root, 'new-company');
  mkdirSync(join(coreRoot, 'packages/runner-vercel'), { recursive: true }); mkdirSync(setupRoot);
  writeFileSync(join(coreRoot, 'packages/runner-vercel/vercel.json'), '{}');
  const coreIdentity = { root: coreRoot, repository: 'oregano-os/oregano', ref: 'a'.repeat(40), core_version: CORE_VERSION, workbench_version: WORKBENCH_VERSION, clean: true };
  try { return await fn({ root: setupRoot, coreRoot, coreIdentity }); } finally { rmSync(root, { recursive: true, force: true }); }
};
function discovery({ organizations = [], plan = 'pro', collide = false } = {}) {
  const calls = [];
  return { calls, run(file, args) {
    calls.push([file, ...args]);
    if (args[0] === '--version') return ok(file === 'pnpm' ? PNPM_VERSION : file === 'vercel' ? SUPPORTED_VERCEL_CLI_VERSION : '1.0.0');
    if (file === 'gh' && args[0] === 'auth') return ok();
    if (file === 'gh' && args[1] === 'user') return args.includes('--jq') ? ok(account.login) : ok(account);
    if (file === 'gh' && args.includes('user/orgs')) return ok([organizations]);
    if (file === 'gh' && args[1]?.startsWith('repos/')) return collide && !args[1].includes('-2-') ? ok({}) : missing;
    if (file === 'vercel' && ['integration', 'connect'].includes(args[0])) return ok([]);
    if (file === 'vercel' && args[0] === 'whoami') return ok('anna');
    if (file === 'vercel' && args[1]?.startsWith('/v2/teams?')) return ok({ teams: [team], pagination: { next: null } });
    if (file === 'vercel' && args[1] === '/v2/teams/team_example') return ok({ ...team, billing: { plan } });
    if (file === 'vercel' && args[1]?.startsWith('/v9/projects/')) return missing;
    throw new Error(`Unexpected provider command ${file} ${args.join(' ')}`);
  } };
}

test('standard setup asks one company field, then one concrete review and no technical fields', () => fixture(async (f) => {
  const executor = discovery();
  const first = await runStandardSetup({ ...f, executor });
  assert.equal(first.type, 'input'); assert.equal(first.field, 'company_name');
  const review = await runStandardSetup({ ...f, executor, reply: { action: 'answer', values: { company_name: 'Example Company' } } });
  assert.equal(review.type, 'review', JSON.stringify(review));
  assert.equal(review.summary.responsible_person, account.name);
  assert.equal(review.summary.github, 'anna-example/example-company-companyos');
  assert.match(review.summary.includes, /first production deployment/);
  const session = JSON.parse(readFileSync(join(f.root, '.companyos-bootstrap/standard-setup.json')));
  assert.equal(session.free_text_inputs, 1); assert.equal(session.confirmations, 0);
  assert.equal(existsSync(session.scope.workspace), false);
  assert.equal(existsSync(join(f.root, '.companyos-bootstrap/live-state.json')), false);
  assert.ok(!executor.calls.some((call) => call.includes('create') || call.includes('deploy') || call.includes('PUT')));
}));

test('multiple accounts are a real selection, defaults and edits remain one review', () => fixture(async (f) => {
  const executor = discovery({ organizations: [{ id: 222, login: 'example-org' }] });
  const selected = await runStandardSetup({ ...f, executor }); assert.equal(selected.type, 'choice'); assert.equal(selected.field, 'github_owner');
  const review = await runStandardSetup({ ...f, executor, reply: { action: 'answer', values: { github_owner: 'example-org', company_name: 'Example', language: 'de', timezone: 'Europe/Berlin' } } });
  assert.equal(review.type, 'review');
  const edited = await runStandardSetup({ ...f, executor, reply: { action: 'edit', values: { company_name: 'New Example' } } });
  assert.notEqual(edited.revision, review.revision);
  const stale = await runStandardSetup({ ...f, executor, reply: { action: 'confirm', revision: review.revision } });
  assert.equal(stale.type, 'recovery'); assert.match(stale.message, /summary/);
  assert.equal(existsSync(join(f.root, '.companyos-bootstrap/live-state.json')), false);
}));

test('Hobby is detected before company intake or mutations', () => fixture(async (f) => {
  const result = await runStandardSetup({ ...f, executor: discovery({ plan: 'hobby' }) });
  assert.equal(result.type, 'action'); assert.equal(result.action.type, 'upgrade-vercel-plan');
}));

function candidateFixture(f) {
  const platform = `${process.platform}-${process.arch}`;
  const bootstrap = join(f.root, '.companyos-bootstrap'); mkdirSync(bootstrap);
  const coreRoot = join(bootstrap, `oregano-test-${f.coreIdentity.ref}-${platform}`); renameSync(f.coreRoot, coreRoot);
  const candidate = { version: 1, kind: 'unpublished-setup-candidate', core_repository: 'oregano-os/oregano', requirements: { node: '>=24' }, platform, core_commit: f.coreIdentity.ref, archive: `oregano-setup-${platform}.tar.gz`, sha256: 'd'.repeat(64) };
  const receipt = { version: 1, distribution: 'candidate', core_commit: candidate.core_commit, platform, candidate, manifest_sha256: createHash('sha256').update(JSON.stringify(candidate)).digest('hex') };
  const receiptPath = join(bootstrap, 'installation.json'); writeFileSync(receiptPath, JSON.stringify(receipt));
  const options = { ...f, coreRoot, candidate, coreIdentity: { ...f.coreIdentity, root: coreRoot } };
  return { options, bootstrap, candidate, receipt, receiptPath };
}

test('candidate setup checks source availability before resources, labels its review, and binds resume', () => fixture(async (f) => {
  const { options, bootstrap, candidate, receipt, receiptPath } = candidateFixture(f);
  const missingSource = discovery();
  const blocked = await runStandardSetup({ ...options, executor: missingSource });
  assert.equal(blocked.action.type, 'publish-candidate-source');
  assert.ok(!missingSource.calls.some((call) => call.includes('create') || call.includes('deploy')));
  const base = discovery();
  const executor = { run(file,args,opts) { return file === 'gh' && args[1]?.includes('/git/commits/') ? ok({ sha: candidate.core_commit }) : base.run(file,args,opts); } };
  const review = await runStandardSetup({ ...options, executor, reply: { action: 'answer', values: { company_name: 'Candidate Company' } } });
  assert.equal(review.type, 'review', JSON.stringify(review)); assert.equal(review.summary.installation, 'Unpublished test candidate');
  assert.equal(review.summary.core_commit, candidate.core_commit);
  const session = JSON.parse(readFileSync(join(bootstrap, 'standard-setup.json')));
  assert.equal(session.scope.distribution.manifest_sha256, receipt.manifest_sha256);
  // Removing the receipt must not convert the authorized candidate into a stable run.
  rmSync(receiptPath);
  const changed = await runStandardSetup({ ...options, executor, reply: { action: 'confirm', revision: review.revision } });
  assert.equal(changed.type, 'recovery'); assert.match(changed.message, /distribution changed/);
  assert.ok(!base.calls.some((call) => call.includes('create') || call.includes('deploy')));
}));

test('a changed setup or adoption cannot reuse fresh authority', () => fixture(async (f) => {
  const core = { root: f.coreRoot, repository: f.coreIdentity.repository, ref: f.coreIdentity.ref, version: f.coreIdentity.core_version, workbench_version: WORKBENCH_VERSION };
  const scope = standardSetupScope({ root: f.root, core, account, owner: account, team, companyName: 'Example' });
  const state = createFreshSetupState(scope, setupDigest(scope));
  assert.doesNotThrow(() => assertFreshSetupAuthority(state));
  state.answers = { ...state.answers, vercel_project_mode: 'adopt' };
  assert.throws(() => assertFreshSetupAuthority(state), /decision/);
  assert.throws(() => createFreshSetupState(scope, 'wrong'), /Confirm/);
}));

for (const distribution of [{ kind: 'stable' }, { kind: 'candidate', manifest_sha256: 'e'.repeat(64) }]) test(`fresh ${distribution.kind} materialization creates one operating version and never opens an activation PR`, () => fixture(async (f) => {
  const core = { root: f.coreRoot, repository: f.coreIdentity.repository, ref: f.coreIdentity.ref, version: f.coreIdentity.core_version, workbench_version: WORKBENCH_VERSION };
  const scope = standardSetupScope({ root: f.root, core, distribution, account, owner: account, team, companyName: 'Example' });
  const state = createFreshSetupState(scope, setupDigest(scope)); state.phase = 'fresh-workspace';
  state.resources.slack = { team_id: 'T12345678', user_id: 'U12345678' };
  const statePath = join(f.root, 'state.json'); writeLiveSetupState(statePath, state);
  const reads = discovery();
  const result = await advanceLiveSetup({ statePath, executor: { run(file,args,options) { if (file === 'gh' && args[0] === 'auth') return { status: 1, stdout: '', stderr: 'login required' }; return reads.run(file,args,options); } } });
  assert.equal(result.state.phase, 'github-auth', JSON.stringify(result));
  assert.match(readFileSync(join(scope.workspace, 'company.md'), 'utf8'), /workspace_mode: operating/);
  assert.match(readFileSync(join(scope.workspace, 'company.md'), 'utf8'), /workspace_version: 0.1.0/);
  assert.ok(existsSync(join(scope.workspace, 'agents/oregano/instructions.md')));
  assert.ok(existsSync(join(scope.workspace, '.companyos/initialization.json')));
  const workflow = readFileSync(join(scope.workspace, '.github/workflows/check.yml'), 'utf8');
  assert.match(workflow, /push:\n    branches: \[main\]/);
  if (distribution.kind === 'candidate') {
    assert.match(workflow, /Install exact unpublished candidate Workbench/);
    assert.match(workflow, /pnpm install --frozen-lockfile/);
    assert.ok(workflow.includes(`ref: ${core.ref}`));
    assert.ok(workflow.includes(`test "$(git rev-parse HEAD)" = "${core.ref}"`));
    assert.doesNotMatch(workflow, /releases\/tags|installCompanyOS|release-id/);
  } else {
    assert.match(workflow, /Acquire verified release Workbench/);
    assert.doesNotMatch(workflow, /pnpm install/);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(scope.workspace, '.companyos/initialization.json'))).distribution, distribution);
  assert.ok(!reads.calls.some((call) => call[1] === 'pr'));
  const resumed = readLiveSetupState(statePath); resumed.phase = 'fresh-workspace'; writeLiveSetupState(statePath, resumed);
  writeFileSync(join(scope.workspace, 'company.md'), 'changed');
  const changed = await advanceLiveSetup({ statePath, executor: reads }); assert.equal(changed.status, 'blocked');
}));

const { COMPANY_DATABASE_MANIFEST: manifest, COMPANY_DATABASE_MANIFEST_DIGEST: manifestDigest } = await import('../../state-postgres/database-bootstrap.ts');
const qualification = () => ({ receiptVersion: 1, status: 'qualified', manifestId: manifest.id, manifestVersion: manifest.version, manifestDigest, qualifiedAt: new Date().toISOString(), schemas: Object.fromEntries(Object.entries(manifest.schemas).map(([key,value]) => [{companyos_knowledge:'companyosKnowledge',companyos_records:'companyosRecords'}[key] ?? key, { tableCount: value.tables.length }])), corePageTypeCount: manifest.corePageTypes.length, features: { vector: false } });
function lifecycle(f) {
  const calls = []; const base = discovery(); let repository = false; let project = false; let proof = false; let check = false;
  const commit = 'b'.repeat(40); const hash = 'c'.repeat(64); const tools = 'd'.repeat(64);
  const executor = { run(file,args,options={}) {
    calls.push([file,...args]);
    if (file === 'git' && args[0] === '-C') {
      if (args[2] === 'rev-parse') return ok(args[3] === 'HEAD' ? (realpathSync(args[1]) === realpathSync(f.coreRoot) ? f.coreIdentity.ref : commit) : 'true');
      if (args[2] === 'branch') return ok('main');
      return ok('');
    }
    if (file === 'gh' && args[1]?.includes('/git/commits/')) return ok({ sha: f.coreIdentity.ref });
    if (file === 'gh' && args[0] === 'repo') {
      if (args[1] === 'create') { repository = true; return ok(); }
      return repository ? ok({ nameWithOwner: 'anna-example/example-companyos', visibility: 'PRIVATE', url: 'https://github.com/anna-example/example-companyos' }) : missing;
    }
    if (file === 'gh' && args.includes('PUT')) return missing;
    if (file === 'gh' && args[1]?.endsWith('/protection')) return missing;
    if (file === 'gh' && args[1]?.endsWith('/check-runs')) return ok({ check_runs: check ? [{ id: 111, name: 'check', head_sha: commit, app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success' }] : [] });
    if ((file === 'pnpm' && args[0] === 'companyos') || (file === process.execPath && args[1] === 'build')) {
      writeFileSync(args[args.indexOf('--output')+1], JSON.stringify({ artifactHash: hash, provenance: { coreCommit: f.coreIdentity.ref, workspaceCommit: commit, resolvedToolSetHash: tools } })); return ok();
    }
    if (file === 'vercel') {
      if (args[0] === 'project') { if (args[1] === 'add') { project=true;return ok(); } return project ? ok() : missing; }
      if (args[0] === 'link') { const cwd=args[args.indexOf('--cwd')+1]; mkdirSync(join(cwd,'.vercel'), { recursive:true }); writeFileSync(join(cwd,'.vercel/project.json'), JSON.stringify({projectId:'prj_example'}));return ok(); }
      if (args[1]?.startsWith('/v9/projects/') && project) return ok({rootDirectory:'packages/runner-vercel',framework:'nextjs',sourceFilesOutsideRootDirectory:true});
      if (args[0] === 'integration' && args[1] === 'add') return ok({resource:{id:'store_example',uid:'neon/store-example',name:'example-companyos-db'}});
      if (f.candidate && args[0] === 'connect' && args[1] === 'list') return ok([{ id: 'scl_existing', uid: 'slack/oregano', name: 'Oregano-slack' }]);
      if (args[0] === 'connect' && args[1] === 'create') { const name=args[args.indexOf('--name')+1]; return ok({connector:{id:'scl_example',uid:`slack/${name}`,name}}); }
      if (args[0] === 'connect' && args[1] === 'attach') return ok({id:'destination_example',path:'/api/webhooks/slack'});
      if (args[0] === 'connect' && args[1] === 'token') { assert.equal(args.includes('--subject'), false); return ok({token:'synthetic-human'}); }
      if (args[0] === 'api' && args[1]?.startsWith('/v1/connect/connectors/')) return ok({id:'scl_example',uid:decodeURIComponent(args[1].split('/').at(-1)),service:'slack',defaultInstallationId:'T12345678',data:{appId:'A12345678',slackTeam:{id:'T12345678'},clientSecret:'synthetic-secret-discarded'}});
      if (args[0] === 'env') {
        if (args[1] === 'list') return ok([]);
        if (args[1] === 'add') return ok();
        if (args.includes('prepare')) return ok({ok:true,operation:'bootstrap',qualification:qualification()});
        if (args.includes('--exchange')) return proof ? ok({ok:true,conversation_entries:2,assistant_entries:1,model_evidence_entries:1,first_response_at:new Date().toISOString()}) : {status:2,stdout:'',stderr:''};
      }
      if (args[0] === 'deploy') return ok({id:'dpl_example',url:'oregano.example.test'});
      if (args[0] === 'inspect') return ok({id:'dpl_example',readyState:'READY',target:'production',aliases:['oregano.production.example.test']});
    }
    return base.run(file,args,options);
  } };
  const fetchImpl = async (url,options) => { if (url === 'https://oregano.example.test/api/health') throw new Error('Deployment protection requires login'); return ({ok:true,status:200,json:async()=> url.includes('slack.com') ? {ok:true,team:{id:'T12345678',name:'Example'},user:{id:'U12345678'}} : {ok:true,status:'ready',artifactHash:hash,coreCommit:f.coreIdentity.ref,workspaceCommit:commit,resolvedToolSetHash:tools,agent:'oregano',tools:[],modelRoute:'vercel-ai-gateway',model:'openai/gpt-5.4-nano',databaseManifestDigest:manifestDigest,deploymentId:'dpl_example'}}); };
  return {executor,fetchImpl,calls,passCheck(){check=true;},respond(){proof=true;}};
}

for (const kind of ['stable', 'candidate']) test(`one ${kind} decision reaches production and a natural Slack exchange; repeated resume never deploys twice`, () => fixture(async (f) => {
  if (kind === 'candidate') f = candidateFixture(f).options;
  const live = lifecycle(f); const options={...f,...live};
  const review = await runStandardSetup({...options,reply:{action:'answer',values:{company_name:'Example'}}});
  assert.equal(review.type,'review',JSON.stringify(review));
  const waiting = await runStandardSetup({...options,reply:{action:'confirm',revision:review.revision}});
  assert.equal(waiting.action?.type,'wait-for-required-check',JSON.stringify(waiting));
  assert.equal(live.calls.filter((call)=>call[1]==='deploy').length,0);
  live.passCheck();
  const slack = await runStandardSetup({...options,reply:{action:'confirm',revision:review.revision}});
  assert.equal(slack.action?.type,'open-slack',JSON.stringify(slack));
  assert.match(slack.action.url,/slack:\/\/app\?team=T12345678&id=A12345678&tab=messages/);
  assert.doesNotMatch(JSON.stringify(slack),/nonce|Setup-Test|confirmation_hash/);
  live.respond();
  const result=await runStandardSetup({...options,reply:{action:'retry'}});
  assert.equal(result.type,'complete',JSON.stringify(result));assert.equal(result.metrics.confirmations,1);
  const repeated=await runStandardSetup({...options,reply:{action:'confirm',revision:review.revision}});assert.equal(repeated.type,'complete');
  assert.equal(live.calls.filter((call)=>call[1]==='deploy').length,1);
  assert.equal(live.calls.filter((call)=>call[0]==='gh'&&call[1]==='pr').length,0);
  const state=readLiveSetupState(join(f.root,'.companyos-bootstrap/live-state.json'));
  assert.equal(state.fresh.initialization.check,'passed');assert.deepEqual(state.operating,{});
  assert.equal(state.schema_version,5);assert.equal(state.verification.database.ok,true);
  assert.doesNotMatch(JSON.stringify(state), /synthetic-secret-discarded|synthetic-human/);
  assert.equal(result.timing.distribution,kind);
  if (kind === 'candidate') {
    assert.match(state.resources.slack.uid, /^slack\/oregano-test-[0-9a-f]{12}$/);
    assert.ok(live.calls.filter(call=>call[0]==='vercel'&&call[1]==='connect'&&['attach','token'].includes(call[2])).every(call=>call[3]===state.resources.slack.uid));
    const changed=structuredClone(state);changed.resources.slack.uid='slack/oregano';assert.throws(()=>assertFreshInitializationEvidence(changed), /Fresh initialization/);
  }
}));

test('confirmation recovers its own atomic receipt after interruption without another decision', () => fixture(async (f) => {
  const executor=discovery();
  const review=await runStandardSetup({...f,executor,reply:{action:'answer',values:{company_name:'Example'}}});
  const session=JSON.parse(readFileSync(join(f.root,'.companyos-bootstrap/standard-setup.json')));
  writeLiveSetupState(join(f.root,'.companyos-bootstrap/live-state.json'),createFreshSetupState(session.scope,review.revision));
  const live=lifecycle(f);
  const resumed=await runStandardSetup({...f,...live,reply:{action:'retry'}});
  assert.equal(resumed.action?.type,'wait-for-required-check',JSON.stringify(resumed));
  assert.equal(JSON.parse(readFileSync(join(f.root,'.companyos-bootstrap/standard-setup.json'))).confirmations,1);
}));

test('cancellation and changed provider identity cannot create or deploy', () => fixture(async (f) => {
  const live=lifecycle(f);const options={...f,...live};
  const review=await runStandardSetup({...options,reply:{action:'answer',values:{company_name:'Example'}}});
  const changed={run(file,args,opts){if(file==='gh'&&args[1]==='user')return ok({...account,id:55555});return live.executor.run(file,args,opts);}};
  const refused=await runStandardSetup({...options,executor:changed,reply:{action:'confirm',revision:review.revision}});
  assert.equal(refused.type,'recovery');assert.match(refused.message,/person changed/);
  const cancel=await runStandardSetup({...options,reply:{action:'cancel'}});assert.equal(cancel.type,'cancelled');
  assert.equal((await runStandardSetup(options)).type,'cancelled');
  assert.equal(live.calls.filter((call)=>call.includes('create')||call[1]==='deploy').length,0);
}));

test('an interrupted first deployment is recovered by session metadata without another deploy or confirmation',()=>fixture(async(f)=>{
 const live=lifecycle(f);let lost=false;let recoveryReads=0;
 const executor={run(file,args,options){
  if(file==='vercel'&&args[0]==='deploy') { const result=live.executor.run(file,args,options);if(!lost){lost=true;return {status:1,stdout:'',stderr:'connection lost after submission'};}return result; }
  if(file==='vercel'&&args[0]==='list') { recoveryReads++;assert.ok(args.includes('--meta'));assert.ok(args.some(item=>item.startsWith('oreganoSetup=')));return ok({deployments:[{uid:'dpl_example',url:'oregano.example.test'}]}); }
  return live.executor.run(file,args,options);
 }};
 const options={...f,...live,executor};
 const review=await runStandardSetup({...options,reply:{action:'answer',values:{company_name:'Example'}}});live.passCheck();
 const interrupted=await runStandardSetup({...options,reply:{action:'confirm',revision:review.revision}});
 assert.equal(interrupted.type,'recovery');assert.match(interrupted.message,/connection lost/);
 const resumed=await runStandardSetup({...options,reply:{action:'retry'}});assert.equal(resumed.action?.type,'open-slack',JSON.stringify(resumed));
 live.respond();assert.equal((await runStandardSetup(options)).type,'complete');
 assert.equal(recoveryReads,1);assert.equal(live.calls.filter(call=>call[1]==='deploy').length,1);
}));

test('an interrupted create cannot adopt a resource merely because its name matches',()=>fixture(async(f)=>{
 const live=lifecycle(f);let submitted=false;let creates=0;
 const executor={run(file,args,options){
  if(file==='vercel'&&args[0]==='integration'&&args[1]==='add'){submitted=true;creates++;return {status:1,stdout:'',stderr:'connection lost'};}
  if(submitted&&file==='vercel'&&args[0]==='integration'&&args[1]==='list')return ok([{id:'store_other',uid:'neon/other',name:'example-companyos-db'}]);
  return live.executor.run(file,args,options);
 }};
 const options={...f,...live,executor};const review=await runStandardSetup({...options,reply:{action:'answer',values:{company_name:'Example'}}});
 assert.equal((await runStandardSetup({...options,reply:{action:'confirm',revision:review.revision}})).type,'recovery');
 const resumed=await runStandardSetup(options);assert.equal(resumed.action?.type,'reconcile-provider-receipt');assert.match(resumed.message,/matching name alone/);
 assert.equal(creates,1);assert.equal(live.calls.filter(call=>call[1]==='deploy').length,0);
}));

test('temporary read failures use bounded retries without creating resources',()=>fixture(async(f)=>{
 const base=discovery();let reads=0;
 const executor={run(file,args,options){if(file==='gh'&&args[1]==='user'&&++reads<3)return {status:1,stdout:'',stderr:'503 temporarily unavailable'};return base.run(file,args,options);}};
 const result=await runStandardSetup({...f,executor});assert.equal(result.type,'input');assert.equal(reads,3);
 assert.equal(base.calls.filter(call=>call.includes('create')).length,0);
}));
