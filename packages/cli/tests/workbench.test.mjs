import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { checkGeneratedDocumentation, inspectDocumentation } from "../src/docs-control.mjs";
import { changePlanTemplate, validateChangePlan } from "../src/change-plan.mjs";
import { validateWorkspace } from "../src/workspace-validator.mjs";
import { inspectWorkspace } from "../src/inspection.mjs";
import { inspectCore, inspectCoreDocumentationImpact } from "../src/core-inspection.mjs";
import { inspectWorkspaceSecurity } from "../src/security.mjs";
import { inspectWorkspaceOnboarding } from "../src/onboarding.mjs";
import { inspectCompatibilityRegistry } from "../src/compatibility-registry.mjs";
import { inspectCompanyOSPackage } from "../src/package-inspector.mjs";
import { inspectBootstrap, verifyBootstrap } from "../src/bootstrap.mjs";
import { normalizeRepositoryIdentity } from "../src/core-checkout.mjs";
import {
  GENERATED_WORKSPACE_PATHS,
  createWorkspace,
  normalizeCreateWorkspaceInput,
  previewWorkspaceCreation,
  renderWorkspace,
} from "../src/workspace-generator.mjs";
import { WORKBENCH_VERSION } from "../src/workbench-version.mjs";
import { CORE_VERSION, PACKAGE_MANAGER_SPEC, PNPM_VERSION } from "../src/core-version.mjs";

const REPO = resolve(import.meta.dirname, "..", "..", "..");
const FIXTURE = join(REPO, "packages", "testkit", "fixtures", "acme-casas");
const PACKAGE_FIXTURES = join(REPO, "packages", "testkit", "fixtures", "packages");

const withFixture = (fn) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "companyos-workbench-"));
  const workspace = join(temporaryRoot, "workspace");
  cpSync(FIXTURE, workspace, { recursive: true });
  try { return fn(workspace); }
  finally { rmSync(temporaryRoot, { recursive: true, force: true }); }
};

test("the Workbench exposes its exact running version", () => {
  assert.equal(CORE_VERSION, "0.3.1");
  assert.equal(WORKBENCH_VERSION, "0.1.0-experimental.6");
  const result = spawnSync("node", [join(REPO, "packages/cli/src/cli.mjs"), "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), WORKBENCH_VERSION);
  assert.equal(result.stderr, "");
});

test("Core governance supports one accountable Oregano Maintainer", () => {
  const policy = YAML.parse(readFileSync(join(REPO, "docs", "governance", "core-change-policy.yaml"), "utf8"));
  assert.equal(policy.review_mode, "maintainer");
  assert.equal(policy.change_classes.security.approval, "oregano-maintainer");
  assert.equal(policy.change_classes.security.two_person_review, undefined);
  assert.equal(policy.change_classes.security.review_model, undefined);

  const temporaryRoot = mkdtempSync(join(tmpdir(), "companyos-core-plan-"));
  const planPath = join(temporaryRoot, "self-approved-core-change.yaml");
  writeFileSync(planPath, YAML.stringify({
    ...structuredClone(changePlanTemplate),
    plan_id: "self-approved-core-change",
    status: "approved",
    author: "maintainer",
    created: "2026-08-22",
    title: "Checked maintainer change",
    objective: "Prove the maintainer review contract.",
    placement: "core",
    change_class: "security",
    required_approvals: ["oregano-maintainer"],
    approvals: [{ role: "oregano-maintainer", approver: "maintainer", approved_at: "2026-08-22", evidence: "explicit-human-approval" }],
    validation: ["pnpm check"],
    tests: ["Core inspection accepts the declared maintainer authority"],
    documentation_impact: { required: true, affected_documents: ["governance.core-change-policy"], reason_if_none: "" },
    rollback: "Revert the checked change.",
    open_decisions: [],
  }));
  try {
    const result = inspectCore(REPO, planPath);
    assert.ok(!result.diagnostics.some((item) => item.code === "PLAN011"));
    assert.ok(!result.diagnostics.some((item) => ["CFIT010", "CFIT011", "CFIT012"].includes(item.code)));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("canonical documentation passes metadata, relation, link, and generated-output checks", () => {
  const result = inspectDocumentation(REPO);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(checkGeneratedDocumentation(REPO, result.documents), []);
  assert.ok(result.documents.length >= 20);
});

test("the locked installer toolchain excludes the reviewed transitive advisory versions", () => {
  const workspaceConfig = YAML.parse(readFileSync(join(REPO, "pnpm-workspace.yaml"), "utf8"));
  assert.deepEqual(workspaceConfig.overrides, {
    "@tootallnate/once@2.0.0": "2.0.1",
    "ajv@>=7.0.0-alpha.0 <8.18.0": "8.18.0",
    "js-yaml@4.1.1": "4.3.1",
    "minimatch@10.1.1": "10.2.6",
    "path-to-regexp@>=4.0.0 <6.3.0": "6.3.0",
    "path-to-regexp@>=8.0.0 <8.4.0": "8.4.0",
    "smol-toml@<1.6.1": "1.6.1",
    "tar@7.5.7": "7.5.22",
    "undici@<6.28.0": "6.28.0",
  });
  const lockfile = YAML.parse(readFileSync(join(REPO, "pnpm-lock.yaml"), "utf8"));
  const resolvedPackages = new Set([
    ...Object.keys(lockfile.packages ?? {}),
    ...Object.keys(lockfile.snapshots ?? {}),
  ]);
  for (const vulnerable of [
    "@tootallnate/once@2.0.0",
    "ajv@8.6.3",
    "js-yaml@4.1.1",
    "minimatch@10.1.1",
    "path-to-regexp@6.1.0",
    "path-to-regexp@8.2.0",
    "path-to-regexp@8.3.0",
    "smol-toml@1.5.2",
    "tar@7.5.7",
    "undici@5.28.4",
    "undici@5.29.0",
  ]) assert.equal(resolvedPackages.has(vulnerable), false, `${vulnerable} must not be locked`);
});

test("Core documentation contracts require declared documents and real same-diff updates", () => {
  const documentation = {
    byId: new Map([
      ["onboarding.index", { relative: "onboarding/README.md" }],
    ]),
  };
  const governance = {
    documentation_contracts: {
      live_setup: {
        paths: ["packages/cli/src/setup/**"],
        required_documents: ["onboarding.index"],
        required_files: ["INSTALL-COMPANYOS.md"],
      },
    },
  };
  const plan = {
    documentation_impact: {
      required: true,
      affected_documents: [],
    },
  };
  const implementationOnly = inspectCoreDocumentationImpact(
    ["packages/cli/src/setup/profile.ts"],
    plan,
    documentation,
    governance,
  );
  assert.ok(implementationOnly.some((item) => item.code === "CFIT016"));
  assert.ok(implementationOnly.some((item) => item.code === "CFIT017"));

  plan.documentation_impact.affected_documents = ["onboarding.index"];
  const declaredButUnchanged = inspectCoreDocumentationImpact(
    ["packages/cli/src/setup/profile.ts", "INSTALL-COMPANYOS.md"],
    plan,
    documentation,
    governance,
  );
  assert.ok(declaredButUnchanged.some((item) => item.code === "CFIT014"));

  assert.deepEqual(inspectCoreDocumentationImpact(
    ["packages/cli/src/setup/profile.ts", "docs/onboarding/README.md", "INSTALL-COMPANYOS.md"],
    plan,
    documentation,
    governance,
  ), []);
});

test("the neutral Company Workspace fixture passes validation", () => {
  const result = validateWorkspace(FIXTURE);
  assert.equal(result.diagnostics.filter((item) => item.severity === "error").length, 0);
  assert.equal(result.summary.workspace, "acme-casas");
  assert.equal(result.summary.workspace_version, "0.1.0");
  assert.equal(result.summary.workspace_mode, "operating");
  assert.equal(result.summary.supervised_workflows, 1);
  assert.equal(result.summary.company_tools, 1);
});

test("Core and Workspace versions are exact SemVer and visible through the Workbench", () => withFixture((workspace) => {
  const result = spawnSync("node", [join(REPO, "packages/cli/src/cli.mjs"), "versions", workspace, "--format", "json"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    core: "0.3.1",
    workspace: "0.1.0",
    workbench: "0.1.0-experimental.6",
    companyos_spec: "0.7-draft",
  });

  const companyPath = join(workspace, "company.md");
  writeFileSync(companyPath, readFileSync(companyPath, "utf8").replace('workspace_version: "0.1.0"', 'workspace_version: "00.1.0"'));
  const invalid = validateWorkspace(workspace);
  assert.ok(invalid.diagnostics.some((item) => item.code === "WS039" && item.severity === "error"));
}));

test("the fixture demonstrates every repository-local security control", () => {
  const diagnostics = inspectWorkspaceSecurity(FIXTURE);
  assert.equal(diagnostics.filter((item) => item.severity === "error").length, 0);
  assert.equal(diagnostics.filter((item) => item.severity === "warning").length, 0);
  assert.ok(diagnostics.some((item) => item.code === "SEC019" && item.severity === "info"));
});

test("onboarding reports local readiness and keeps hosted controls manual", () => {
  const result = inspectWorkspaceOnboarding(FIXTURE);
  assert.equal(result.summary.readiness, "ready-for-hosted-setup");
  assert.equal(result.checklist.find((item) => item.id === "git-host-account")?.status, "manual");
  assert.match(result.checklist.find((item) => item.id === "git-host-account")?.next ?? "", /GitHub Free is sufficient/);
  assert.equal(result.checklist.find((item) => item.id === "core-and-workbench-pin")?.status, "complete");
  assert.equal(result.checklist.find((item) => item.id === "github-protection")?.status, "manual");
  assert.match(result.checklist.find((item) => item.id === "company-instance")?.next ?? "", /Vercel.*Neon\/Postgres/);
});

test("advisory hosted protection does not block the supervised starter", () => withFixture((workspace) => {
  const protectionPath = join(workspace, ".companyos", "repository-protection.yaml");
  const protection = YAML.parse(readFileSync(protectionPath, "utf8"));
  protection.verification = { status: "advisory", checked_at: "2026-08-23T10:00:00.000Z", checked_by: "platform-admin" };
  writeFileSync(protectionPath, YAML.stringify(protection));
  const result = inspectWorkspaceOnboarding(workspace);
  assert.equal(result.summary.readiness, "ready-for-hosted-setup");
  const hosted = result.checklist.find((item) => item.id === "github-protection");
  assert.equal(hosted?.status, "manual");
  assert.match(hosted?.next ?? "", /acceptable for the supervised starter/);
}));

test("authoring-only onboarding defers runtime-provider accounts", () => withFixture((workspace) => {
  rmSync(join(workspace, "agents", "ops"), { recursive: true, force: true });
  rmSync(join(workspace, "workflows", "board-rhythm.md"));
  const companyPath = join(workspace, "company.md");
  writeFileSync(companyPath, readFileSync(companyPath, "utf8").replace("workspace_mode: operating", "workspace_mode: authoring-only"));
  const result = inspectWorkspaceOnboarding(workspace);
  const instance = result.checklist.find((item) => item.id === "company-instance");
  assert.equal(result.summary.workspace_mode, "authoring-only");
  assert.equal(result.summary.execution_readiness, "not-applicable");
  assert.equal(instance?.status, "deferred");
  assert.match(instance?.next ?? "", /No Vercel or Neon account is required/);
}));

test("an authoring-only Workspace needs no invented operating agent or workflow", () => withFixture((workspace) => {
  rmSync(join(workspace, "agents", "ops"), { recursive: true, force: true });
  rmSync(join(workspace, "workflows", "board-rhythm.md"));
  const companyPath = join(workspace, "company.md");
  writeFileSync(companyPath, readFileSync(companyPath, "utf8").replace("workspace_mode: operating", "workspace_mode: authoring-only"));
  const result = validateWorkspace(workspace);
  assert.equal(result.diagnostics.filter((item) => item.severity === "error").length, 0);
  assert.equal(result.summary.agents, 1);
  assert.equal(result.summary.workflows, 0);
}));

test("an immutable Core pin is required", () => withFixture((workspace) => {
  const path = join(workspace, ".companyos", "compatibility.yaml");
  const raw = YAML.parse(readFileSync(path, "utf8"));
  raw.core.ref = "main";
  writeFileSync(path, YAML.stringify(raw));
  const result = validateWorkspace(workspace);
  assert.ok(result.diagnostics.some((item) => item.code === "CMP006" && item.severity === "error"));
}));

test("the pinned Workbench must match the validator that is running", () => withFixture((workspace) => {
  const path = join(workspace, ".companyos", "compatibility.yaml");
  const raw = YAML.parse(readFileSync(path, "utf8"));
  raw.workbench.version = "0.1.0-experimental.1";
  writeFileSync(path, YAML.stringify(raw));
  const result = validateWorkspace(workspace);
  assert.ok(result.diagnostics.some((item) => item.code === "CMP008" && item.severity === "error"));
}));

test("the pinned Core version must be exact and match the checked-out Core", () => withFixture((workspace) => {
  const path = join(workspace, ".companyos", "compatibility.yaml");
  const raw = YAML.parse(readFileSync(path, "utf8"));
  raw.core.version = "0.1.0";
  writeFileSync(path, YAML.stringify(raw));
  const mismatch = validateWorkspace(workspace);
  assert.ok(mismatch.diagnostics.some((item) => item.code === "CMP010" && item.severity === "error"));

  raw.core.version = "00.1.0";
  writeFileSync(path, YAML.stringify(raw));
  const invalid = validateWorkspace(workspace);
  assert.ok(invalid.diagnostics.some((item) => item.code === "CMP009" && item.severity === "error"));
}));

test("repository onboarding cannot weaken the declared GitHub baseline", () => withFixture((workspace) => {
  const path = join(workspace, ".companyos", "repository-protection.yaml");
  const raw = YAML.parse(readFileSync(path, "utf8"));
  raw.rules.require_pull_request = false;
  writeFileSync(path, YAML.stringify(raw));
  const result = validateWorkspace(workspace);
  assert.ok(result.diagnostics.some((item) => item.code === "RPR006" && item.severity === "error"));
}));

test("steward review mode rejects a hidden second-person requirement", () => withFixture((workspace) => {
  const protectionPath = join(workspace, ".companyos", "repository-protection.yaml");
  const raw = YAML.parse(readFileSync(protectionPath, "utf8"));
  raw.rules.required_approvals = 1;
  raw.rules.require_code_owner_review = true;
  writeFileSync(protectionPath, YAML.stringify(raw));
  const result = validateWorkspace(workspace);
  assert.ok(result.diagnostics.some((item) => item.code === "RPR007" && item.severity === "error"));
}));

test("independent-review mode remains an explicit stricter option", () => withFixture((workspace) => {
  const governancePath = join(workspace, ".companyos", "governance.yaml");
  const governance = YAML.parse(readFileSync(governancePath, "utf8"));
  governance.review_mode = "independent-review";
  governance.change_classes.security.two_person_review = true;
  governance.change_classes.security.review_model = "author-plus-one-independent-reviewer";
  writeFileSync(governancePath, YAML.stringify(governance));
  const protectionPath = join(workspace, ".companyos", "repository-protection.yaml");
  const protection = YAML.parse(readFileSync(protectionPath, "utf8"));
  protection.rules.required_approvals = 1;
  protection.rules.require_code_owner_review = true;
  writeFileSync(protectionPath, YAML.stringify(protection));
  const result = validateWorkspace(workspace);
  assert.equal(result.diagnostics.filter((item) => item.severity === "error").length, 0);
}));

test("repository protection rejects every bypass", () => withFixture((workspace) => {
  const protectionPath = join(workspace, ".companyos", "repository-protection.yaml");
  const raw = YAML.parse(readFileSync(protectionPath, "utf8"));
  raw.rules.bypass = { mode: "always", actors: [{ type: "user", login: "founder" }] };
  writeFileSync(protectionPath, YAML.stringify(raw));
  const result = validateWorkspace(workspace);
  assert.ok(result.diagnostics.some((item) => item.code === "RPR009" && item.severity === "error"));
}));

test("legacy global conformance profiles are rejected", () => withFixture((workspace) => {
  const companyPath = join(workspace, "company.md");
  const source = readFileSync(companyPath, "utf8").replace("workspace_mode: operating", "conformance: profile-b\ntarget: profile-c");
  writeFileSync(companyPath, source);
  const result = validateWorkspace(workspace);
  assert.ok(result.diagnostics.some((item) => item.code === "WS030" && item.severity === "error"));
}));

test("authoring-only mode rejects operating agents and workflows", () => withFixture((workspace) => {
  const companyPath = join(workspace, "company.md");
  writeFileSync(companyPath, readFileSync(companyPath, "utf8").replace("workspace_mode: operating", "workspace_mode: authoring-only"));
  const result = validateWorkspace(workspace);
  assert.ok(result.diagnostics.some((item) => item.code === "WS032" && item.severity === "error"));
}));

test("operating mode requires both an operating agent and a workflow", () => withFixture((workspace) => {
  rmSync(join(workspace, "agents", "ops"), { recursive: true, force: true });
  rmSync(join(workspace, "workflows", "board-rhythm.md"));
  const result = validateWorkspace(workspace);
  assert.ok(result.diagnostics.some((item) => item.code === "WS033" && item.severity === "error"));
  assert.ok(result.diagnostics.some((item) => item.code === "WS034" && item.severity === "error"));
}));

test("every workflow declares supervised or unattended execution", () => withFixture((workspace) => {
  const workflowPath = join(workspace, "workflows", "board-rhythm.md");
  writeFileSync(workflowPath, readFileSync(workflowPath, "utf8").replace("execution_mode: supervised\n", ""));
  const result = validateWorkspace(workspace);
  assert.ok(result.diagnostics.some((item) => item.code === "WS031" && item.severity === "error"));
}));

test("unattended workflows remain blocked until enforcement evidence exists", () => withFixture((workspace) => {
  const workflowPath = join(workspace, "workflows", "board-rhythm.md");
  writeFileSync(workflowPath, readFileSync(workflowPath, "utf8").replace("execution_mode: supervised", "execution_mode: unattended"));
  const result = inspectWorkspaceOnboarding(workspace);
  assert.equal(result.summary.execution_readiness, "unattended-enforcement-unverified");
  assert.equal(result.checklist.find((item) => item.id === "unattended-execution")?.status, "blocked");
  assert.ok(result.diagnostics.some((item) => item.code === "WS035" && item.severity === "info"));
}));

test("a missing constitution blocks Workspace validation", () => withFixture((workspace) => {
  rmSync(join(workspace, "policies", "risk-levels.md"));
  const result = validateWorkspace(workspace);
  assert.ok(result.diagnostics.some((item) => item.code === "WS002" && item.severity === "error"));
}));

test("governance cannot omit protection for its own policy", () => withFixture((workspace) => {
  const path = join(workspace, ".companyos", "governance.yaml");
  const raw = YAML.parse(readFileSync(path, "utf8"));
  raw.change_classes.security.paths = raw.change_classes.security.paths.filter((item) => item !== ".companyos/**");
  writeFileSync(path, YAML.stringify(raw));
  const result = validateWorkspace(workspace);
  assert.ok(result.diagnostics.some((item) => item.code === "GOV005" && item.severity === "error"));
}));

test("governance must define an explicit Workspace review mode", () => withFixture((workspace) => {
  const path = join(workspace, ".companyos", "governance.yaml");
  const raw = YAML.parse(readFileSync(path, "utf8"));
  delete raw.review_mode;
  writeFileSync(path, YAML.stringify(raw));
  const result = validateWorkspace(workspace);
  assert.ok(result.diagnostics.some((item) => item.code === "GOV010" && item.severity === "error"));
}));

test("Company Tools cannot import providers or read environment secrets", () => withFixture((workspace) => {
  const execute = join(workspace, "agents", "ops", "tools", "check-permit-status", "execute.ts");
  writeFileSync(execute, "import Stripe from 'stripe';\nexport const token = process.env.SECRET;\n");
  const result = validateWorkspace(workspace);
  const violations = result.diagnostics.filter((item) => item.code === "WS026");
  assert.ok(violations.some((item) => /only the named defineCompanyTool import/.test(item.message)));
  assert.ok(violations.some((item) => /process/.test(item.message)));
}));

test("Workspace validation detects committed credential indicators", () => withFixture((workspace) => {
  const path = join(workspace, "policies", "accidental-secret.md");
  writeFileSync(path, `---
type: concept
description: Deliberately invalid credential fixture.
---
api_key: sk-live-value-that-must-never-be-committed
`);
  const result = validateWorkspace(workspace);
  assert.ok(result.diagnostics.some((item) => item.code === "SEC002" && item.file === "policies/accidental-secret.md"));
}));

test("behavior Change Plans require approval, docs impact, and rollback", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "companyos-plan-"));
  const path = join(temporaryRoot, "change-plan.yaml");
  try {
    writeFileSync(path, YAML.stringify(changePlanTemplate));
    const incomplete = validateChangePlan(path);
    assert.ok(incomplete.some((item) => item.code === "PLAN006"));
    assert.ok(incomplete.some((item) => item.code === "PLAN007"));

    const complete = structuredClone(changePlanTemplate);
    complete.plan_id = "CP-001";
    complete.author = "alice";
    complete.created = "2026-08-14";
    complete.title = "Adjust board rhythm";
    complete.objective = "Change one governed threshold.";
    complete.required_approvals = ["process-steward"];
    complete.validation = ["companyos validate"];
    complete.tests = ["board rhythm fixture"];
    complete.documentation_impact.affected_documents = ["guide.plan-change"];
    complete.rollback = "Revert the Workspace commit.";
    writeFileSync(path, YAML.stringify(complete));
    assert.deepEqual(validateChangePlan(path), []);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("inspection rejects a plan that understates the governed diff class", () => withFixture((workspace) => {
  const git = (args) => {
    const result = spawnSync("git", ["-C", workspace, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git(["init"]);
  git(["config", "user.email", "workbench@example.invalid"]);
  git(["config", "user.name", "Workbench Test"]);
  git(["add", "."]);
  git(["commit", "-m", "fixture"]);

  const governancePath = join(workspace, ".companyos", "governance.yaml");
  writeFileSync(governancePath, `${readFileSync(governancePath, "utf8")}\n`);
  const plan = structuredClone(changePlanTemplate);
  Object.assign(plan, {
    plan_id: "CP-002",
    author: "alice",
    created: "2026-08-14",
    title: "Misclassified governance edit",
    objective: "Prove diff classification.",
    placement: "workspace",
    change_class: "content",
    validation: ["companyos validate"],
    tests: ["inspection fixture"],
    rollback: "Revert the commit.",
  });
  plan.documentation_impact.affected_documents = ["governance.roles"];
  const planPath = join(workspace, "plan.yaml");
  writeFileSync(planPath, YAML.stringify(plan));

  const result = inspectWorkspace(workspace, planPath);
  assert.ok(result.diagnostics.some((item) => item.code === "FIT009" && item.severity === "error"));
}));

test("the Compatibility Registry is structurally valid and references canonical specifications", () => {
  const docs = inspectDocumentation(REPO);
  const result = inspectCompatibilityRegistry(REPO, { documentIds: new Set(docs.byId.keys()) });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(String(result.registry?.companyos_spec.current), "0.7.0");
  assert.deepEqual(result.registry?.companyos_spec.supported.map(String), ["0.7.0"]);
  assert.equal(result.byKey.get("companyos.package-manifest@1")?.stability, "experimental");
});

test("the Compatibility Registry rejects an invalid or unsupported current CompanyOS specification", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "companyos-compatibility-registry-"));
  try {
    const target = join(temporaryRoot, "docs", "compatibility");
    mkdirSync(target, { recursive: true });
    const registry = YAML.parse(readFileSync(join(REPO, "docs", "compatibility", "registry.yaml"), "utf8"));
    registry.companyos_spec.current = "not-semver";
    registry.companyos_spec.supported = ["0.7.0"];
    writeFileSync(join(target, "registry.yaml"), YAML.stringify(registry));
    const result = inspectCompatibilityRegistry(temporaryRoot);
    assert.ok(result.diagnostics.some((item) => item.code === "CMPREG018" && item.severity === "error"));
    assert.ok(result.diagnostics.some((item) => item.code === "CMPREG020" && item.severity === "error"));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("the Package manifest schema recognizes exactly the three v0.1 Package kinds", () => {
  const schema = JSON.parse(readFileSync(join(REPO, "packages", "cli", "src", "package-manifest.schema.json"), "utf8"));
  assert.deepEqual(schema.properties.kind.enum, ["blueprint", "tool", "connector"]);
  assert.equal(schema.properties.schema_version.const, 1);
});

test("the Package Inspector enforces the manifest schema as its structural source of truth", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "companyos-package-schema-"));
  try {
    cpSync(join(PACKAGE_FIXTURES, "valid-minimal-blueprint"), temporaryRoot, { recursive: true });
    const manifestPath = join(temporaryRoot, "companyos.package.yaml");
    const manifest = YAML.parse(readFileSync(manifestPath, "utf8"));
    manifest.undeclared_field = true;
    delete manifest.license;
    writeFileSync(manifestPath, YAML.stringify(manifest));
    const result = inspectCompanyOSPackage(temporaryRoot, REPO);
    assert.ok(result.diagnostics.some((item) => item.code === "PKG023" && item.severity === "error"));
    assert.equal(result.package, null);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("a minimal Blueprint Package passes read-only local inspection", () => {
  const root = join(PACKAGE_FIXTURES, "valid-minimal-blueprint");
  const snapshot = () => readdirSync(root, { recursive: true }).sort().map((relative) => {
    const path = join(root, relative);
    return [relative, lstatSync(path).isFile() ? readFileSync(path, "utf8") : null];
  });
  const before = snapshot();
  const result = inspectCompanyOSPackage(root, REPO);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.package?.kind, "blueprint");
  assert.equal(result.package?.support, "inspectable");
  assert.equal(result.package?.components.length, 3);
  assert.equal(result.package?.publisher, "companyos-fixtures");
  assert.equal(result.package?.license, "Apache-2.0");
  assert.equal(result.package?.compatibility.current_companyos_spec, "0.7.0");
  assert.equal(result.package?.compatibility.companyos_spec_satisfied, true);
  assert.equal(result.package?.installation, "not-implemented");
  assert.equal(result.package?.activation, "not-implemented");
  assert.deepEqual(snapshot(), before);
});

test("the property-campaign Blueprint stays declarative and authority-free", () => {
  const root = join(PACKAGE_FIXTURES, "property-campaign-blueprint");
  const result = inspectCompanyOSPackage(root, REPO);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.package?.kind, "blueprint");
  assert.equal(result.package?.components.length, 3);
  assert.equal(result.package?.permissions.runtime_code, false);
  assert.deepEqual(result.package?.permissions.network, []);
  assert.deepEqual(result.package?.permissions.secret_refs, []);
});

test("Blueprint Package inspection rejects path, code, permission, and compatibility violations", () => {
  const cases = [
    ["invalid-path-escape", "PKG013"],
    ["invalid-runtime-code", "PKG018"],
    ["invalid-runtime-code-pl", "PKG018"],
    ["invalid-permissions", "PKG023"],
    ["invalid-unknown-contract", "PKG019"],
    ["invalid-companyos-spec", "PKG025"],
  ];
  for (const [fixture, code] of cases) {
    const result = inspectCompanyOSPackage(join(PACKAGE_FIXTURES, fixture), REPO);
    assert.ok(result.diagnostics.some((item) => item.code === code && item.severity === "error"), fixture);
  }
});

test("Package inspection rejects a malformed CompanyOS specification range", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "companyos-package-spec-range-"));
  try {
    cpSync(join(PACKAGE_FIXTURES, "valid-minimal-blueprint"), temporaryRoot, { recursive: true });
    const path = join(temporaryRoot, "companyos.package.yaml");
    const manifest = YAML.parse(readFileSync(path, "utf8"));
    manifest.compatibility.companyos_spec = "not-a-version-range";
    writeFileSync(path, YAML.stringify(manifest));
    const result = inspectCompanyOSPackage(temporaryRoot, REPO);
    assert.ok(result.diagnostics.some((item) => item.code === "PKG024" && item.severity === "error"));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Blueprint inspection rejects ambiguous references, wrong entrypoints, undeclared file types, and credential indicators", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "companyos-package-adversarial-"));
  const inspectMutation = (name, mutate) => {
    const root = join(temporaryRoot, name);
    cpSync(join(PACKAGE_FIXTURES, "valid-minimal-blueprint"), root, { recursive: true });
    mutate(root);
    return inspectCompanyOSPackage(root, REPO);
  };
  try {
    const duplicate = inspectMutation("duplicate", (root) => {
      const path = join(root, "companyos.package.yaml");
      const manifest = YAML.parse(readFileSync(path, "utf8"));
      manifest.components.agents.push("agents/sprint/./instructions.md");
      writeFileSync(path, YAML.stringify(manifest));
    });
    assert.ok(duplicate.diagnostics.some((item) => item.code === "PKG028"));

    const wrongEntrypoint = inspectMutation("wrong-entrypoint", (root) => {
      const oldPath = join(root, "agents", "sprint", "instructions.md");
      const newPath = join(root, "agents", "sprint", "agent.md");
      renameSync(oldPath, newPath);
      const path = join(root, "companyos.package.yaml");
      const manifest = YAML.parse(readFileSync(path, "utf8"));
      manifest.components.agents = ["agents/sprint/agent.md"];
      writeFileSync(path, YAML.stringify(manifest));
    });
    assert.ok(wrongEntrypoint.diagnostics.some((item) => item.code === "PKG029"));

    const forbiddenType = inspectMutation("forbidden-type", (root) => {
      writeFileSync(join(root, "active.svg"), "<svg><script>alert(1)</script></svg>");
    });
    assert.ok(forbiddenType.diagnostics.some((item) => item.code === "PKG026"));

    const credential = inspectMutation("credential", (root) => {
      writeFileSync(join(root, "notes.md"), "api_key: sk-live-example-not-a-placeholder-1234567890\n".replace("example-not-a-placeholder-", "realvalue"));
    });
    assert.ok(credential.diagnostics.some((item) => item.code === "PKG027"));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Blueprint Package inspection rejects symbolic links, hardlinks, and lifecycle scripts", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "companyos-package-links-"));
  try {
    const root = join(temporaryRoot, "blueprint");
    cpSync(join(PACKAGE_FIXTURES, "valid-minimal-blueprint"), root, { recursive: true });
    const source = join(root, "agents", "sprint", "instructions.md");
    const symbolic = join(root, "symbolic-agent.md");
    symlinkSync(source, symbolic);
    assert.ok(inspectCompanyOSPackage(root, REPO).diagnostics.some((item) => item.code === "PKG015"));
    rmSync(symbolic);

    linkSync(source, join(root, "hardlinked-agent.md"));
    assert.ok(inspectCompanyOSPackage(root, REPO).diagnostics.some((item) => item.code === "PKG017"));

    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { postinstall: "forbidden" } }));
    assert.ok(inspectCompanyOSPackage(root, REPO).diagnostics.some((item) => item.code === "PKG021"));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Tool and Connector Package kinds are recognized but not yet supported", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "companyos-package-kinds-"));
  try {
    for (const kind of ["tool", "connector"]) {
      const root = join(temporaryRoot, kind);
      cpSync(join(PACKAGE_FIXTURES, "valid-minimal-blueprint"), root, { recursive: true });
      const manifestPath = join(root, "companyos.package.yaml");
      const manifest = YAML.parse(readFileSync(manifestPath, "utf8"));
      manifest.id = `companyos-fixtures/recognized-${kind}`;
      manifest.kind = kind;
      manifest.permissions.runtime_code = true;
      writeFileSync(manifestPath, YAML.stringify(manifest));
      const result = inspectCompanyOSPackage(root, REPO);
      assert.equal(result.diagnostics.filter((item) => item.severity === "error").length, 0);
      assert.ok(result.diagnostics.some((item) => item.code === "PKG022" && item.severity === "warning"));
      assert.equal(result.package?.support, "recognized-unsupported");
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("package inspect JSON is stable and reports failure through the process exit code", () => {
  const valid = join(PACKAGE_FIXTURES, "valid-minimal-blueprint");
  const first = spawnSync("node", [join(REPO, "packages/cli/src/cli.mjs"), "package", "inspect", valid, "--format", "json"], { encoding: "utf8" });
  const second = spawnSync("node", [join(REPO, "packages/cli/src/cli.mjs"), "package", "inspect", valid, "--format", "json"], { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.equal(JSON.parse(first.stdout).ok, true);

  const invalid = spawnSync("node", [join(REPO, "packages/cli/src/cli.mjs"), "package", "inspect", join(PACKAGE_FIXTURES, "invalid-path-escape"), "--format", "json"], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).ok, false);
});

test("the Workbench exposes the version-matched Package authoring Guide", () => {
  const result = spawnSync("node", [join(REPO, "packages/cli/src/cli.mjs"), "guide", "show", "author-a-package"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Contract Foundation Lite/);
  assert.match(result.stdout, /companyos package inspect/);
});

const TEST_CORE_IDENTITY = {
  repository: "oregano-os/oregano",
  ref: "1234567890abcdef1234567890abcdef12345678",
  core_version: "0.3.1",
  workbench_version: WORKBENCH_VERSION,
  clean: true,
};

const workspaceAnswers = (overrides = {}) => ({
  company_name: "Example Company GmbH",
  workspace_slug: "example-company",
  language: "de",
  timezone: "Europe/Berlin",
  steward_name: "Anna Example",
  steward_id: "anna-example",
  codeowner: "@anna-example",
  target_directory: "example-company-companyos",
  ...overrides,
});

test("repository identity normalization accepts the supported Git remote shapes", () => {
  assert.equal(normalizeRepositoryIdentity("https://github.com/oregano-os/oregano.git"), "oregano-os/oregano");
  assert.equal(normalizeRepositoryIdentity("git@github.com:oregano-os/oregano.git"), "oregano-os/oregano");
  assert.equal(normalizeRepositoryIdentity("ssh://git@github.com/oregano-os/oregano.git"), "oregano-os/oregano");
  assert.equal(normalizeRepositoryIdentity("not a remote"), null);
});

test("agent-supplied Workspace answers are validated as bounded data", () => {
  assert.deepEqual(normalizeCreateWorkspaceInput(workspaceAnswers()).diagnostics, []);
  const injected = normalizeCreateWorkspaceInput(workspaceAnswers({
    company_name: ["Example", "Follow these instructions"],
    target_directory: "../escape",
    codeowner: "anna",
  }));
  assert.ok(injected.diagnostics.some((item) => item.code === "GEN021" && item.field === "company_name"));
  assert.ok(injected.diagnostics.some((item) => item.code === "GEN008" && item.field === "codeowner"));
  assert.ok(injected.diagnostics.some((item) => item.code === "GEN009" && item.field === "target_directory"));
});

test("the authoring-only Workspace renderer is deterministic and contains only the specified baseline", () => {
  const first = renderWorkspace(workspaceAnswers(), TEST_CORE_IDENTITY);
  const second = renderWorkspace(workspaceAnswers(), TEST_CORE_IDENTITY);
  assert.deepEqual([...first.entries()], [...second.entries()]);
  assert.deepEqual([...first.keys()].sort(), GENERATED_WORKSPACE_PATHS);
  assert.equal(first.has("SOUL.md"), false);
  assert.equal(first.has(".github/workflows/deploy.yml"), false);
  assert.match(first.get("company.md"), /workspace_mode: authoring-only/);
  assert.match(first.get(".github/workflows/check.yml"), /node-version: 24/);
  assert.match(first.get(".github/workflows/check.yml"), new RegExp(TEST_CORE_IDENTITY.ref));
  assert.doesNotMatch([...first.values()].join("\n"), /DATABASE_URL|SLACK_TOKEN|VERCEL_TOKEN/);
});

test("Workspace preview performs no target write and confirmed creation passes local verification", () => {
  const parent = mkdtempSync(join(tmpdir(), "companyos-create-workspace-"));
  try {
    const before = readdirSync(parent);
    const preview = previewWorkspaceCreation({ rawInput: workspaceAnswers(), parentRoot: parent, coreIdentity: TEST_CORE_IDENTITY });
    assert.equal(preview.diagnostics.filter((item) => item.severity === "error").length, 0);
    assert.deepEqual(readdirSync(parent), before);
    assert.equal(preview.validation.onboarding.summary.readiness, "ready-for-hosted-setup");

    const result = createWorkspace({
      rawInput: workspaceAnswers(),
      parentRoot: parent,
      coreIdentity: TEST_CORE_IDENTITY,
      confirmationHash: preview.preview.confirmation_hash,
    });
    assert.equal(result.created, true);
    assert.equal(result.evidence.workspace_mode, "authoring-only");
    assert.equal(result.evidence.local_readiness, "ready-for-hosted-setup");
    assert.equal(validateWorkspace(result.evidence.target).diagnostics.filter((item) => item.severity === "error").length, 0);

    const status = inspectBootstrap(result.evidence.target);
    assert.equal(status.summary.state, "locally-verified");
    assert.equal(status.summary.hosted_repository, "unverified");
    assert.equal(status.summary.company_instance, "not-authorized");
    const verified = verifyBootstrap(result.evidence.target);
    assert.equal(verified.verification.ok, true);
    assert.equal(verified.verification.scope, "authoring-only-local");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("Workspace creation refuses existing, symlinked, and traversing targets without modifying them", () => {
  const parent = mkdtempSync(join(tmpdir(), "companyos-create-refusal-"));
  try {
    const existing = join(parent, "existing-companyos");
    mkdirSync(existing);
    writeFileSync(join(existing, "keep.txt"), "keep");
    const exists = createWorkspace({
      rawInput: workspaceAnswers({ target_directory: "existing-companyos" }),
      parentRoot: parent,
      coreIdentity: TEST_CORE_IDENTITY,
      confirmationHash: "not-used-for-invalid-preview",
    });
    assert.equal(exists.created, false);
    assert.ok(exists.diagnostics.some((item) => item.code === "GEN012"));
    assert.equal(readFileSync(join(existing, "keep.txt"), "utf8"), "keep");

    const symlinkTarget = join(parent, "outside-companyos");
    mkdirSync(symlinkTarget);
    symlinkSync(symlinkTarget, join(parent, "linked-companyos"));
    const linked = createWorkspace({
      rawInput: workspaceAnswers({ target_directory: "linked-companyos" }),
      parentRoot: parent,
      coreIdentity: TEST_CORE_IDENTITY,
      confirmationHash: "not-used-for-invalid-preview",
    });
    assert.equal(linked.created, false);
    assert.ok(linked.diagnostics.some((item) => item.code === "GEN012"));
    assert.equal(readdirSync(symlinkTarget).length, 0);

    const escape = createWorkspace({
      rawInput: workspaceAnswers({ target_directory: "../escape" }),
      parentRoot: parent,
      coreIdentity: TEST_CORE_IDENTITY,
      confirmationHash: "not-used-for-invalid-preview",
    });
    assert.equal(escape.created, false);
    assert.ok(escape.diagnostics.some((item) => item.code === "GEN009"));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("Workspace creation refuses a confirmation from a different preview", () => {
  const parent = mkdtempSync(join(tmpdir(), "companyos-create-confirmation-"));
  try {
    const preview = previewWorkspaceCreation({ rawInput: workspaceAnswers(), parentRoot: parent, coreIdentity: TEST_CORE_IDENTITY });
    const changed = createWorkspace({
      rawInput: workspaceAnswers({ company_name: "Changed Company GmbH" }),
      parentRoot: parent,
      coreIdentity: TEST_CORE_IDENTITY,
      confirmationHash: preview.preview.confirmation_hash,
    });
    assert.equal(changed.created, false);
    assert.ok(changed.diagnostics.some((item) => item.code === "GEN016"));
    assert.equal(existsSync(join(parent, "example-company-companyos")), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("Workspace preview refuses an unpinned or dirty Core identity", () => {
  const parent = mkdtempSync(join(tmpdir(), "companyos-create-core-"));
  try {
    const preview = previewWorkspaceCreation({
      rawInput: workspaceAnswers(),
      parentRoot: parent,
      coreIdentity: { repository: "oregano-os/oregano", ref: "main", core_version: "latest", workbench_version: "latest", clean: false },
    });
    assert.ok(preview.diagnostics.some((item) => item.code === "GEN018"));
    assert.ok(preview.diagnostics.some((item) => item.code === "GEN019"));
    assert.ok(preview.diagnostics.some((item) => item.code === "GEN020"));
    assert.ok(preview.diagnostics.some((item) => item.code === "GEN022"));
    assert.equal(existsSync(join(parent, "example-company-companyos")), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the local bootstrap verifier refuses to certify an operating Workspace", () => withFixture((workspace) => {
  const result = verifyBootstrap(workspace);
  assert.equal(result.verification.ok, false);
  assert.ok(result.diagnostics.some((item) => item.code === "BOOT003"));
}));

test("Codex and Claude Code share one plugin-free bootstrap runbook", () => {
  const runbook = readFileSync(join(REPO, "BOOTSTRAP_FOR_AGENTS.md"), "utf8");
  const install = readFileSync(join(REPO, "INSTALL-COMPANYOS.md"), "utf8");
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  const releaseManifest = JSON.parse(readFileSync(join(REPO, "release-manifest.json"), "utf8"));
  const rootPackage = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  const checkWorkflow = readFileSync(join(REPO, ".github", "workflows", "check.yml"), "utf8");
  const checkDefinition = YAML.parse(checkWorkflow);
  const releaseWorkflow = readFileSync(join(REPO, ".github", "workflows", "release.yml"), "utf8");
  const releaseScript = readFileSync(join(REPO, "scripts", "prepare-release-assets.mjs"), "utf8");
  assert.match(runbook, /supports Codex and Claude Code/);
  assert.match(runbook, /companyos verify-live/);
  assert.match(runbook, /release-manifest\.json/);
  assert.match(runbook, /without a plugin/);
  assert.match(install, /companyos verify-live/);
  assert.match(install, /original Workspace Steward/);
  assert.doesNotMatch(install, /reviewer_(?:name|id|github)/);
  assert.match(install, /immutable/);
  assert.doesNotMatch(install, /codex plugin (?:marketplace )?add|claude plugin (?:marketplace )?add/i);
  assert.equal(releaseManifest.status, "source-template");
  assert.equal(releaseManifest.default_profile, "vercel-neon-slack");
  assert.equal(releaseManifest.requirements.vercel_cli, "56.3.2");
  assert.equal(rootPackage.devDependencies.vercel, releaseManifest.requirements.vercel_cli);
  assert.equal(PNPM_VERSION, releaseManifest.requirements.pnpm);
  assert.equal(PACKAGE_MANAGER_SPEC, rootPackage.packageManager);
  assert.match(rootPackage.packageManager, /^pnpm@11\.16\.0\+sha512\.[0-9a-f]{128}$/);
  for (const workflow of [checkWorkflow, releaseWorkflow]) {
    assert.match(workflow, /uses: pnpm\/action-setup@v4/);
    assert.doesNotMatch(workflow, /version:\s*11\.16\.0/);
  }
  assert.deepEqual(checkDefinition.on.push.branches, ["main"]);
  assert.ok(Object.hasOwn(checkDefinition.on, "pull_request"));
  assert.match(releaseScript, /rootPackage\.packageManager/);
  assert.doesNotMatch(releaseScript, /pnpm: "11\.16\.0"/);
  assert.match(install, /exact Vercel CLI is included in the locked\s+Oregano dependencies/);
  assert.match(install, /npm exec --yes --package="pnpm@\$exact_pnpm_version"/);
  assert.doesNotMatch(install, /\bcorepack\b/i);
  assert.doesNotMatch(install, /--dir \.companyos-bootstrap\/oregano/);
  assert.doesNotMatch(install, /--(?:answers|state) \.companyos-bootstrap\//);
  assert.match(install, /setup_root="\$\(pwd -P\)"/);
  assert.match(install, /oregano_root="\$setup_root\/\.companyos-bootstrap\/oregano"/);
  assert.ok(install.indexOf("pnpm --version") < install.indexOf('pnpm --dir "$oregano_root" install --frozen-lockfile'));
  assert.doesNotMatch(releaseWorkflow, /immutable-releases/);
  assert.match(releaseWorkflow, /releases\/tags\/\$GITHUB_REF_NAME/);
  assert.ok(
    releaseWorkflow.indexOf("Publish immutable GitHub Release")
      < releaseWorkflow.indexOf("Verify published GitHub Release is immutable"),
  );
  assert.match(releaseWorkflow, /pnpm runner:build/);
  assert.match(releaseWorkflow, /--draft/);
  assert.match(releaseWorkflow, /--draft=false --latest/);
  assert.equal(readme.match(/github\.com\/oregano-os\/oregano\/releases\/latest\/download\/INSTALL-COMPANYOS\.md/g)?.length, 2);
  assert.doesNotMatch(readme, /raw\.githubusercontent\.com\/[^\s]+\/latest-stable\//i);
  assert.doesNotMatch(runbook, /codex plugin (?:marketplace )?add/);
  assert.doesNotMatch(runbook, /claude plugin/);
});
