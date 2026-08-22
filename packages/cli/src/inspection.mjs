import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import YAML from "yaml";
import { inspectWorkspaceCompatibility } from "./compatibility.mjs";
import { diagnostic } from "./diagnostics.mjs";
import { readChangePlan, validateChangePlan } from "./change-plan.mjs";

export const CLASS_RANK = { content: 1, behavior: 2, security: 3 };

export const globToRegExp = (glob) => {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*" && glob[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
};

export const changedFiles = (root, baseRef) => {
  const run = (...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  const tracked = baseRef
    ? run("diff", "--name-only", `${baseRef}...HEAD`)
    : run("diff", "--name-only", "HEAD");
  if (tracked.status !== 0) return null;
  const untracked = run("ls-files", "--others", "--exclude-standard");
  if (untracked.status !== 0) return null;
  return [...new Set(`${tracked.stdout}\n${untracked.stdout}`.split("\n").map((item) => item.trim()).filter(Boolean))].sort();
};

export const classifyFiles = (files, governance) => {
  const classified = files.map((file) => {
    const matches = [];
    for (const [name, config] of Object.entries(governance?.change_classes ?? {})) {
      if ((config.paths ?? []).some((pattern) => globToRegExp(pattern).test(file))) matches.push(name);
    }
    matches.sort((left, right) => (CLASS_RANK[right] ?? 0) - (CLASS_RANK[left] ?? 0));
    return { file, change_class: matches[0] ?? null, matches };
  });
  const effective = classified.reduce((highest, item) =>
    (CLASS_RANK[item.change_class] ?? 0) > (CLASS_RANK[highest] ?? 0) ? item.change_class : highest, null);
  return { classified, effective };
};

export function inspectWorkspace(root, planPath, baseRef) {
  const diagnostics = [];
  const facts = {
    target: root,
    has_company_definition: existsSync(join(root, "company.md")),
    has_governance: existsSync(join(root, ".companyos", "governance.yaml")),
    has_agent_entrypoint: existsSync(join(root, "AGENTS.md")),
    has_pinned_toolchain: false,
    plan: planPath ?? null,
    diff_base: baseRef ?? null,
    changed_files: null,
    effective_change_class: null,
  };
  const packagePath = join(root, "package.json");
  const compatibility = inspectWorkspaceCompatibility(root);
  facts.has_pinned_toolchain = compatibility.config?.mode === "core-checkout" && compatibility.diagnostics.length === 0;
  if (existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
      const version = pkg.devDependencies?.["@companyos/cli"];
      facts.has_pinned_toolchain ||= typeof version === "string" && !/[~^*]/.test(version);
    } catch {
      diagnostics.push(diagnostic("FIT001", "warning", "package.json could not be parsed for Workbench pin inspection.", { file: "package.json" }));
    }
  }
  if (!facts.has_governance) diagnostics.push(diagnostic("FIT002", "warning", "Architecture fitness is incomplete without Workspace governance."));
  if (!facts.has_agent_entrypoint) diagnostics.push(diagnostic("FIT003", "warning", "Agent Contributors have no Workspace-local AGENTS.md entrypoint."));
  if (!facts.has_pinned_toolchain) diagnostics.push(diagnostic("FIT004", "warning", "Workspace does not pin an exact CompanyOS Workbench version."));

  let governance;
  const governancePath = join(root, ".companyos", "governance.yaml");
  if (existsSync(governancePath)) {
    try { governance = YAML.parse(readFileSync(governancePath, "utf8")); }
    catch (error) { diagnostics.push(diagnostic("FIT005", "error", `Governance cannot be parsed: ${error.message.split("\n")[0]}`, { file: ".companyos/governance.yaml" })); }
  }

  const files = changedFiles(root, baseRef);
  let diffClassification = null;
  if (files === null) diagnostics.push(diagnostic("FIT006", "info", "Changed-file inspection is unavailable because the target is not a readable Git worktree."));
  else {
    diffClassification = classifyFiles(files, governance);
    facts.changed_files = files;
    facts.effective_change_class = diffClassification.effective;
    for (const item of diffClassification.classified.filter((entry) => !entry.change_class)) {
      diagnostics.push(diagnostic("FIT007", "warning", "Changed file is not covered by any governance class.", { file: item.file }));
    }
  }

  let resolvedPlanPath = planPath;
  if (planPath === "auto") {
    const candidates = (files ?? []).filter((file) => /^\.companyos\/changes\/[^/]+\.ya?ml$/.test(file));
    if (candidates.length === 1) resolvedPlanPath = join(root, candidates[0]);
    else if (candidates.length > 1) {
      resolvedPlanPath = null;
      diagnostics.push(diagnostic("FIT012", "error", "Automatic Change Plan discovery found multiple changed plan files; select one explicitly."));
    } else resolvedPlanPath = null;
    facts.plan = resolvedPlanPath;
  }

  let plan = null;
  if (resolvedPlanPath) {
    diagnostics.push(...validateChangePlan(resolvedPlanPath, { allowAuthorApproval: governance?.review_mode === "steward" }));
    try { plan = readChangePlan(resolvedPlanPath); }
    catch { /* The Change Plan validator already reports the parse failure. */ }
    if (plan?.placement && plan.placement !== "workspace") diagnostics.push(diagnostic("FIT008", "error", `Plan placement '${plan.placement}' does not match a Company Workspace inspection.`, { file: resolvedPlanPath }));
    if (plan?.change_class && diffClassification?.effective && CLASS_RANK[plan.change_class] < CLASS_RANK[diffClassification.effective]) {
      diagnostics.push(diagnostic("FIT009", "error", `Plan declares '${plan.change_class}', but the actual diff requires '${diffClassification.effective}'.`, { file: resolvedPlanPath }));
    }
    const expected = plan?.files_expected ?? [];
    for (const file of files ?? []) {
      if (expected.length > 0 && !expected.some((pattern) => globToRegExp(pattern).test(file))) diagnostics.push(diagnostic("FIT010", "warning", "Changed file is not listed in files_expected.", { file }));
    }
  } else if (diffClassification?.effective && ["behavior", "security"].includes(diffClassification.effective)) {
    diagnostics.push(diagnostic("FIT011", "error", `The actual diff is '${diffClassification.effective}' class and requires --plan <file>.`));
  }

  return {
    diagnostics,
    report: {
      status: diagnostics.length ? "needs-review" : "ready-for-review",
      facts,
      diff_classification: diffClassification,
      change_plan: plan,
      required_judgments: [
        "Does this change belong in Core, the Company Workspace, or the Company Instance?",
        "Does it duplicate or bypass an existing source of truth?",
        "Can it weaken a Core safety invariant?",
        "Should a company-specific implementation graduate into a generic Core capability?",
        "Are documentation, migration, evidence, and rollback complete?",
        "If setup, versioning, CI, or governance changed, is onboarding still accurate and executable?",
      ],
    },
  };
}
