import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changedFiles, classifyFiles } from "../src/inspection.mjs";

test("inspection includes the uncommitted mixed Builder candidate after intent-to-add", () => {
  const root = mkdtempSync(join(tmpdir(), "builder-inspect-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    for (const file of ["tracked.md", "staged.md", "deleted.md", "renamed.md"]) writeFileSync(join(root, file), "before\n");
    git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(root, "tracked.md"), "after\n");
    writeFileSync(join(root, "staged.md"), "after\n"); git("add", "staged.md");
    rmSync(join(root, "deleted.md")); renameSync(join(root, "renamed.md"), join(root, "moved.md"));
    writeFileSync(join(root, "new.md"), "new\n"); git("add", "-N", "--all");
    writeFileSync(join(root, "not-staged.md"), "new\n");
    assert.deepEqual(changedFiles(root, base), ["deleted.md", "moved.md", "new.md", "not-staged.md", "renamed.md", "staged.md", "tracked.md"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("plan metadata exemption is narrow and cannot exempt explicit governance protection", () => {
  const plan = ".companyos/changes/change.yaml";
  const governance = { change_classes: { security: { paths: [".companyos/**"] }, behavior: { paths: ["workflows/**"] } } };
  assert.equal(classifyFiles(["workflows/report.md", plan], governance).effective, "security");
  assert.equal(classifyFiles(["workflows/report.md", plan], governance, { planMetadataPaths: new Set([plan]) }).effective, "behavior");
  assert.equal(classifyFiles([".companyos/governance.yaml", plan], governance, { planMetadataPaths: new Set([plan]) }).effective, "security");
  governance.change_classes.security.paths.push(".companyos/changes/**");
  assert.equal(classifyFiles([plan], governance, { planMetadataPaths: new Set([plan]) }).effective, "security");
});
