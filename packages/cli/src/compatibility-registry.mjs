import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { valid } from "semver";
import YAML from "yaml";
import { diagnostic } from "./diagnostics.mjs";

export const COMPATIBILITY_REGISTRY_PATH = "docs/compatibility/registry.yaml";

const STABILITIES = new Set(["internal", "experimental", "stable", "deprecated"]);
const CONTRACT_ID = /^[a-z0-9][a-z0-9.-]*$/;

export function inspectCompatibilityRegistry(repoRoot, { documentIds } = {}) {
  const path = join(repoRoot, COMPATIBILITY_REGISTRY_PATH);
  const diagnostics = [];
  if (!existsSync(path)) {
    return {
      diagnostics: [diagnostic("CMPREG001", "error", "The Compatibility Registry is missing.", { file: COMPATIBILITY_REGISTRY_PATH })],
      registry: null,
      byKey: new Map(),
    };
  }

  let registry;
  try {
    registry = YAML.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      diagnostics: [diagnostic("CMPREG002", "error", `The Compatibility Registry cannot be parsed: ${error.message.split("\n")[0]}`, { file: COMPATIBILITY_REGISTRY_PATH })],
      registry: null,
      byKey: new Map(),
    };
  }

  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    diagnostics.push(diagnostic("CMPREG003", "error", "The Compatibility Registry root must be a mapping.", { file: COMPATIBILITY_REGISTRY_PATH }));
  }
  if (registry?.version !== 1) {
    diagnostics.push(diagnostic("CMPREG004", "error", "The Compatibility Registry must declare version: 1.", { file: COMPATIBILITY_REGISTRY_PATH }));
  }
  if (!registry?.updated) {
    diagnostics.push(diagnostic("CMPREG005", "error", "The Compatibility Registry must declare an updated date.", { file: COMPATIBILITY_REGISTRY_PATH }));
  }
  if (!Array.isArray(registry?.contracts)) {
    diagnostics.push(diagnostic("CMPREG006", "error", "The Compatibility Registry must contain a contracts list.", { file: COMPATIBILITY_REGISTRY_PATH }));
  }

  const companyosSpec = registry?.companyos_spec;
  if (!companyosSpec || typeof companyosSpec !== "object" || Array.isArray(companyosSpec)) {
    diagnostics.push(diagnostic("CMPREG017", "error", "The Compatibility Registry must declare companyos_spec as a mapping.", { file: COMPATIBILITY_REGISTRY_PATH }));
  } else {
    const current = String(companyosSpec.current ?? "");
    const supported = Array.isArray(companyosSpec.supported) ? companyosSpec.supported.map(String) : [];
    if (!valid(current)) diagnostics.push(diagnostic("CMPREG018", "error", "companyos_spec.current must be an exact semantic version.", { file: COMPATIBILITY_REGISTRY_PATH }));
    if (supported.length === 0 || supported.some((version) => !valid(version)) || new Set(supported).size !== supported.length) {
      diagnostics.push(diagnostic("CMPREG019", "error", "companyos_spec.supported must be a unique non-empty list of exact semantic versions.", { file: COMPATIBILITY_REGISTRY_PATH }));
    } else if (!supported.includes(current)) {
      diagnostics.push(diagnostic("CMPREG020", "error", "companyos_spec.supported must include companyos_spec.current.", { file: COMPATIBILITY_REGISTRY_PATH }));
    }
    if (typeof companyosSpec.specification !== "string" || !companyosSpec.specification) {
      diagnostics.push(diagnostic("CMPREG021", "error", "companyos_spec.specification must identify the normative current specification.", { file: COMPATIBILITY_REGISTRY_PATH }));
    } else if (documentIds && !documentIds.has(companyosSpec.specification)) {
      diagnostics.push(diagnostic("CMPREG022", "error", `companyos_spec references unknown specification '${companyosSpec.specification}'.`, { file: COMPATIBILITY_REGISTRY_PATH }));
    }
  }

  const byKey = new Map();
  for (const [index, contract] of (Array.isArray(registry?.contracts) ? registry.contracts : []).entries()) {
    const location = `${COMPATIBILITY_REGISTRY_PATH}#contracts[${index}]`;
    if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
      diagnostics.push(diagnostic("CMPREG007", "error", "Each compatibility entry must be a mapping.", { file: location }));
      continue;
    }
    for (const field of ["id", "version", "stability", "owner", "introduced", "specification", "implementation", "tests"]) {
      if (contract[field] === undefined || contract[field] === null || contract[field] === "") {
        diagnostics.push(diagnostic("CMPREG008", "error", `Compatibility entry is missing '${field}'.`, { file: location }));
      }
    }
    if (contract.id && !CONTRACT_ID.test(contract.id)) {
      diagnostics.push(diagnostic("CMPREG009", "error", `Invalid contract ID '${contract.id}'.`, { file: location }));
    }
    if (contract.stability && !STABILITIES.has(contract.stability)) {
      diagnostics.push(diagnostic("CMPREG010", "error", `Unknown stability '${contract.stability}'.`, { file: location }));
    }
    if (!Array.isArray(contract.tests) || contract.tests.length === 0 || contract.tests.some((test) => typeof test !== "string" || !test)) {
      diagnostics.push(diagnostic("CMPREG011", "error", "Compatibility entry tests must be a non-empty list of IDs.", { file: location }));
    }
    if (documentIds && contract.specification && !documentIds.has(contract.specification)) {
      diagnostics.push(diagnostic("CMPREG012", "error", `Compatibility entry references unknown specification '${contract.specification}'.`, { file: location }));
    }
    if (contract.stability === "deprecated") {
      if (!contract.deprecated || !contract.replacement || !contract.removal_gate) {
        diagnostics.push(diagnostic("CMPREG013", "error", "Deprecated contracts require deprecated, replacement, and removal_gate values.", { file: location }));
      }
    } else if (contract.deprecated !== null && contract.deprecated !== undefined) {
      diagnostics.push(diagnostic("CMPREG014", "error", "Only deprecated contracts may declare a deprecation date.", { file: location }));
    } else if (contract.replacement !== null && contract.replacement !== undefined) {
      diagnostics.push(diagnostic("CMPREG015", "error", "Only deprecated contracts may declare a replacement.", { file: location }));
    }

    if (contract.id && contract.version !== undefined && contract.version !== null) {
      const key = `${contract.id}@${String(contract.version)}`;
      if (byKey.has(key)) diagnostics.push(diagnostic("CMPREG016", "error", `Duplicate compatibility entry '${key}'.`, { file: location }));
      else byKey.set(key, contract);
    }
  }

  return { diagnostics, registry, byKey };
}
