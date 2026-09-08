#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const metadata = (path) => JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
export function resolveInstalledPackage(name, from) {
  const req = createRequire(join(realpathSync(from), 'package.json'));
  for (const directory of req.resolve.paths(name) ?? []) {
    const candidate = join(directory, name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
  }
  return null;
}
function packageForExecutable(name) {
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const path = join(entry, name);
    if (!existsSync(path)) continue;
    let candidate = dirname(realpathSync(path));
    while (candidate !== dirname(candidate)) {
      if (existsSync(join(candidate, 'package.json')) && metadata(candidate).name === name) return candidate;
      candidate = dirname(candidate);
    }
  }
  throw new Error(`The release builder needs the pinned ${name} package.`);
}

// Ship runtime dependencies resolved from the locked release installation.
// Each real package is copied once; relative links make the payload relocatable.
export function copyRuntimePackages(bindings, destination) {
  const copied = new Map();
  const copy = (source) => {
    source = realpathSync(source);
    if (copied.has(source)) return copied.get(source);
    const pkg = metadata(source);
    const key = `${pkg.name.replaceAll('/', '+')}@${pkg.version}-${String(copied.size).padStart(4, '0')}`;
    const target = join(destination, 'node_modules', '.oregano', key);
    copied.set(source, target);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true, filter: (path) => path === source || relative(source,path).split(/[\\/]/)[0] !== 'node_modules' });
    const required = new Set(Object.keys(pkg.dependencies ?? {}));
    const names = new Set([...required, ...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
    for (const name of names) {
      const resolved = resolveInstalledPackage(name, source);
      if (!resolved) { if (required.has(name) && !pkg.optionalDependencies?.[name]) throw new Error(`Missing locked dependency ${pkg.name} -> ${name}`); continue; }
      const dep = copy(resolved); const link = join(target,'node_modules',name);
      mkdirSync(dirname(link), { recursive: true }); if (!existsSync(link)) symlinkSync(relative(dirname(link),dep),link);
    }
    return target;
  };
  for (const { source, at, name } of bindings) {
    const target = copy(source); const link = join(destination,at,'node_modules',name);
    mkdirSync(dirname(link),{recursive:true}); if (!existsSync(link)) symlinkSync(relative(dirname(link),target),link);
  }
  return copied.size;
}

export function buildSetupBundle({ root, output, platform = `${process.platform}-${process.arch}` }) {
  root = realpathSync(root); output = resolve(output);
  if (existsSync(output)) throw new Error('Use a new bundle output directory.');
  const git = (...args) => execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
  if (git('status','--porcelain','--untracked-files=all')) throw new Error('Installer bundles require a clean release checkout.');
  const commit = git('rev-parse','HEAD');
  mkdirSync(output,{recursive:true}); const payload = join(output,'oregano');
  execFileSync('git',['clone','--quiet','--depth','1','--no-local',pathToFileURL(root).href,payload]);
  const origin = git('remote','get-url','origin');
  execFileSync('git',['-C',payload,'remote','set-url','origin',origin]);
  const bindings=[];
  for (const at of ['', 'packages/cli', 'packages/runner-vercel']) {
    const source=join(root,at); const pkg=metadata(source);
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      // Next/React execute on Vercel; the local installer does not run them.
      if (at === 'packages/runner-vercel' && ['next','react','react-dom'].includes(name)) continue;
      const dep=resolveInstalledPackage(name,source); if(!dep) throw new Error(`Install the locked release dependencies: ${name}`);
      bindings.push({source:dep,at,name});
    }
  }
  for(const name of ['vercel','@neondatabase/serverless','yaml','typescript','zod']) {
    const dep=resolveInstalledPackage(name,root); if(!dep) throw new Error(`Missing installer dependency ${name}`);
    bindings.push({source:dep,at:'',name});
  }
  const pnpmRoot=packageForExecutable('pnpm');
  const pin=metadata(root).packageManager.match(/^pnpm@([^+]+)/)?.[1];
  if(metadata(pnpmRoot).version!==pin) throw new Error('Bundle pnpm version differs from the release pin.');
  bindings.push({source:pnpmRoot,at:'',name:'pnpm'});
  const packageCount=copyRuntimePackages(bindings,payload);
  const bin=join(payload,'node_modules','.bin');mkdirSync(bin,{recursive:true});
  for(const name of ['vercel','pnpm']) {
    const pkg=metadata(join(payload,'node_modules',name));const entry=typeof pkg.bin==='string'?pkg.bin:pkg.bin[name];
    symlinkSync(relative(bin,join(payload,'node_modules',name,entry)),join(bin,name));
  }
  const archive=join(output,`oregano-setup-${platform}.tar.gz`);
  execFileSync('tar',['-czf',archive,'-C',output,'oregano']);
  const receipt={version:1,kind:'unpublished-setup-candidate',core_repository:'oregano-os/oregano',requirements:{node:'>=24'},platform,core_commit:commit,package_count:packageCount,archive:archive.split('/').at(-1),sha256:createHash('sha256').update(readFileSync(archive)).digest('hex')};
  writeFileSync(join(output,`oregano-setup-${platform}.json`),`${JSON.stringify(receipt,null,2)}\n`);
  return {payload,archive,receipt};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=fileURLToPath(new URL('..',import.meta.url));
  const output=process.argv[2]; if(!output) throw new Error('Provide a new output directory.');
  process.stdout.write(`${JSON.stringify(buildSetupBundle({root,output}),null,2)}\n`);
}
