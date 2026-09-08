#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, join, resolve, delimiter } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = 'oregano-os/oregano';
export function validateSetupRelease(release, manifest, platform) {
  if (!/^\d+\.\d+\.\d+$/.test(manifest.release_version ?? '') || manifest.schema_version !== 1 || release.draft || release.prerelease || release.immutable !== true || manifest.status !== 'stable'
    || release.tag_name !== manifest.tag || manifest.tag !== `v${manifest.release_version}`
    || !/^[0-9a-f]{40}$/.test(manifest.core_commit ?? '') || manifest.core_repository !== repository
    || manifest.requirements?.node !== '>=24') throw new Error('Use one immutable stable Oregano release with matching metadata.');
  const bundle = manifest.setup_bundles?.[platform];
  if (!bundle || bundle.asset !== `oregano-setup-${platform}.tar.gz`
    || !/^[0-9a-f]{64}$/.test(bundle.sha256)) throw new Error(`This release has no installer for ${platform}. Use a supported platform or the documented source installation.`);
  return bundle;
}
export function verifySetupBytes(bytes, expected) {
  if (createHash('sha256').update(bytes).digest('hex') !== expected.replace(/^sha256:/,'')) throw new Error('The downloaded installer checksum does not match the release.');
}
export function validateSetupCandidate(manifest, platform) {
  if (manifest.version !== 1 || manifest.kind !== 'unpublished-setup-candidate'
    || manifest.core_repository !== repository || manifest.requirements?.node !== '>=24'
    || !/^[0-9a-f]{40}$/.test(manifest.core_commit ?? '') || manifest.platform !== platform
    || manifest.archive !== `oregano-setup-${platform}.tar.gz`
    || !/^[0-9a-f]{64}$/.test(manifest.sha256 ?? '')) throw new Error('Use an exact unpublished candidate receipt for this platform.');
  return manifest;
}

function extractSetupArchive(bootstrap, coreRoot, bytes, checksum, commit) {
  verifySetupBytes(bytes, checksum);
  const staging = mkdtempSync(join(bootstrap, 'download-'));
  try {
    const archive = join(staging, 'installer.tar.gz'); writeFileSync(archive, bytes, { mode: 0o600 });
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\n').filter(Boolean);
    if (entries.some((name) => !name.startsWith('oregano/') || name.split('/').includes('..'))) throw new Error('Installer archive contains an invalid path.');
    execFileSync('tar', ['-xzf', archive, '-C', staging]);
    const extracted = join(staging, 'oregano');
    if (execFileSync('git', ['-C', extracted, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== commit) throw new Error('Installer source differs from the selected commit.');
    renameSync(extracted, coreRoot);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

function launchSetup(coreRoot, entry, installation, { directory, format, reply }) {
  const result = spawnSync(process.execPath, [entry, '--directory', directory, '--started-at', installation.started_at, '--format', format, ...(reply ? ['--reply', JSON.stringify(reply)] : [])], { stdio: 'inherit', env: { ...process.env, PATH: [join(coreRoot, 'node_modules', '.bin'), process.env.PATH].join(delimiter) } });
  process.exitCode = result.status ?? 1;
}

function installCandidate({ candidate, bootstrap, installedPath, existing, platform, startedAt, launch, directory, format, reply }) {
  if (existing && (existing.version !== 1 || existing.distribution !== 'candidate')) throw new Error('A release installation cannot switch to a candidate. Use a new setup directory.');
  const manifest = validateSetupCandidate(candidate ? JSON.parse(readFileSync(resolve(candidate), 'utf8')) : existing?.candidate, platform);
  const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  if (existing && (existing.manifest_sha256 !== digest || existing.core_commit !== manifest.core_commit || existing.platform !== platform)) throw new Error('Resume with the exact original candidate and platform.');
  const coreRoot = join(bootstrap, `oregano-test-${manifest.core_commit}-${platform}`);
  if (lstatSync(coreRoot, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('The installed candidate cannot be a symbolic link.');
  if (!existsSync(coreRoot)) {
    if (!candidate) throw new Error('Restore the original candidate archive and resume with --candidate.');
    const bytes = readFileSync(join(dirname(resolve(candidate)), manifest.archive));
    extractSetupArchive(bootstrap, coreRoot, bytes, manifest.sha256, manifest.core_commit);
  }
  if (execFileSync('git', ['-C', coreRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== manifest.core_commit) throw new Error('Installed source differs from the selected candidate.');
  const entry = join(coreRoot, 'packages/cli/src/setup-entry.mjs');
  if (!existsSync(entry)) throw new Error('This candidate does not contain the standard installer.');
  const installation = existing ?? { version: 1, distribution: 'candidate', core_commit: manifest.core_commit, platform, started_at: startedAt, manifest_sha256: digest, candidate: manifest };
  writeFileSync(installedPath, `${JSON.stringify(installation, null, 2)}\n`, { mode: 0o600 });
  if (launch) launchSetup(coreRoot, entry, installation, { directory, format, reply });
  return { coreRoot, entry, installation };
}

export function readSetupDistribution(directory, coreRoot, coreCommit) {
  const path = join(directory, '.companyos-bootstrap', 'installation.json');
  if (!existsSync(path)) return { kind: 'stable' };
  if (lstatSync(path).isSymbolicLink()) throw new Error('The installation receipt cannot be a symbolic link.');
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  if (!receipt.distribution) return { kind: 'stable' };
  const manifest = validateSetupCandidate(receipt.candidate ?? {}, `${process.platform}-${process.arch}`);
  const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  if (receipt.version !== 1 || receipt.distribution !== 'candidate' || receipt.manifest_sha256 !== digest
    || receipt.core_commit !== coreCommit || manifest.core_commit !== coreCommit
    || resolve(coreRoot) !== resolve(directory, '.companyos-bootstrap', `oregano-test-${coreCommit}-${manifest.platform}`)) throw new Error('The candidate receipt does not match this installed Core.');
  return { kind: 'candidate', manifest_sha256: digest };
}

export async function installCompanyOS({ directory = process.cwd(), startedAt = new Date().toISOString(), fetchImpl = fetch, platform = `${process.platform}-${process.arch}`, launch = true, releaseId, candidate, reply, format = 'json' } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Oregano requires Node.js 24 or newer.');
  directory = resolve(directory);
  const bootstrap = join(directory,'.companyos-bootstrap');
  if (lstatSync(bootstrap, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('The bootstrap directory cannot be a symbolic link.');
  mkdirSync(bootstrap,{recursive:true,mode:0o700});
  const installedPath = join(bootstrap,'installation.json');
  if (lstatSync(installedPath, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('The installation receipt cannot be a symbolic link.');
  if (releaseId !== undefined && !/^[0-9]+$/.test(String(releaseId))) throw new Error('Provide one exact numeric GitHub Release ID.');
  const existing = existsSync(installedPath) ? JSON.parse(readFileSync(installedPath,'utf8')) : null;
  if (candidate || existing?.distribution === 'candidate') {
    if (releaseId !== undefined) throw new Error('Select either an unpublished candidate or a stable release.');
    return installCandidate({ candidate, bootstrap, installedPath, existing, platform, startedAt, launch, directory, format, reply });
  }
  const request = async (url) => {
    const response=await fetchImpl(url,{headers:{Accept:'application/vnd.github+json'}});
    if(!response.ok) throw new Error(`Release download failed (${response.status}). Retry the same installation.`);
    return response;
  };
  const manifestPath = join(bootstrap, 'release-manifest.json');
  if (lstatSync(manifestPath, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('The release manifest cannot be a symbolic link.');
  let release; let manifestBytes;
  const cachedRoot = existing?.tag ? join(bootstrap, `oregano-${existing.tag}-${platform}`) : null;
  if (existing?.manifest_sha256 && existing.release && existsSync(manifestPath) && cachedRoot && existsSync(cachedRoot)) {
    release = existing.release;
    manifestBytes = readFileSync(manifestPath);
    verifySetupBytes(manifestBytes, existing.manifest_sha256);
  } else {
    release = await (await request(`https://api.github.com/repos/${repository}/releases/${existing?.release_id ?? releaseId ?? 'latest'}`)).json();
    const manifestAsset = release.assets?.find((item) => item.name === 'release-manifest.json');
    if (!manifestAsset?.browser_download_url?.startsWith(`https://github.com/${repository}/releases/download/`) || !manifestAsset.digest?.startsWith('sha256:')) throw new Error('The release API did not provide the manifest URL and checksum.');
    manifestBytes = Buffer.from(await (await request(manifestAsset.browser_download_url)).arrayBuffer());
    verifySetupBytes(manifestBytes, manifestAsset.digest);
  }
  const asset = (name) => {
    const found=release.assets?.find((item)=>item.name===name);
    if(!found?.browser_download_url?.startsWith(`https://github.com/${repository}/releases/download/`)) throw new Error(`Release asset is missing: ${name}`);
    return found;
  };
  const manifest=JSON.parse(manifestBytes.toString('utf8'));
  const bundle=validateSetupRelease(release,manifest,platform);
  const installation = existing ?? { version:1, release_id:release.id, tag:manifest.tag, core_commit:manifest.core_commit, platform, started_at:startedAt };
  if(installation.version!==1 || installation.core_commit!==manifest.core_commit || installation.platform!==platform) throw new Error('Resume with the exact original release and platform.');
  const coreRoot=join(bootstrap,`oregano-${manifest.tag}-${platform}`);
  if (lstatSync(coreRoot, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('The installed release cannot be a symbolic link.');
  if(!existsSync(coreRoot)) {
    const bytes=Buffer.from(await (await request(asset(bundle.asset).browser_download_url)).arrayBuffer());
    extractSetupArchive(bootstrap, coreRoot, bytes, bundle.sha256, manifest.core_commit);
  }
  const commit=execFileSync('git',['-C',coreRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  if(commit!==manifest.core_commit) throw new Error('Installed source differs from the selected release.');
  const entry=join(coreRoot,'packages/cli/src/setup-entry.mjs');
  if(!existsSync(entry)) throw new Error('This release does not contain the standard installer.');
  installation.release = { id: release.id, tag_name: release.tag_name, immutable: release.immutable, draft: release.draft, prerelease: release.prerelease };
  installation.manifest_sha256 = createHash('sha256').update(manifestBytes).digest('hex');
  writeFileSync(manifestPath, manifestBytes, { mode: 0o600 });
  writeFileSync(installedPath,`${JSON.stringify(installation,null,2)}\n`,{mode:0o600});
  if (launch) launchSetup(coreRoot, entry, installation, { directory, format, reply });
  return {coreRoot,entry,installation};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const value=(name)=>process.argv.includes(name)?process.argv[process.argv.indexOf(name)+1]:undefined;
  try{
    const allowed = new Set(['--directory', '--started-at', '--release-id', '--candidate', '--reply', '--format']);
    const seen = new Set();
    for (let index = 2; index < process.argv.length; index += 2) {
      const option = process.argv[index]; const argument = process.argv[index + 1];
      if (!allowed.has(option) || seen.has(option) || !argument || argument.startsWith('--')) throw new Error('Provide each supported installer option once with its value.');
      seen.add(option);
    }
    await installCompanyOS({directory:value('--directory'),startedAt:value('--started-at'), releaseId:value('--release-id'), candidate:value('--candidate'), reply:value('--reply') ? JSON.parse(value('--reply')) : undefined, format:value('--format') ?? 'json'});
  }
  catch(error){process.stderr.write(`${error.message}\n`);process.exitCode=1;}
}
