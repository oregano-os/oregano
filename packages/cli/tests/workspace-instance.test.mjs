import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import YAML from "yaml";
import { renderWorkspace } from "../src/workspace-generator.mjs";
import { renderOperatingStarter, previewOperatingStarter, applyOperatingStarter } from "../src/operating-starter.mjs";
import { validateWorkspace } from "../src/workspace-validator.mjs";
import { CORE_VERSION } from "../src/core-version.mjs";
import { WORKBENCH_VERSION } from "../src/workbench-version.mjs";

const input = { change_date: "2026-09-09", slack_team_id: "TEXAMPLE", slack_user_id: "UEXAMPLE", slack_channel_id: "" };
const withWorkspace = (run) => {
  const root = mkdtempSync(join(tmpdir(), "companyos-workspace-instance-"));
  try {
    const files = renderWorkspace({ company_name: "Example Company", workspace_slug: "example-company", language: "en", timezone: "UTC", steward_name: "Example Steward", steward_id: "example-steward", codeowner: "@example-steward" }, {
      repository: "oregano-os/oregano", ref: "1".repeat(40), core_version: CORE_VERSION, workbench_version: WORKBENCH_VERSION,
    });
    for (const [path, content] of files) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
    run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
};

test("operating setup reviews and materializes the Instance file before the Workspace commit", () => withWorkspace((root) => {
  const request = { workspaceRoot: root, rawInput: input, instanceId: "example-companyos-production" };
  const preview = previewOperatingStarter(request);
  assert.deepEqual(preview.diagnostics.filter((item) => item.severity === "error"), []);
  assert.ok(preview.preview.files.includes(".companyos/instance.yaml"));
  assert.equal(preview.preview.instance_id, request.instanceId);
  const result = applyOperatingStarter({ ...request, confirmationHash: preview.preview.confirmation_hash });
  assert.equal(result.applied, true);
  assert.deepEqual(YAML.parse(readFileSync(join(root, ".companyos/instance.yaml"), "utf8")), { version: 1, instance_id: request.instanceId, environment: "production", bindings: [] });
}));

test("setup preserves reviewed bindings and rejects a conflicting setup identity", () => withWorkspace((root) => {
  const raw = "# Reviewed configuration\nversion: 1\ninstance_id: example-production\nenvironment: production\nbindings: []\ndefault_agent: oregano\n";
  writeFileSync(join(root, ".companyos/instance.yaml"), raw);
  const result = renderOperatingStarter(root, input, { instanceId: "example-production" });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.files.get(".companyos/instance.yaml"), raw);
  const conflict = renderOperatingStarter(root, input, { instanceId: "different-production" });
  assert.ok(conflict.diagnostics.some((item) => item.code === "OPS025"));
  assert.equal(readFileSync(join(root, ".companyos/instance.yaml"), "utf8"), raw);
}));

test("setup confirmation is invalidated when the target Instance changes", () => withWorkspace((root) => {
  const preview = previewOperatingStarter({ workspaceRoot: root, rawInput: input, instanceId: "example-production" });
  const result = applyOperatingStarter({ workspaceRoot: root, rawInput: input, instanceId: "other-production", confirmationHash: preview.preview.confirmation_hash });
  assert.equal(result.applied, false);
  assert.ok(result.diagnostics.some((item) => item.code === "OPS022"));
}));

test("Workspace validation checks Instance syntax and secrets while allowing unmigrated Workspaces", () => withWorkspace((root) => {
  assert.deepEqual(validateWorkspace(root).diagnostics.filter((item) => item.severity === "error"), []);
  const path = join(root, ".companyos/instance.yaml");
  const raw = "version: 1\ninstance_id: example-production\nenvironment: production\nbindings: []\n";
  writeFileSync(path, raw);
  assert.deepEqual(validateWorkspace(root).diagnostics.filter((item) => item.severity === "error"), []);
  for (const invalid of [raw.replace("bindings:", "bindingz:"), `${raw}password: example-value\n`, raw.replace("version: 1", "version: 9")]) {
    writeFileSync(path, invalid);
    assert.ok(validateWorkspace(root).diagnostics.some((item) => item.code === "WSI001"));
  }
}));
