import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { diagnostic } from "./diagnostics.mjs";
import { CORE_VERSION } from "./core-version.mjs";
import { WORKBENCH_VERSION } from "./workbench-version.mjs";
import { isExactSemanticVersion } from "../../runtime/semantic-version.ts";

export const EXACT_CORE_REF = /^[0-9a-f]{40}$/;

export function inspectWorkspaceCompatibility(root) {
  const path = join(root, ".companyos", "compatibility.yaml");
  const diagnostics = [];
  if (!existsSync(path)) {
    return {
      config: null,
      diagnostics: [diagnostic("CMP001", "error", "Workspace compatibility contract is missing.", {
        file: ".companyos/compatibility.yaml",
      })],
    };
  }

  let config;
  try {
    config = YAML.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      config: null,
      diagnostics: [diagnostic("CMP002", "error", `Compatibility contract cannot be parsed: ${error.message.split("\n")[0]}`, {
        file: ".companyos/compatibility.yaml",
      })],
    };
  }

  if (config?.version !== 1) diagnostics.push(diagnostic("CMP003", "error", "Compatibility contract must declare version: 1.", { file: ".companyos/compatibility.yaml" }));
  if (config?.mode !== "core-checkout") diagnostics.push(diagnostic("CMP004", "error", "Current Workbench supports compatibility mode 'core-checkout'.", { file: ".companyos/compatibility.yaml" }));
  if (typeof config?.core?.repository !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(config.core.repository)) {
    diagnostics.push(diagnostic("CMP005", "error", "Compatibility core.repository must be an owner/repository identifier.", { file: ".companyos/compatibility.yaml" }));
  }
  if (!EXACT_CORE_REF.test(String(config?.core?.ref ?? ""))) {
    diagnostics.push(diagnostic("CMP006", "error", "Compatibility core.ref must be one immutable 40-character Git commit SHA.", { file: ".companyos/compatibility.yaml" }));
  }
  if (!isExactSemanticVersion(config?.core?.version)) {
    diagnostics.push(diagnostic("CMP009", "error", "Compatibility core.version must be one exact semantic version.", { file: ".companyos/compatibility.yaml" }));
  } else if (config.core.version !== CORE_VERSION) {
    diagnostics.push(diagnostic("CMP010", "error", `Workspace pins Core version '${config.core.version}', but the checked-out Core is '${CORE_VERSION}'.`, { file: ".companyos/compatibility.yaml" }));
  }
  if (!isExactSemanticVersion(config?.workbench?.version)) {
    diagnostics.push(diagnostic("CMP007", "error", "Compatibility workbench.version must be one exact semantic version.", { file: ".companyos/compatibility.yaml" }));
  } else if (config.workbench.version !== WORKBENCH_VERSION) {
    diagnostics.push(diagnostic("CMP008", "error", `Workspace pins Workbench '${config.workbench.version}', but the running Workbench is '${WORKBENCH_VERSION}'.`, { file: ".companyos/compatibility.yaml" }));
  }

  return { config, diagnostics };
}
