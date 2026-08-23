import { inspectWorkspaceCompatibility } from "./compatibility.mjs";
import { inspectRepositoryProtectionContract } from "./repository-protection.mjs";
import { inspectWorkspaceSecurity } from "./security.mjs";
import { validateWorkspace } from "./workspace-validator.mjs";

const hasBlocking = (diagnostics) => diagnostics.some((item) => item.severity === "error");

export function inspectWorkspaceOnboarding(root) {
  const workspace = validateWorkspace(root);
  const security = inspectWorkspaceSecurity(root);
  const compatibility = inspectWorkspaceCompatibility(root);
  const protection = inspectRepositoryProtectionContract(root);
  const diagnostics = [...workspace.diagnostics, ...security]
    .filter((item, index, all) => all.findIndex((candidate) =>
      candidate.code === item.code && candidate.file === item.file && candidate.message === item.message) === index);

  const localProtectionBlocked = hasBlocking(protection.diagnostics) ||
    security.some((item) => item.severity === "error" && item.code !== "SEC019");
  const operatingAgents = Math.max(0, Number(workspace.summary?.agents ?? 0) - 1);
  const workspaceMode = workspace.summary?.workspace_mode ?? null;
  const unattendedWorkflows = Number(workspace.summary?.unattended_workflows ?? 0);
  const hostedProtectionStatus = protection.config?.verification?.status ?? "pending";

  return {
    diagnostics,
    summary: {
      workspace: workspace.summary?.workspace ?? null,
      readiness: hasBlocking(diagnostics) ? "blocked" : "ready-for-hosted-setup",
      operating_agents: operatingAgents,
      workspace_mode: workspaceMode,
      execution_readiness: workspaceMode === "authoring-only"
        ? "not-applicable"
        : unattendedWorkflows > 0 ? "unattended-enforcement-unverified" : "supervised-requires-instance-verification",
      review_mode: workspace.summary?.review_mode ?? null,
    },
    checklist: [
      {
        id: "git-host-account",
        status: "manual",
        next: "The Repository Administrator must verify an individual GitHub identity, private-repository admin access, and account recovery ownership. GitHub Free is sufficient for the supervised starter.",
      },
      {
        id: "workspace-contract",
        status: hasBlocking(workspace.diagnostics) ? "blocked" : "complete",
        next: hasBlocking(workspace.diagnostics)
          ? "Fix Company Workspace validation errors."
          : "The local Company Workspace contract validates.",
      },
      {
        id: "core-and-workbench-pin",
        status: hasBlocking(compatibility.diagnostics) ? "blocked" : "complete",
        next: hasBlocking(compatibility.diagnostics)
          ? "Pin an immutable Core commit and exact Workbench version."
          : "An immutable Core commit and exact Workbench version are declared.",
      },
      {
        id: "repository-files",
        status: localProtectionBlocked ? "blocked" : "complete",
        next: localProtectionBlocked
          ? "Add governance, CODEOWNERS, CI, and the repository protection contract."
          : "Governance, CODEOWNERS, CI, and the protection contract are present.",
      },
      {
        id: "github-protection",
        status: hostedProtectionStatus === "enforced" ? "complete" : "manual",
        next: hostedProtectionStatus === "enforced"
          ? "GitHub reports the declared protected-main controls as enforced."
          : hostedProtectionStatus === "advisory"
            ? "GitHub does not enforce the declared protected-main controls. This is acceptable for the supervised starter; require hosted enforcement before granting unattended repository write, merge, or deployment authority."
            : "The maintained setup automatically applies and verifies the declared protected-main controls when GitHub supports them; unavailable hosted enforcement does not block the supervised starter.",
      },
      {
        id: "operating-model",
        status: workspaceMode === "authoring-only" ? "deferred" : hasBlocking(workspace.diagnostics) ? "blocked" : "complete",
        next: workspaceMode === "authoring-only"
          ? "The Workspace is authoring-only until an approved change introduces an operating agent, workflow, and workspace_mode: operating."
          : "Validate every operating agent, workflow, Tool grant, and Instance dependency.",
      },
      {
        id: "unattended-execution",
        status: workspaceMode === "authoring-only" || unattendedWorkflows === 0 ? "deferred" : "blocked",
        next: workspaceMode === "authoring-only"
          ? "No execution is permitted in authoring-only mode."
          : unattendedWorkflows === 0
            ? "All declared workflows are supervised; no unattended production claim exists."
            : "Unattended workflows require resolved Tools, compiled enforcement, verified Instance controls, and passing runtime evidence before deployment.",
      },
      {
        id: "company-instance",
        status: workspaceMode === "operating" ? "manual" : "deferred",
        next: workspaceMode === "operating"
          ? "A Platform Administrator must verify runtime-host and state-provider accounts, projects, environment isolation, secrets, deployment identity, and rollback. The reference setup is Vercel plus Neon/Postgres; conforming alternatives are allowed."
          : "No Vercel or Neon account is required in authoring-only mode. Provision reference or conforming alternative providers before an operating Instance is approved.",
      },
    ],
    contracts: {
      compatibility: compatibility.config,
      repository_protection: protection.config,
    },
  };
}
