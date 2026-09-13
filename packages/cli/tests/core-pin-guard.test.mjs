import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { assertWorkspaceCoreCommit } from "../src/compatibility.mjs";

const coreRoot = resolve(import.meta.dirname, "../../..");
const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: coreRoot, encoding: "utf8" }).trim();

test("build pin requires exact SHA equality even for the same release version", () => {
  const root = mkdtempSync(join(tmpdir(), "core-pin-"));
  try {
    mkdirSync(join(root, ".companyos"));
    writeFileSync(join(root, "company.md"), "# Synthetic Company\n");
    const path = join(root, ".companyos/compatibility.yaml");
    const pin = (ref) => writeFileSync(path, `version: 1\ncore:\n  ref: ${ref}\n  version: 0.15.0\n`);
    pin(actual);
    assert.doesNotThrow(() => assertWorkspaceCoreCommit(root, actual));
    const other = actual === "a".repeat(40) ? "b".repeat(40) : "a".repeat(40);
    pin(other);
    assert.throws(() => assertWorkspaceCoreCommit(root, actual), /Core mismatch/);
    // No Workspace Git repository or Instance file exists: the pin must fail first.
    const output = join(root, "artifact.json");
    const run = spawnSync(process.execPath, [join(coreRoot, "packages/cli/src/cli.mjs"), "build", root, "--output", output], { encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, new RegExp(`Workspace requires ${other}`));
    assert.match(run.stderr, new RegExp(`Current Core is ${actual}`));
    assert.match(run.stderr, /Build aborted/);
    assert.equal(existsSync(output), false);
    for (const invalid of ["main", actual.slice(0, 7), "null", '""']) {
      pin(invalid);
      assert.throws(() => assertWorkspaceCoreCommit(root, actual), /immutable 40-character Core SHA/);
    }
    rmSync(path);
    assert.throws(() => assertWorkspaceCoreCommit(root, actual));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
