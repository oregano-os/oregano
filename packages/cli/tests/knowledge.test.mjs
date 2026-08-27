import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const cli = join(repoRoot, "packages", "cli", "src", "cli.mjs");
const workspace = join(repoRoot, "packages", "testkit", "fixtures", "acme-casas");

const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: "utf8" });

const committedWorkspaceCopy = (root) => {
  const copy = join(root, "workspace");
  cpSync(workspace, copy, { recursive: true });
  for (const args of [
    ["init", "--quiet"],
    ["config", "user.name", "CompanyOS Test"],
    ["config", "user.email", "companyos-test@example.invalid"],
    ["add", "."],
    ["commit", "--quiet", "-m", "fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd: copy, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  return copy;
};

test("knowledge inspect reports deterministic OKF facts without a database", () => {
  const first = run("knowledge", "inspect", workspace, "--format", "json");
  const second = run("knowledge", "inspect", workspace, "--format", "json");
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(first.stdout), JSON.parse(second.stdout));
  assert.equal(JSON.parse(first.stdout).documents, 0);
});

test("knowledge build writes one immutable standalone bundle and refuses overwrite", () => {
  const root = mkdtempSync(join(tmpdir(), "company-knowledge-cli-"));
  const output = join(root, "knowledge.json");
  try {
    const cleanWorkspace = committedWorkspaceCopy(root);
    const built = run("knowledge", "build", cleanWorkspace, "--output", output);
    assert.equal(built.status, 0, built.stderr);
    const bundle = JSON.parse(readFileSync(output, "utf8"));
    assert.match(bundle.bundleHash, /^[0-9a-f]{64}$/);
    assert.equal(bundle.okfVersion, "0.1");
    const duplicate = run("knowledge", "build", cleanWorkspace, "--output", output);
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /EEXIST|exist/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge review is a bounded read-only preview unless persistence is explicit", () => {
  const reviewed = run("knowledge", "review", workspace, "--format", "json");
  assert.equal(reviewed.status, 0, reviewed.stderr);
  const result = JSON.parse(reviewed.stdout);
  assert.equal(result.mode, "preview");
  assert.equal(result.maximum_candidates, 3);
  assert.ok(result.candidates.length <= 3);
});

test("knowledge regression runs a versioned ledger without a database", () => {
  const root = mkdtempSync(join(tmpdir(), "company-knowledge-regression-"));
  const ledger = join(root, "ledger.yaml");
  try {
    writeFileSync(ledger, "version: 1\ncases:\n  - id: explicit-gap\n    query: absent-example\n    expectedPaths: []\n");
    const result = run("knowledge", "regression", workspace, "--ledger", ledger, "--format", "json");
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.passed, true);
    assert.equal(report.sampleSize, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
