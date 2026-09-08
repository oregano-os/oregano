import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdirSync,mkdtempSync,writeFileSync,symlinkSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {packageForExecutable} from '../../../scripts/build-setup-bundle.mjs';

test('installer package resolution follows both package symlinks and action-setup shell shims',t=>{
 const root=mkdtempSync(join(tmpdir(),'installer-package-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const pkg=join(root,'node_modules/pnpm');mkdirSync(join(pkg,'bin'),{recursive:true});
 writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'pnpm',version:'11.16.0'}));
 writeFileSync(join(pkg,'bin/pnpm.cjs'),'// Synthetic executable; never executed.\n');
 const linked=join(root,'linked-bin');mkdirSync(linked);symlinkSync(join(pkg,'bin/pnpm.cjs'),join(linked,'pnpm'));
 assert.equal(packageForExecutable('pnpm',linked),realpathSync(pkg));
 const shim=join(root,'node_modules/.bin');mkdirSync(shim);
 writeFileSync(join(shim,'pnpm'),'#!/bin/sh\nexec node "$(dirname "$0")/../pnpm/bin/pnpm.cjs" "$@"\n');
 assert.equal(packageForExecutable('pnpm',shim),realpathSync(pkg));
 assert.throws(()=>packageForExecutable('missing',shim),/pinned missing package/);
});
