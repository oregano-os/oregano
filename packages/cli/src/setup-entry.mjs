#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, delimiter, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { runStandardSetup } from './setup/standard-setup.mjs';

export async function standardSetupMain(args = process.argv.slice(2), coreRoot = fileURLToPath(new URL('../../../', import.meta.url))) {
  const value = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const options = new Set(['--directory', '--format', '--reply', '--started-at', '--timing-report', '--harness', '--cache']);
  for (let i = 0; i < args.length; i += 2) {
    if (!options.has(args[i]) || args[i + 1] === undefined || args[i + 1].startsWith('--')) throw new Error('Unsupported standard setup argument. Existing states and adoption require the explicit --profile flow.');
  }
  const format = value('--format') ?? 'human';
  if (!['human', 'json'].includes(format)) throw new Error('Setup format must be human or json.');
  let reply = value('--reply') ? JSON.parse(value('--reply')) : undefined;
  const directory = value('--directory') ?? process.cwd();
  process.env.PATH = [join(coreRoot, 'node_modules', '.bin'), process.env.PATH].join(delimiter);
  const terminal = format === 'human' && process.stdin.isTTY && process.stdout.isTTY;
  const rl = terminal ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    for (;;) {
      const event = await runStandardSetup({ root: directory, coreRoot, reply, startedAt: value('--started-at') });
      if (event.type === 'complete' && value('--timing-report')) {
        if (!['codex', 'claude-code'].includes(value('--harness')) || !['cold', 'warm'].includes(value('--cache'))) throw new Error('Timing reports require the actual --harness and --cache classification.');
        writeFileSync(resolve(value('--timing-report')), `${JSON.stringify({ ...event.timing, ...event.metrics, harness: value('--harness'), cache: value('--cache'), evidence: 'live', verified: true }, null, 2)}\n`, { mode: 0o600 });
      }
      if (!terminal) {
        process.stdout.write(`${JSON.stringify(event, null, 2)}\n`);
        if (event.type === 'recovery') process.exitCode = 1;
        return event;
      }
      process.stdout.write(`\n${event.message}\n`);
      if (event.type === 'complete' || event.type === 'cancelled') { if (event.url) process.stdout.write(`${event.url}\n`); return event; }
      if (event.type === 'input') reply = { action: 'answer', values: { [event.field]: await rl.question('> ') } };
      else if (event.type === 'choice') {
        event.options.forEach((item, index) => process.stdout.write(`${index + 1}. ${item.label}\n`));
        const index = Number(await rl.question('> ')) - 1;
        if (!event.options[index]) { reply = { action: 'retry' }; continue; }
        reply = { action: 'answer', values: { [event.field]: event.options[index].value } };
      } else if (event.type === 'review') {
        for (const [key, item] of Object.entries(event.summary)) process.stdout.write(`${key.replaceAll('_', ' ')}: ${typeof item === 'object' ? JSON.stringify(item) : item}\n`);
        const decision = (await rl.question('Set up / Edit / Cancel: ')).trim().toLowerCase();
        if (decision === 'set up') reply = { action: 'confirm', revision: event.revision };
        else if (decision === 'cancel') reply = { action: 'cancel' };
        else if (decision === 'edit') {
          const field = (await rl.question('Change company name, language, timezone, or responsible name: ')).trim().replaceAll(' ', '_');
          if (!['company_name', 'language', 'timezone', 'responsible_name'].includes(field)) { reply = { action: 'retry' }; continue; }
          reply = { action: 'edit', values: { [field]: await rl.question('New value: ') } };
        } else reply = { action: 'retry' };
      } else if (event.action?.type === 'wait-for-required-check') {
        await new Promise((done) => setTimeout(done, event.action.retry_after_ms ?? 2000)); reply = { action: 'retry' };
      } else {
        if (event.action?.url) process.stdout.write(`${event.action.url}\n`);
        if (event.action?.command) process.stdout.write(`Installer action: ${Array.isArray(event.action.command) ? event.action.command.join(' ') : event.action.command}\n`);
        await rl.question('Continue after completing the account action, or interrupt to resume later. ');
        reply = { action: 'retry' };
      }
    }
  } finally { rl?.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await standardSetupMain(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
