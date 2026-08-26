import { readFileSync } from "node:fs";
import YAML from "yaml";
import type { InstanceBuildConfiguration } from "./types.ts";
import { scanCredentialIndicators } from "../security/credential-scanner.ts";
import type { AgentBinding } from "../runtime/agent-resolver.ts";
import type { BuilderInstanceConfiguration } from "./types.ts";

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
  const agentBindings = parseAgentBindings(data.agent_bindings, path);
  const defaultAgentId = optionalIdentifier(data.default_agent, `${path}: default_agent`);
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
    agentBindings,
    defaultAgentId,
    builder,
  };
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
    },
  };
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
