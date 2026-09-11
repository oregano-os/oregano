#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function qualifySetupRuns(runs, minimumRuns = 5) {
  const groups = new Map(); const diagnostics=[]; const ids = new Set(); const releases = new Set();
  if (!Array.isArray(runs) || !Number.isInteger(minimumRuns) || minimumRuns < 5) throw new Error('Qualification requires an array and at least five runs per harness and platform.');
  for(const run of runs) {
    const label=`${run.platform}/${run.harness}`;
    if (!run.id || ids.has(run.id)) diagnostics.push(`Missing or duplicate run identity: ${run.id ?? 'unknown'}`);
    ids.add(run.id); releases.add(run.core_commit);
    if(!groups.has(label)) groups.set(label,[]);groups.get(label).push(run);
    if(run.distribution !== 'stable' || !['codex','claude-code'].includes(run.harness) || run.cache!=='cold' || run.evidence!=='live'
      || run.verified!==true || run.confirmations!==1 || !Number.isInteger(run.free_text_inputs) || run.free_text_inputs<0 || run.free_text_inputs>1 || !/^(darwin|linux)-(arm64|x64)$/.test(run.platform ?? '') || run.technical_questions!==0
      || !Number.isFinite(run.first_response_ms) || run.first_response_ms<0 || run.first_response_ms>300000
      || !Number.isFinite(run.completion_ms) || run.completion_ms<run.first_response_ms
      || !/^[0-9a-f]{40}$/.test(run.core_commit??'') || !run.started_at || !run.first_response_at
      || Date.parse(run.first_response_at)-Date.parse(run.started_at)!==run.first_response_ms) diagnostics.push(`Unqualified run: ${label}/${run.id??'unknown'}`);
  }
  for(const platform of new Set(runs.map((run)=>run.platform))) {
    for(const harness of ['codex','claude-code']) if((groups.get(`${platform}/${harness}`)?.length??0)<minimumRuns) diagnostics.push(`Need ${minimumRuns} cold live runs: ${platform}/${harness}`);
  }
  if (releases.size > 1) diagnostics.push('Qualify one exact release at a time.');
  if(!runs.length) diagnostics.push('No live installation evidence.');
  return {qualified:diagnostics.length===0,diagnostics,groups:[...groups].map(([group,items])=>{
    const times=items.map((run)=>run.first_response_ms).sort((a,b)=>a-b);
    return {group,count:items.length,median_ms:times[Math.floor(times.length/2)],maximum_ms:Math.max(...times)};
  })};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const result=qualifySetupRuns(JSON.parse(readFileSync(process.argv[2],'utf8')));
  const output=`${JSON.stringify(result,null,2)}\n`;
  if(process.argv[3])writeFileSync(process.argv[3],output);else process.stdout.write(output);
  if(!result.qualified)process.exitCode=1;
}
