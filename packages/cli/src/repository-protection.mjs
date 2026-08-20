import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { diagnostic } from "./diagnostics.mjs";

const REQUIRED_TRUE_RULES = [
  "require_pull_request",
  "require_code_owner_review",
  "dismiss_stale_approvals",
  "require_conversation_resolution",
  "block_force_pushes",
  "block_deletions",
];

export const isSoleStewardBootstrapBypass = (bypass) =>
  bypass?.mode === "pull_request" &&
  Array.isArray(bypass?.actors) &&
  bypass.actors.length === 1 &&
  bypass.actors[0]?.type === "user" &&
  typeof bypass.actors[0]?.login === "string" &&
  bypass.actors[0].login.length > 0 &&
  bypass.actors[0]?.purpose === "sole-steward-bootstrap" &&
  bypass?.constraints?.workspace_mode === "authoring-only" &&
  bypass?.constraints?.expires_when === "independent-reviewer-appointed";

export function inspectRepositoryProtectionContract(root) {
  const path = join(root, ".companyos", "repository-protection.yaml");
  const diagnostics = [];
  if (!existsSync(path)) {
    return {
      config: null,
      diagnostics: [diagnostic("RPR001", "error", "Repository protection contract is missing.", {
        file: ".companyos/repository-protection.yaml",
      })],
    };
  }

  let config;
  try {
    config = YAML.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      config: null,
      diagnostics: [diagnostic("RPR002", "error", `Repository protection contract cannot be parsed: ${error.message.split("\n")[0]}`, {
        file: ".companyos/repository-protection.yaml",
      })],
    };
  }

  if (config?.version !== 1) diagnostics.push(diagnostic("RPR003", "error", "Repository protection contract must declare version: 1.", { file: ".companyos/repository-protection.yaml" }));
  if (config?.provider !== "github") diagnostics.push(diagnostic("RPR004", "error", "Current repository protection contract supports provider 'github'.", { file: ".companyos/repository-protection.yaml" }));
  if (config?.target?.branch !== "main") diagnostics.push(diagnostic("RPR005", "error", "Repository protection must target the main branch.", { file: ".companyos/repository-protection.yaml" }));
  for (const rule of REQUIRED_TRUE_RULES) {
    if (config?.rules?.[rule] !== true) diagnostics.push(diagnostic("RPR006", "error", `Repository protection must set rules.${rule}: true.`, { file: ".companyos/repository-protection.yaml" }));
  }
  if (config?.rules?.required_approvals !== 1) diagnostics.push(diagnostic("RPR007", "error", "Repository protection must require exactly one approval from an authorized reviewer for authors without bypass.", { file: ".companyos/repository-protection.yaml" }));
  if (!Array.isArray(config?.rules?.required_status_checks) || !config.rules.required_status_checks.includes("check")) {
    diagnostics.push(diagnostic("RPR008", "error", "Repository protection must require the 'check' status.", { file: ".companyos/repository-protection.yaml" }));
  }
  const bypass = config?.rules?.bypass;
  if (bypass !== "none" && !isSoleStewardBootstrapBypass(bypass)) {
    diagnostics.push(diagnostic("RPR009", "error", "Ruleset bypass must be 'none' or one named user with the constrained sole-steward pull-request bootstrap exception.", { file: ".companyos/repository-protection.yaml" }));
  } else if (isSoleStewardBootstrapBypass(bypass)) {
    diagnostics.push(diagnostic("RPR011", "warning", "Independent review is unavailable: the named sole Workspace Steward may bypass approval requirements only through a pull request. Remove this bootstrap exception before the Workspace becomes operating.", { file: ".companyos/repository-protection.yaml" }));
  }
  if (!new Set(["pending", "blocked", "verified"]).has(config?.verification?.status)) {
    diagnostics.push(diagnostic("RPR010", "error", "Repository protection verification.status must be pending, blocked, or verified.", { file: ".companyos/repository-protection.yaml" }));
  }
  if (config?.verification?.status === "blocked" && (
    typeof config?.verification?.blocker !== "string" || config.verification.blocker.length === 0 ||
    typeof config?.verification?.checked_at !== "string" || config.verification.checked_at.length === 0 ||
    typeof config?.verification?.checked_by !== "string" || config.verification.checked_by.length === 0
  )) {
    diagnostics.push(diagnostic("RPR013", "error", "Blocked hosted verification must record blocker, checked_at, and checked_by.", { file: ".companyos/repository-protection.yaml" }));
  }

  return { config, diagnostics };
}
