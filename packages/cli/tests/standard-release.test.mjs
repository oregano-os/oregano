import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { installCompanyOS, validateSetupRelease, verifySetupBytes, readSetupDistribution } from '../../../scripts/install-companyos.mjs';
import { copyRuntimePackages } from '../../../scripts/build-setup-bundle.mjs';
import { qualifySetupRuns } from '../../../scripts/qualify-standard-setup.mjs';
import { setupReleaseMetadata } from '../src/setup/release-defaults.mjs';
import { SETUP_MODEL_PROVIDERS } from '../src/setup/model-providers.ts';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const withTemp = async (fn) => { const root=mkdtempSync(join(tmpdir(),'oregano-release-test-'));try{return await fn(root);}finally{rmSync(root,{recursive:true,force:true});} };
const put=(path,body)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof body==='string'?body:JSON.stringify(body));};

test('packaged dependencies and embedded modules remain executable after source removal and relocation',()=>withTemp((root)=>{
 const source=join(root,'source');const payload=join(root,'payload');
 put(join(source,'package.json'),{name:'fixture-a',version:'1.0.0',dependencies:{'fixture-b':'1.0.0'}});
 put(join(source,'index.cjs'),"process.stdout.write(require('fixture-b') + require('./dist/node_modules/embedded'));");
 put(join(source,'dist/node_modules/embedded/index.js'),"module.exports='embedded';");
 put(join(source,'node_modules/fixture-b/package.json'),{name:'fixture-b',version:'1.0.0',main:'index.cjs'});
 put(join(source,'node_modules/fixture-b/index.cjs'),"module.exports='resolved-';");
 assert.equal(copyRuntimePackages([{source,at:'',name:'fixture-a'}],payload),2);
 rmSync(source,{recursive:true});const moved=join(root,'moved');renameSync(payload,moved);
 assert.ok(realpathSync(join(moved,'node_modules/fixture-a')).startsWith(realpathSync(moved)));
 assert.equal(execFileSync(process.execPath,[join(moved,'node_modules/fixture-a/index.cjs')],{encoding:'utf8'}),'resolved-embedded');
}));

test('release installation checks immutable metadata and digest, extracts the exact commit, and pins resume',()=>withTemp(async(root)=>{
 const source=join(root,'source/oregano');mkdirSync(source,{recursive:true});
 const git=(...args)=>execFileSync('git',['-C',source,...args],{encoding:'utf8'}).trim();
 git('init','-q');git('config','user.name','Release Fixture');git('config','user.email','fixture@example.invalid');
 put(join(source,'packages/cli/src/setup-entry.mjs'),'// Synthetic installer fixture.\n');git('add','.');git('commit','-qm','fixture');
 const commit=git('rev-parse','HEAD');const archive=join(root,'bundle.tar.gz');execFileSync('tar',['-czf',archive,'-C',join(root,'source'),'oregano']);
 const bytes=readFileSync(archive);const platform=`${process.platform}-${process.arch}`;const name=`oregano-setup-${platform}.tar.gz`;
 const manifest={schema_version:1,status:'stable',tag:'v1.0.0',release_version:'1.0.0',core_repository:'oregano-os/oregano',core_commit:commit,requirements:{node:'>=24'},setup_bundles:{[platform]:{asset:name,sha256:sha(bytes)}}};
 const manifestBytes=Buffer.from(JSON.stringify(manifest));const base='https://github.com/oregano-os/oregano/releases/download/v1.0.0/';
 const release={id:123,immutable:true,tag_name:'v1.0.0',draft:false,prerelease:false,assets:[{name:'release-manifest.json',browser_download_url:base+'release-manifest.json',digest:'sha256:'+sha(manifestBytes)},{name,browser_download_url:base+name}]};
 const calls=[];const fetchImpl=async(url)=>{calls.push(url);return {ok:true,status:200,json:async()=>release,arrayBuffer:async()=>url.endsWith('release-manifest.json')?manifestBytes:bytes};};
 const directory=join(root,'company');const installed=await installCompanyOS({directory,fetchImpl,launch:false});
 assert.equal(installed.installation.core_commit,commit);assert.ok(existsSync(installed.entry));
 const resumed=await installCompanyOS({directory,fetchImpl:async()=>{throw new Error('Resume must reuse the verified release cache');},launch:false});assert.equal(resumed.entry,installed.entry);
 assert.equal(calls.filter(url=>url.startsWith('https://api.github.com')).length,1, 'unchanged immutable release is reused without API discovery on each response');
 assert.equal(calls.filter(url=>url.endsWith(name)).length,1);
 assert.throws(()=>validateSetupRelease({...release,immutable:false},manifest,platform),/immutable/);
 assert.throws(()=>validateSetupRelease(release,manifest,'unsupported'),/no installer/);
 assert.throws(()=>verifySetupBytes(Buffer.from('changed'),sha(bytes)),/checksum/);
 await assert.rejects(()=>installCompanyOS({directory,candidate:join(root,'unused-candidate.json'),fetchImpl,launch:false}),/cannot switch/);
}));

test('an incomplete candidate argument cannot silently start the stable installer',()=>{
 assert.throws(()=>execFileSync(process.execPath,['scripts/install-companyos.mjs','--candidate'],{encoding:'utf8',stdio:'pipe'}), /supported installer option/);
});

test('release defaults enumerate the same maintained model recipes as the CLI',()=>{
 const metadata=setupReleaseMetadata();assert.deepEqual(metadata.supported_model_routes,Object.keys(SETUP_MODEL_PROVIDERS).sort());
 assert.equal(metadata.default_profile,'vercel-neon-slack');assert.equal(metadata.default_model_route,null);assert.equal(metadata.default_model,null);
 assert.equal(metadata.model_provider_selection,'required');
 assert.deepEqual(metadata.model_provider_options.map(({label,route})=>({label,route})),[{label:'OpenAI',route:'openai-direct'},{label:'Anthropic',route:'anthropic-direct'}]);
});

test('an unpublished bundle installs offline, binds resume, and never requests a release',()=>withTemp(async(root)=>{
 const source=join(root,'source/oregano');mkdirSync(source,{recursive:true});
 const git=(...args)=>execFileSync('git',['-C',source,...args],{encoding:'utf8'}).trim();
 git('init','-q');git('config','user.name','Candidate Fixture');git('config','user.email','fixture@example.invalid');
 put(join(source,'packages/cli/src/setup-entry.mjs'),'// Synthetic candidate fixture.\n');git('add','.');git('commit','-qm','candidate fixture');
 const commit=git('rev-parse','HEAD');const platform=`${process.platform}-${process.arch}`;
 const archive=join(root,`oregano-setup-${platform}.tar.gz`);execFileSync('tar',['-czf',archive,'-C',join(root,'source'),'oregano']);
 const bytes=readFileSync(archive);
 const manifest={version:1,kind:'unpublished-setup-candidate',core_repository:'oregano-os/oregano',requirements:{node:'>=24'},core_commit:commit,platform,archive:archive.split('/').at(-1),sha256:sha(bytes)};
 const candidate=join(root,'candidate.json');put(candidate,manifest);
 const fetchImpl=async()=>{throw new Error('Candidate installation must not request a release');};
 const directory=join(root,'company');
 const installed=await installCompanyOS({directory,candidate,fetchImpl,launch:false});
 assert.equal(installed.installation.distribution,'candidate');assert.equal(installed.installation.core_commit,commit);
 assert.equal(readSetupDistribution(directory,installed.coreRoot,commit).manifest_sha256,installed.installation.manifest_sha256);
 assert.throws(()=>readSetupDistribution(directory,source,commit),/does not match/);
 await assert.rejects(()=>installCompanyOS({directory,releaseId:123,fetchImpl,launch:false}),/either/);
 put(candidate,{...manifest,sha256:'a'.repeat(64)});
 await assert.rejects(()=>installCompanyOS({directory,candidate,fetchImpl,launch:false}),/original candidate/);
 await assert.rejects(()=>installCompanyOS({directory:join(root,'tampered'),candidate,fetchImpl,launch:false}),/checksum/);
 put(candidate,{...manifest,core_commit:'b'.repeat(40)});
 await assert.rejects(()=>installCompanyOS({directory:join(root,'wrong-commit'),candidate,fetchImpl,launch:false}),/selected commit/);
 put(candidate,{...manifest,platform:'unsupported'});
 await assert.rejects(()=>installCompanyOS({directory:join(root,'wrong-platform'),candidate,fetchImpl,launch:false}),/this platform/);
 put(candidate,{...manifest,archive:'../escape.tar.gz'});
 await assert.rejects(()=>installCompanyOS({directory:join(root,'bad-path'),candidate,fetchImpl,launch:false}),/this platform/);
 rmSync(candidate);rmSync(archive);rmSync(join(root,'source'),{recursive:true});
 const resumed=await installCompanyOS({directory,fetchImpl,launch:false});assert.equal(resumed.entry,installed.entry);
 const receipt=join(directory,'.companyos-bootstrap/installation.json');
 put(receipt,{...resumed.installation,candidate:{...manifest,sha256:'c'.repeat(64)}});
 await assert.rejects(()=>installCompanyOS({directory,fetchImpl,launch:false}),/original candidate/);
 assert.throws(()=>readSetupDistribution(directory,installed.coreRoot,commit),/does not match/);
}));

test('timing qualification rejects warm, synthetic, incomplete, mixed, duplicate, and slow evidence',()=>{
 const start='2026-09-08T12:00:00.000Z';
 const runs=['codex','claude-code'].flatMap(harness=>Array.from({length:5},(_,i)=>({id:`${harness}-${i}`,harness,platform:'darwin-arm64',cache:'cold',distribution:'stable',evidence:'live',verified:true,confirmations:1,free_text_inputs:1,technical_questions:0,core_commit:'a'.repeat(40),started_at:start,first_response_at:'2026-09-08T12:04:00.000Z',first_response_ms:240000,completion_ms:245000})));
 assert.equal(qualifySetupRuns(runs).qualified,true);
 for(const patch of [{distribution:'candidate'},{distribution:undefined},{cache:'warm'},{evidence:'synthetic'},{free_text_inputs:undefined},{confirmations:2},{technical_questions:1},{verified:false},{core_commit:'b'.repeat(40)},{first_response_ms:301000},{id:runs[1].id}]) assert.equal(qualifySetupRuns(runs.map((run,i)=>i===0?{...run,...patch}:run)).qualified,false,JSON.stringify(patch));
 assert.equal(qualifySetupRuns(runs.slice(0,9)).qualified,false);assert.equal(qualifySetupRuns([]).qualified,false);
});
