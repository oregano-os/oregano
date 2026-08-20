// The mechanical guard behind DECISIONS #13: the core must not know any
// company. This is the grep acceptance of the neutralization sprint, turned
// into a test that runs on every commit instead of by memory.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const REPO = join(import.meta.dirname, "..", "..", "..");
const PACKAGES = join(REPO, "packages");

/** All source files of the core, excluding fixtures and generated artifacts. */
function coreSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", ".eve", ".output", ".nitro", "fixtures", "sandbox"].includes(entry.name)) continue;
        walk(p);
        continue;
      }
      if (!/\.(ts|mjs|js|sql)$/.test(entry.name)) continue;
      if (entry.name.endsWith(".generated.ts")) continue; // artifact, gitignored
      if (entry.name.endsWith(".test.ts")) continue; // tests NAME the things they guard against
      out.push(p);
    }
  };
  walk(PACKAGES);
  return out;
}

const sources = coreSources();

/**
 * Only CODE counts. Comments may name a company — explaining why an assumption
 * was wrong is documentation, not a dependency. Strips line comments and the
 * bodies of block comments; keeps everything the runtime actually executes.
 */
function codeLines(text: string): { line: string; number: number }[] {
  const out: { line: string; number: number }[] = [];
  let inBlock = false;
  text.split("\n").forEach((raw, i) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) return;
      line = line.slice(end + 2);
      inBlock = false;
    }
    const blockStart = line.indexOf("/*");
    if (blockStart !== -1) {
      const end = line.indexOf("*/", blockStart);
      if (end === -1) {
        inBlock = true;
        line = line.slice(0, blockStart);
      } else {
        line = line.slice(0, blockStart) + line.slice(end + 2);
      }
    }
    line = line.replace(/\/\/.*$/, "").replace(/^\s*(--|#).*$/, "");
    if (line.trim()) out.push({ line, number: i + 1 });
  });
  return out;
}

test("core sources exist and are being scanned", () => {
  assert.ok(sources.length > 15, `expected to scan the core, found ${sources.length} files`);
});

test("no company name is hardcoded in core logic", () => {
  const offenders: string[] = [];
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    for (const { line, number } of codeLines(text)) {
      if (!/isle[nñ]o/i.test(line)) continue;
      offenders.push(`${relative(REPO, file)}:${number}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `company names leaked into core:\n${offenders.join("\n")}`);
});

test("no company Slack channel id or workspace id in core", () => {
  const offenders: string[] = [];
  for (const file of sources) {
    for (const { line, number } of codeLines(readFileSync(file, "utf8"))) {
      // Real Slack ids of the test workspace, e.g. T0BK…/C0BK…
      if (/["'](T0B|C0B)[A-Z0-9]{6,}["']/.test(line)) {
        offenders.push(`${relative(REPO, file)}:${number}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `Slack ids leaked into core:\n${offenders.join("\n")}`);
});

test("no company board id in core", () => {
  const offenders: string[] = [];
  for (const file of sources) {
    for (const { line, number } of codeLines(readFileSync(file, "utf8"))) {
      if (/18396342476/.test(line)) offenders.push(`${relative(REPO, file)}:${number}`);
    }
  }
  assert.deepEqual(offenders, [], `board id leaked into core:\n${offenders.join("\n")}`);
});

test("no agent role name is assumed in core logic", () => {
  const offenders: string[] = [];
  for (const file of sources) {
    for (const { line, number } of codeLines(readFileSync(file, "utf8"))) {
      if (/agents\/(sales|ops|steering|sprint)\//.test(line) && !/agents\/\$\{/.test(line)) {
        offenders.push(`${relative(REPO, file)}:${number}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `agent role names assumed in core:\n${offenders.join("\n")}`);
});

test("the company directory does not exist inside the core repo", () => {
  // DECISIONS #1: after the split the core holds no company files at all.
  assert.throws(() => statSync(join(REPO, "companies")), /ENOENT/);
});

test("provider-neutral Core packages never import a deployment Runner directly", () => {
  const offenders: string[] = [];
  for (const file of sources) {
    if (relative(REPO, file).startsWith("packages/runner-vercel/")) continue;
    for (const { line, number } of codeLines(readFileSync(file, "utf8"))) {
      if (/from\s+["'](?:eve|@vercel\/connect)[/"']/.test(line)) offenders.push(`${relative(REPO, file)}:${number}`);
    }
  }
  assert.deepEqual(offenders, [], `retired runner import in Core:\n${offenders.join("\n")}`);
});
