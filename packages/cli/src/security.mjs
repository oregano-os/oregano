import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inspectWorkspaceCompatibility } from "./compatibility.mjs";
import { diagnostic } from "./diagnostics.mjs";
import { inspectRepositoryProtectionContract } from "./repository-protection.mjs";

export function inspectWorkspaceSecurity(root) {
  const diagnostics = [];
  const required = [
    ["AGENTS.md", "SEC010", "Workspace-local agent entrypoint is missing."],
    [".companyos/governance.yaml", "SEC011", "Machine-readable governance policy is missing."],
    [".companyos/compatibility.yaml", "SEC022", "Immutable Core and Workbench compatibility pin is missing."],
    [".companyos/repository-protection.yaml", "SEC023", "Machine-readable repository protection contract is missing."],
    [".github/CODEOWNERS", "SEC012", "CODEOWNERS is missing; protected path review cannot be assigned in Git."],
    [".github/workflows/check.yml", "SEC013", "Required Workspace CI workflow is missing."],
  ];
  for (const [path, code, message] of required) {
    if (!existsSync(join(root, path))) diagnostics.push(diagnostic(code, "warning", message, { file: path }));
  }
  const governance = join(root, ".companyos", "governance.yaml");
  if (existsSync(governance)) {
    const raw = readFileSync(governance, "utf8");
    if (!/may_only_tighten:\s*true/.test(raw)) diagnostics.push(diagnostic("SEC014", "error", "Governance must declare core_defaults.may_only_tighten: true.", { file: ".companyos/governance.yaml" }));
    if (!/\.companyos\/\*\*/.test(raw)) diagnostics.push(diagnostic("SEC015", "warning", "Governance does not visibly protect its own .companyos/** path."));
  }
  const compatibility = inspectWorkspaceCompatibility(root);
  diagnostics.push(...compatibility.diagnostics);
  const packagePath = join(root, "package.json");
  if (compatibility.config?.mode === "core-checkout" && compatibility.diagnostics.length === 0) {
    diagnostics.push(diagnostic("SEC024", "info", "Workbench is reproducibly pinned through the immutable Core checkout; a published package is still required for Workspace-only use.", { file: ".companyos/compatibility.yaml" }));
  } else if (!existsSync(packagePath)) diagnostics.push(diagnostic("SEC016", "warning", "Workspace does not pin an exact CompanyOS Workbench package version; Workspace-only use is not reproducible.", { file: "package.json" }));
  else {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
      const version = pkg.devDependencies?.["@companyos/cli"] ?? pkg.dependencies?.["@companyos/cli"];
      if (typeof version !== "string" || /[~^*]/.test(version)) diagnostics.push(diagnostic("SEC016", "warning", "Workspace must pin @companyos/cli to one exact version.", { file: "package.json" }));
    } catch (error) {
      diagnostics.push(diagnostic("SEC017", "error", `package.json cannot be parsed: ${error.message.split("\n")[0]}`, { file: "package.json" }));
    }
  }

  diagnostics.push(...inspectRepositoryProtectionContract(root).diagnostics);

  const codeownersPath = join(root, ".github", "CODEOWNERS");
  if (existsSync(codeownersPath)) {
    const codeowners = readFileSync(codeownersPath, "utf8");
    for (const protectedPath of ["/.companyos/", "/.github/", "/AGENTS.md", "/company.md", "/agents/builder/"]) {
      if (!codeowners.includes(protectedPath)) diagnostics.push(diagnostic("SEC018", "error", `CODEOWNERS must cover '${protectedPath}'.`, { file: ".github/CODEOWNERS" }));
    }
  }

  const workflowPath = join(root, ".github", "workflows", "check.yml");
  if (existsSync(workflowPath)) {
    const workflow = readFileSync(workflowPath, "utf8");
    if (!/companyos.*validate|cli\.mjs validate/.test(workflow)) diagnostics.push(diagnostic("SEC020", "error", "Workspace CI must execute CompanyOS validation.", { file: ".github/workflows/check.yml" }));
    if (!/companyos.*inspect|cli\.mjs inspect/.test(workflow)) diagnostics.push(diagnostic("SEC021", "error", "Workspace CI must inspect governed pull-request diffs.", { file: ".github/workflows/check.yml" }));
  }
  diagnostics.push(diagnostic("SEC019", "info", "Local files cannot prove hosted branch protection. The maintained setup applies and verifies it when the provider supports it; unavailable hosted enforcement does not block the Tool-free supervised starter."));
  return diagnostics;
}
