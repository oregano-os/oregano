import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { compileWorkspaceArtifact } from "../../runtime/builder/build-artifact-worker.ts";
import { resolveWorkspaceInstanceConfiguration } from "../../companyos-builder/instance-loader.ts";
import { sha256 } from "../../runtime/canonical.ts";
import { renderWorkspace } from "../src/workspace-generator.mjs";
import { CORE_VERSION } from "../src/core-version.mjs";
import { WORKBENCH_VERSION } from "../src/workbench-version.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "instance-worker-"));
  const provenance = { coreCommit: "a".repeat(40), coreVersion: CORE_VERSION, workbenchVersion: WORKBENCH_VERSION };
  const coreIdentity = { repository: "oregano-os/oregano", ref: provenance.coreCommit, core_version: CORE_VERSION, workbench_version: WORKBENCH_VERSION };
  for (const [path, content] of renderWorkspace({ company_name: "Example Company", workspace_slug: "example-company", language: "en", timezone: "UTC", steward_name: "Anna Example", steward_id: "anna-example", codeowner: "@anna-example", target_directory: "example-company" }, coreIdentity)) {
    const target = join(root, path); mkdirSync(resolve(target, ".."), { recursive: true }); writeFileSync(target, content);
  }
  writeFileSync(join(root, ".companyos/instance.yaml"), "version: 1\ninstance_id: example-production\nenvironment: production\nbindings: []\n");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.name", "Synthetic Test"); git("config", "user.email", "test@example.test");
  const commit = () => { git("add", "."); git("commit", "-qm", "Reviewed fixture"); return git("rev-parse", "HEAD"); };
  const request = { coreCommit: provenance.coreCommit, workspaceCommit: commit(), instanceId: "example-production", configurationDigest: sha256(resolveWorkspaceInstanceConfiguration(root).configuration) };
  return { root, provenance, request, commit, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("hosted compilation reads the committed Workspace declaration and preserves exact provenance", () => {
  const f = fixture();
  try {
    const result = compileWorkspaceArtifact(f.root, f.request, f.provenance);
    assert.equal(result.artifact.instance.id, f.request.instanceId);
    assert.equal(result.artifact.provenance.workspaceCommit, f.request.workspaceCommit);
    assert.equal(result.artifact.provenance.instanceConfigurationDigest, f.request.configurationDigest);
    assert.ok(result.knowledgeBundle);
    assert.throws(() => compileWorkspaceArtifact(f.root, { ...f.request, configurationDigest: "b".repeat(64) }, f.provenance), /accepted configuration/);
    assert.throws(() => compileWorkspaceArtifact(f.root, { ...f.request, instanceId: "another-instance" }, f.provenance), /accepted production Instance/);
    writeFileSync(join(f.root, ".companyos/instance.yaml"), readFileSync(join(f.root, ".companyos/instance.yaml"), "utf8") + "default_agent: builder\n");
    assert.throws(() => compileWorkspaceArtifact(f.root, f.request, f.provenance), /exact clean/);
    f.request.workspaceCommit = f.commit();
    assert.throws(() => compileWorkspaceArtifact(f.root, f.request, f.provenance), /accepted configuration/);
  } finally { f.cleanup(); }
});

test("hosted compilation rejects missing and ignored untracked Instance declarations", () => {
  const f = fixture();
  try {
    const raw = readFileSync(join(f.root, ".companyos/instance.yaml"), "utf8");
    rmSync(join(f.root, ".companyos/instance.yaml"));
    writeFileSync(join(f.root, ".gitignore"), ".companyos/instance.yaml\n");
    f.request.workspaceCommit = f.commit();
    assert.throws(() => compileWorkspaceArtifact(f.root, f.request, f.provenance), /Instance declaration is missing/);
    writeFileSync(join(f.root, ".companyos/instance.yaml"), raw);
    assert.throws(() => compileWorkspaceArtifact(f.root, f.request, f.provenance), /ls-files/);
  } finally { f.cleanup(); }
});

test("CLI refuses the removed explicit Instance path before attempting any build", () => {
  const cli = resolve(import.meta.dirname, "../src/cli.mjs");
  for (const flag of [["--instance", "/tmp/external.yaml"], ["--instance=/tmp/external.yaml"]]) {
    assert.throws(() => execFileSync(process.execPath, [cli, "build", "/tmp", ...flag, "--output", "/tmp/unused.json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), /no longer supported/);
  }
});

test("CLI rejects the retired installer before creating a setup session", () => {
  const cli = resolve(import.meta.dirname, "../src/cli.mjs");
  assert.throws(() => execFileSync(process.execPath, [cli, "setup", "--profile", "vercel-neon-slack", "--plan"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), /setup flow is no longer supported/);
});
