import { inspectWorkspaceCompatibility } from "./compatibility.mjs";
import { inspectRepositoryProtectionContract, isSoleStewardBootstrapBypass } from "./repository-protection.mjs";
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
  const soleStewardBootstrap = isSoleStewardBootstrapBypass(protection.config?.rules?.bypass);
  const hostedProtectionBlocked = protection.config?.verification?.status === "blocked";

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
      review_separation: soleStewardBootstrap ? "sole-steward-bootstrap-exception" : "independent-review",
    },
    checklist: [
      {
        id: "git-host-account-and-plan",
        status: hostedProtectionBlocked ? "blocked" : "manual",
        next: hostedProtectionBlocked
          ? `The GitHub account exists, but hosted protection is unavailable: ${protection.config.verification.blocker}. Use a private-repository plan that enforces rulesets and verify admin recovery ownership.`
          : "The Repository Administrator must verify an individual GitHub identity, repository admin and recovery access, and a plan that enforces the declared ruleset.",
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
        id: "github-ruleset",
        status: hostedProtectionBlocked ? "blocked" : "manual",
        next: hostedProtectionBlocked
          ? `Hosted ruleset activation is blocked: ${protection.config.verification.blocker}. Resolve the provider prerequisite and retry.`
          : soleStewardBootstrap
            ? "A Repository Administrator must apply the PR-only sole-steward bootstrap exception and verify that every other author still requires approval."
            : "A Repository Administrator must apply and verify the declared ruleset on GitHub.",
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
