import { readFileSync } from "node:fs";
import YAML from "yaml";
import type { InstanceBuildConfiguration } from "./types.ts";
import { scanCredentialIndicators } from "../security/credential-scanner.ts";

export function loadInstanceBuildConfiguration(path: string): InstanceBuildConfiguration {
  const raw = readFileSync(path, "utf8");
  if (/\b(?:token|password|secret|private_key)\s*:/i.test(raw)) {
    throw new Error(`${path}: Instance build declarations contain SecretRefs and bindings, never resolved secret values.`);
  }
  const credentialIndicators = scanCredentialIndicators(raw);
  if (credentialIndicators.length > 0) {
    throw new Error(`${path}: possible ${credentialIndicators[0].label} detected; Instance build declarations never contain resolved credentials.`);
  }
  const data = YAML.parse(raw);
  if (data?.version !== 1) throw new Error(`${path}: version must be 1.`);
  if (typeof data.instance_id !== "string" || !data.instance_id) throw new Error(`${path}: instance_id is required.`);
  if (typeof data.environment !== "string" || !data.environment) throw new Error(`${path}: environment is required.`);
  if (!Array.isArray(data.bindings)) throw new Error(`${path}: bindings must be a list.`);
  return {
    version: 1,
    instanceId: data.instance_id,
    environment: data.environment,
    bindings: data.bindings.map((binding: any, index: number) => {
      for (const key of ["capability", "contract_version", "connector", "connector_version"]) {
        if (typeof binding?.[key] !== "string" || !binding[key]) throw new Error(`${path}: bindings[${index}].${key} is required.`);
      }
      return {
        capability: binding.capability,
        contractVersion: binding.contract_version,
        connector: binding.connector,
        connectorVersion: binding.connector_version,
      };
    }),
  };
}
