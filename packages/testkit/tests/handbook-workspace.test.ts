import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildCompanyOSArtifact } from "../../companyos-builder/build.ts";
import { loadCompanyWorkspace, scopedMaterials } from "../../companyos-builder/workspace-loader.ts";
import type { InstanceBuildConfiguration } from "../../companyos-builder/types.ts";

const repository = join(import.meta.dirname, "../../..");
const instance: InstanceBuildConfiguration = {
  version: 1, instanceId: "handbook-test", environment: "test", agentBindings: [],
  bindings: ["artifact.publish", "marketing-campaign.launch", "marketing-campaign.read-report", "marketing-campaign.stop-asset", "conversion.record"]
    .map((capability) => ({ capability, contractVersion: "1.0.0", connector: capability === "artifact.publish" ? "oregano/artifact-sandbox" : "oregano/marketing-sandbox", connectorVersion: "1.0.0" })),
};
const fixture = (run: (root: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), "companyos-handbook-"));
  cpSync(join(import.meta.dirname, "../fixtures/reference-company"), root, { recursive: true });
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
};
const build = (workspaceRoot: string) => buildCompanyOSArtifact({
  workspaceRoot, instance, coreVersion: "0.14.0", coreCommit: "a".repeat(40),
  workspaceCommit: "b".repeat(40), workbenchVersion: "0.1.0-experimental.22",
});

test("plain Handbook articles need neither frontmatter nor a search index and remain scoped material", () => fixture((root) => {
  const body = "# Working together\n\nA plain Markdown article with no search metadata.\n";
  writeFileSync(join(root, "handbook", "working.md"), body);
  rmSync(join(root, "handbook", "index.md"));
  const pin = join(root, ".companyos", "compatibility.yaml");
  writeFileSync(pin, readFileSync(pin, "utf8").replaceAll("0.3.2", "0.14.0").replaceAll("0.1.0-experimental.7", "0.1.0-experimental.22"));
  const validated = spawnSync(process.execPath, [join(repository, "packages/cli/src/cli.mjs"), "validate", root, "--format", "json"], { encoding: "utf8" });
  assert.equal(validated.status, 0, validated.stdout + validated.stderr);
  const artifact = build(root);
  assert.equal(Object.hasOwn(artifact, "knowledge"), false);
  assert.ok(!artifact.capabilityCatalog.some((entry) => entry.id.startsWith("knowledge.")));
  const workspace = loadCompanyWorkspace(root);
  assert.equal(scopedMaterials(workspace, ["handbook/working.md"])["handbook/working.md"], body);
  assert.equal(scopedMaterials(workspace, ["handbook/roster.md"])["handbook/working.md"], undefined);
  assert.equal(artifact.roster.length, 3);
}));

test("retired document ACLs cannot silently become broad Agent materials", () => fixture((root) => {
  writeFileSync(join(root, "handbook", "restricted.md"), "---\nvisibility: individual\nallowed_principals: [test:fictional:owner]\n---\n# Private\n");
  const workspace = loadCompanyWorkspace(root);
  assert.throws(() => scopedMaterials(workspace, ["handbook/**"]), /reviewed migration/);
  assert.doesNotThrow(() => scopedMaterials(workspace, ["handbook/roster.md"]));
}));

test("retired search grants require explicit Workspace migration instead of falling back to file access", () => fixture((root) => {
  const path = join(root, "agents/growth/instructions.md");
  writeFileSync(path, readFileSync(path, "utf8").replace("tools:\n", "tools:\n  - oregano:knowledge/search\n"));
  assert.throws(() => build(root), /unknown|not found|not available/i);
}));

test("the structured authorization roster and ordinary effect controls remain required", () => fixture((root) => {
  writeFileSync(join(root, "handbook", "roster.md"), "# People\nPlain prose cannot supply approval authority.\n");
  const result = spawnSync(process.execPath, [join(repository, "packages/cli/src/cli.mjs"), "validate", root, "--format", "json"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.ok(JSON.parse(result.stdout).diagnostics.some((entry: { code: string }) => entry.code === "WS007"));
}));

test("the Workbench no longer advertises or executes Knowledge commands", () => {
  const cli = join(repository, "packages/cli/src/cli.mjs");
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.doesNotMatch(help.stdout, /companyos knowledge|knowledge-output/);
  const removed = spawnSync(process.execPath, [cli, "knowledge", "inspect"], { encoding: "utf8" });
  assert.notEqual(removed.status, 0);
  const guides = spawnSync(process.execPath, [cli, "guide", "list"], { encoding: "utf8" });
  assert.equal(guides.status, 0);
  assert.match(guides.stdout, /author-handbook/);
  assert.doesNotMatch(guides.stdout, /author-company-knowledge|connect-knowledge-source|review-company-knowledge|operate-knowledge-provider|recover-company-knowledge/);
});
