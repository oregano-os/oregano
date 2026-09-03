import { readFileSync } from "node:fs";
import YAML from "yaml";
import type { InstanceBuildConfiguration } from "./types.ts";
import { scanCredentialIndicators } from "../security/credential-scanner.ts";
import type { AgentBinding } from "../runtime/agent-resolver.ts";
import type { JsonValue } from "../capabilities/contracts.ts";
import type { BuilderInstanceConfiguration, RuntimeConnectorConfiguration } from "./types.ts";
import type { SprintRuntimeInstanceConfiguration } from "./types.ts";

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
  const connectors = parseConnectors(data.connectors, path);
  const agentBindings = parseAgentBindings(data.agent_bindings, path);
  const defaultAgentId = optionalIdentifier(data.default_agent, `${path}: default_agent`);
  const sprintRuntimes = parseSprintRuntimes(data.sprint_runtimes, path);
  const builder = parseBuilder(data.builder, path);
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
    connectors,
    agentBindings,
    defaultAgentId,
    sprintRuntimes,
    builder,
  };
}

function parseSprintRuntimes(value: unknown, path: string): SprintRuntimeInstanceConfiguration[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path}: sprint_runtimes must be a list.`);
  const definitions = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${path}: sprint_runtimes[${index}] must be an object.`);
    }
    const runtime = entry as Record<string, unknown>;
    const allowed = ["definition", "agent", "service_principal", "participant_identity_prefix", "direct_destinations", "work_item"];
    const extra = Object.keys(runtime).find((key) => !allowed.includes(key));
    if (extra) throw new Error(`${path}: sprint_runtimes[${index}] contains unsupported field '${extra}'.`);
    const definitionId = requiredIdentifier(runtime.definition, `${path}: sprint_runtimes[${index}].definition`);
    if (definitions.has(definitionId)) throw new Error(`${path}: duplicate Sprint runtime definition '${definitionId}'.`);
    definitions.add(definitionId);
    const directDestinations: Record<string, string> = {};
    if (runtime.direct_destinations !== undefined) {
      if (!runtime.direct_destinations || typeof runtime.direct_destinations !== "object" || Array.isArray(runtime.direct_destinations)) {
        throw new Error(`${path}: sprint_runtimes[${index}].direct_destinations must be an object.`);
      }
      for (const [principal, binding] of Object.entries(runtime.direct_destinations)) {
        if (!/^[a-z][a-z0-9._-]{0,31}:[A-Za-z0-9._-]{1,128}:[A-Za-z0-9._-]{1,128}$/.test(principal)) {
          throw new Error(`${path}: sprint_runtimes[${index}] contains an invalid direct-message principal.`);
        }
        directDestinations[principal] = requiredIdentifier(binding, `${path}: sprint_runtimes[${index}].direct_destinations.${principal}`);
      }
    }
    let workItem: SprintRuntimeInstanceConfiguration["workItem"];
    if (runtime.work_item !== undefined) {
      if (!runtime.work_item || typeof runtime.work_item !== "object" || Array.isArray(runtime.work_item)) {
        throw new Error(`${path}: sprint_runtimes[${index}].work_item must be an object.`);
      }
      const candidate = runtime.work_item as Record<string, unknown>;
      const extraWorkItem = Object.keys(candidate).find((key) => !["resource_binding", "rollover_field"].includes(key));
      if (extraWorkItem) throw new Error(`${path}: sprint_runtimes[${index}].work_item contains unsupported field '${extraWorkItem}'.`);
      workItem = {
        resourceBinding: requiredIdentifier(candidate.resource_binding, `${path}: sprint_runtimes[${index}].work_item.resource_binding`),
        rolloverField: requiredIdentifier(candidate.rollover_field, `${path}: sprint_runtimes[${index}].work_item.rollover_field`),
      };
    }
    return {
      definitionId,
      agentId: requiredIdentifier(runtime.agent, `${path}: sprint_runtimes[${index}].agent`),
      servicePrincipal: requiredPrincipal(runtime.service_principal, `${path}: sprint_runtimes[${index}].service_principal`),
      participantIdentityPrefix: requiredPrincipalPrefix(runtime.participant_identity_prefix, `${path}: sprint_runtimes[${index}].participant_identity_prefix`),
      directDestinations,
      ...(workItem ? { workItem } : {}),
    };
  });
}

function requiredPrincipalPrefix(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9._-]{0,31}:[A-Za-z0-9._-]{1,128}:$/.test(value)) {
    throw new Error(`${label} must be a canonical surface:account: principal prefix.`);
  }
  return value;
}

function parseConnectors(value: unknown, path: string): RuntimeConnectorConfiguration[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path}: connectors must be a list.`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${path}: connectors[${index}] must be an object.`);
    }
    const candidate = entry as Record<string, unknown>;
    const keys = Object.keys(candidate);
    if (keys.some((key) => !["id", "connector", "connector_version", "configuration"].includes(key))) {
      throw new Error(`${path}: connectors[${index}] contains unsupported fields.`);
    }
    const id = requiredIdentifier(candidate.id, `${path}: connectors[${index}].id`);
    if (seen.has(id)) throw new Error(`${path}: duplicate Connector instance id '${id}'.`);
    seen.add(id);
    const configuration = candidate.configuration;
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
      throw new Error(`${path}: connectors[${index}].configuration must be an object.`);
    }
    assertJsonValue(configuration, `${path}: connectors[${index}].configuration`);
    return {
      id,
      connector: requiredIdentifier(candidate.connector, `${path}: connectors[${index}].connector`),
      connectorVersion: requiredIdentifier(candidate.connector_version, `${path}: connectors[${index}].connector_version`),
      configuration: structuredClone(configuration) as Record<string, JsonValue>,
    };
  });
}

function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJsonValue(child, `${label}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(key)) throw new Error(`${label} has invalid key '${key}'.`);
      assertJsonValue(child, `${label}.${key}`);
    }
    return;
  }
  throw new Error(`${label} must contain only JSON values.`);
}

function parseAgentBindings(value: unknown, path: string): AgentBinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path}: agent_bindings must be a list.`);
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${path}: agent_bindings[${index}] must be an object.`);
    }
    const binding = entry as Record<string, unknown>;
    return {
      id: requiredIdentifier(binding.id, `${path}: agent_bindings[${index}].id`),
      agentId: requiredIdentifier(binding.agent, `${path}: agent_bindings[${index}].agent`),
      surface: requiredIdentifier(binding.surface, `${path}: agent_bindings[${index}].surface`),
      accountId: requiredIdentifier(binding.account_id, `${path}: agent_bindings[${index}].account_id`),
      channelId: requiredIdentifier(binding.channel_id, `${path}: agent_bindings[${index}].channel_id`),
    };
  });
}

function parseBuilder(value: unknown, path: string): BuilderInstanceConfiguration | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: builder must be an object.`);
  }
  const builder = value as Record<string, any>;
  if (builder.enabled !== true) throw new Error(`${path}: builder.enabled must be true when declared.`);
  if (builder.coding_agent?.protocol !== "acp-v1") {
    throw new Error(`${path}: builder.coding_agent.protocol must be 'acp-v1'.`);
  }
  if (builder.coding_agent?.profile !== "claude-code" && builder.coding_agent?.profile !== "codex") {
    throw new Error(`${path}: builder.coding_agent.profile must be 'claude-code' or 'codex'.`);
  }
  return {
    enabled: true,
    execution: {
      adapter: requiredIdentifier(builder.execution?.adapter, `${path}: builder.execution.adapter`),
      profile: requiredIdentifier(builder.execution?.profile, `${path}: builder.execution.profile`),
    },
    codingAgent: {
      protocol: "acp-v1",
      profile: builder.coding_agent.profile,
    },
    repository: {
      repositoryId: requiredIdentifier(
        builder.repository?.repository_id,
        `${path}: builder.repository.repository_id`,
      ),
      sourceBinding: requiredIdentifier(builder.repository?.source_binding, `${path}: builder.repository.source_binding`),
      proposalPublisherBinding: requiredIdentifier(
        builder.repository?.proposal_publisher_binding,
        `${path}: builder.repository.proposal_publisher_binding`,
      ),
      targetBranchName: optionalBranchName(
        builder.repository?.target_branch,
        `${path}: builder.repository.target_branch`,
      ),
    },
  };
}

function optionalBranchName(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value)
    || value.includes("..")
    || value.includes("//")
    || value.endsWith("/")
    || value.split("/").some((segment) => segment.startsWith(".") || segment.endsWith(".lock"))
  ) {
    throw new Error(`${label} must be a bounded safe branch name.`);
  }
  return value;
}

function requiredIdentifier(value: unknown, label: string): string {
  const identifier = optionalIdentifier(value, label);
  if (!identifier) throw new Error(`${label} is required.`);
  return identifier;
}

function optionalIdentifier(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a bounded identifier.`);
  }
  return value;
}

function requiredPrincipal(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9._-]{0,31}:[A-Za-z0-9._-]{1,128}:[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new Error(`${label} must be a canonical surface:account:subject principal.`);
  }
  return value;
}
