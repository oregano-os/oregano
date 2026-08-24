import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { diagnostic } from "./diagnostics.mjs";
import { checkGeneratedDocumentation, inspectDocumentation } from "./docs-control.mjs";
import { readChangePlan, validateChangePlan } from "./change-plan.mjs";
import { CLASS_RANK, changedFiles, classifyFiles, globToRegExp } from "./inspection.mjs";

const REQUIRED_CONTROL_PLANE = [
  "docs/vision.md",
  "docs/architecture/overview.md",
  "docs/architecture/system-boundaries.md",
  "docs/architecture/ecosystem-and-packages.md",
  "docs/specifications/companyos-packages-v0.1-draft.md",
  "docs/compatibility/registry.yaml",
  "docs/status/current.md",
  "docs/reference/translation-exceptions.md",
  "docs/governance/core-change-policy.yaml",
];

export function inspectCoreDocumentationImpact(files, plan, documentation, governance) {
  if (!Array.isArray(files) || !plan) return [];
  const diagnostics = [];
  const affected = new Set(plan?.documentation_impact?.affected_documents ?? []);

  for (const documentId of affected) {
    const document = documentation.byId?.get(documentId);
    if (!document) {
      diagnostics.push(diagnostic("CFIT013", "error", `Change Plan references unknown affected document '${documentId}'.`));
      continue;
    }
    const path = `docs/${document.relative}`;
    if (!files.includes(path)) {
      diagnostics.push(diagnostic("CFIT014", "error", `Affected canonical document '${documentId}' is not changed in the inspected diff.`, {
        file: path,
        hint: "Update the document in the same change or remove the incorrect impact declaration.",
      }));
    }
  }

  for (const [name, contract] of Object.entries(governance?.documentation_contracts ?? {})) {
    const triggered = (contract.paths ?? []).some((pattern) => {
      const matcher = globToRegExp(pattern);
      return files.some((file) => matcher.test(file));
    });
    if (!triggered) continue;

    for (const documentId of contract.required_documents ?? []) {
      if (!documentation.byId?.has(documentId)) {
        diagnostics.push(diagnostic("CFIT015", "error", `Documentation contract '${name}' references unknown document '${documentId}'.`, {
          file: "docs/governance/core-change-policy.yaml",
        }));
      } else if (!affected.has(documentId)) {
        diagnostics.push(diagnostic("CFIT016", "error", `Documentation contract '${name}' requires affected document '${documentId}' in the Core Change Plan.`));
      }
    }
    for (const path of contract.required_files ?? []) {
      if (!files.includes(path)) {
        diagnostics.push(diagnostic("CFIT017", "error", `Documentation contract '${name}' requires '${path}' to change with the triggering implementation.`, {
          file: path,
        }));
      }
    }
  }

  return diagnostics;
}

export function inspectCore(root, planPath, baseRef) {
  const diagnostics = [];
  for (const path of REQUIRED_CONTROL_PLANE) {
    if (!existsSync(join(root, path))) diagnostics.push(diagnostic("CFIT001", "error", "Required Core control-plane artifact is missing.", { file: path }));
  }

  const documentation = inspectDocumentation(root);
  diagnostics.push(...documentation.diagnostics, ...checkGeneratedDocumentation(root, documentation.documents));

  let governance;
  const policyPath = join(root, "docs", "governance", "core-change-policy.yaml");
  if (existsSync(policyPath)) {
    try { governance = YAML.parse(readFileSync(policyPath, "utf8")); }
    catch (error) { diagnostics.push(diagnostic("CFIT002", "error", `Core change policy cannot be parsed: ${error.message.split("\n")[0]}`, { file: "docs/governance/core-change-policy.yaml" })); }
  }
  if (governance?.review_mode !== "maintainer") diagnostics.push(diagnostic("CFIT010", "error", "Core governance must declare review_mode: maintainer.", { file: "docs/governance/core-change-policy.yaml" }));
  if (governance?.change_classes?.security?.approval !== "oregano-maintainer") diagnostics.push(diagnostic("CFIT011", "error", "Core security changes must require Oregano Maintainer authority.", { file: "docs/governance/core-change-policy.yaml" }));
  if (governance?.change_classes?.security?.two_person_review !== undefined || governance?.change_classes?.security?.review_model !== undefined) diagnostics.push(diagnostic("CFIT012", "error", "Maintainer review mode must not declare a mandatory second-person review.", { file: "docs/governance/core-change-policy.yaml" }));

  const files = changedFiles(root, baseRef);
  let diffClassification = null;
  if (files === null) diagnostics.push(diagnostic("CFIT003", "error", "Core diff inspection requires a readable Git worktree."));
  else {
    diffClassification = classifyFiles(files, governance);
    for (const item of diffClassification.classified.filter((entry) => !entry.change_class)) {
      diagnostics.push(diagnostic("CFIT004", "warning", "Changed Core file is not covered by any governance class.", { file: item.file }));
    }
  }

  let resolvedPlanPath = planPath;
  if (planPath === "auto") {
    const candidates = (files ?? []).filter((file) => /^\.oregano\/changes\/[^/]+\.ya?ml$/.test(file));
    if (candidates.length === 1) resolvedPlanPath = join(root, candidates[0]);
    else if (candidates.length > 1) {
      resolvedPlanPath = null;
      diagnostics.push(diagnostic("CFIT005", "error", "Automatic Core Change Plan discovery found multiple changed plan files."));
    } else resolvedPlanPath = null;
  }

  let plan = null;
  if (resolvedPlanPath) {
    diagnostics.push(...validateChangePlan(resolvedPlanPath, { allowAuthorApproval: governance?.review_mode === "maintainer" }));
    try { plan = readChangePlan(resolvedPlanPath); }
    catch { /* Plan diagnostics already contain the parse error. */ }
    if (plan?.placement && plan.placement !== "core") diagnostics.push(diagnostic("CFIT006", "error", `Plan placement '${plan.placement}' does not match Oregano Core.`, { file: resolvedPlanPath }));
    if (plan?.change_class && diffClassification?.effective && CLASS_RANK[plan.change_class] < CLASS_RANK[diffClassification.effective]) {
      diagnostics.push(diagnostic("CFIT007", "error", `Plan declares '${plan.change_class}', but the actual Core diff requires '${diffClassification.effective}'.`, { file: resolvedPlanPath }));
    }
    const expected = plan?.files_expected ?? [];
    for (const file of files ?? []) {
      if (expected.length > 0 && !expected.some((pattern) => globToRegExp(pattern).test(file))) diagnostics.push(diagnostic("CFIT008", "warning", "Changed Core file is not listed in files_expected.", { file }));
    }
    diagnostics.push(...inspectCoreDocumentationImpact(files, plan, documentation, governance));
  } else if (diffClassification?.effective && ["behavior", "security"].includes(diffClassification.effective)) {
    diagnostics.push(diagnostic("CFIT009", "error", `The actual Core diff is '${diffClassification.effective}' class and requires a Core Change Plan.`));
  }

  return {
    diagnostics,
    report: {
      status: diagnostics.some((item) => item.severity === "error") ? "blocked" : "ready-for-merge",
      facts: {
        target: root,
        plan: resolvedPlanPath ?? null,
        diff_base: baseRef ?? null,
        changed_files: files,
        effective_change_class: diffClassification?.effective ?? null,
      },
      diff_classification: diffClassification,
      change_plan: plan,
      required_judgments: [
        "Does the change move CompanyOS toward the North Star and preserve every affected Vision principle?",
        "Is each responsibility in Oregano Core, Company Workspace, or Company Instance for the right reason?",
        "Does the real implementation match the documented architecture and current status?",
        "Does the change preserve fail-closed authority, evidence, idempotency, and repository separation?",
        "Are compatibility, migration, documentation, tests, and rollback complete?",
        "If setup, versioning, CI, or governance changed, is onboarding still accurate and executable?",
        "If a Package contract changed, do the manifest schema, Compatibility Registry, Inspector behavior, fixture evidence, and migration guidance still agree?",
        "Does Package work preserve the separation between declarative content, restricted Tool code, privileged Connector code, company grants, Instance bindings, and runtime approval?",
      ],
    },
  };
}
