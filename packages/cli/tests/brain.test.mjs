import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { brainConfig, brainFiles } from "../../testkit/fixtures/brain.ts";
import { checkBrainWorkspace, loadBrainOperatorArtifact } from "../src/brain-operations.mjs";

const cli = new URL("../src/cli.mjs", import.meta.url);
test("Brain CLI checks ordinary Workspace knowledge without credentials, database or model access", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-cli-"));
  const write = (path, text) => { const full = join(root, path); mkdirSync(join(full, ".."), { recursive: true }); writeFileSync(full, text); };
  try {
    write("company.md", "Example Workspace\n");
    write(".companyos/brain.yaml", YAML.stringify(brainConfig));
    write(".companyos/governance.yaml", YAML.stringify({ runtime: { brain_reading: "company-wide", common_tool_grants: ["oregano:brain/entity"] } }));
    for (const [path, text] of Object.entries(brainFiles)) if (path.startsWith("brain/")) write(path, text);
    const output = JSON.parse(execFileSync(process.execPath, [cli.pathname, "brain", "check", root, "--format", "json"], { encoding: "utf8", env: { PATH: process.env.PATH } }));
    assert.equal(output.ok, true); assert.ok(output.pages >= 4);
    rmSync(join(root, "brain/sources/review.md"));
    assert.ok(checkBrainWorkspace(root).diagnostics.some(item => item.code === "take_evidence_missing"));
    assert.throws(() => execFileSync(process.execPath, [cli.pathname, "brain", "check", root, "--format", "json"], { stdio: "pipe" }), error => error.status === 1);
    symlinkSync(join(root, "company.md"), join(root, "brain/topics/linked.md"));
    assert.equal(checkBrainWorkspace(root).ok, false);
    write(".companyos/governance.yaml", YAML.stringify({ runtime: { brain_reading: "restricted" } }));
    assert.equal(checkBrainWorkspace(root).ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("operator Artifact integrity failure is rejected before any Instance access", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-cli-artifact-"));
  try {
    const path = join(root, "artifact.json");
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, artifactHash: "tampered", provenance: { coreCommit: "a".repeat(40) } }));
    assert.throws(() => loadBrainOperatorArtifact(path, "a".repeat(40)), /integrity/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
