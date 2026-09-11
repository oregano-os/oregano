import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import YAML from "yaml";
import { parseBuilderTestResources } from "../runtime/builder/functional-tests.ts";
import type { WorkflowInstanceBindings, InstanceBuildConfiguration } from "./types.ts";
import { scanCredentialIndicators } from "../security/credential-scanner.ts";
import type { AgentBinding } from "../runtime/agent-resolver.ts";
import type { JsonValue } from "../capabilities/contracts.ts";
import type { BuilderInstanceConfiguration, RuntimeConnectorConfiguration } from "./types.ts";

export const WORKSPACE_INSTANCE_PATH = ".companyos/instance.yaml";

/** Resolve the sole reviewed Instance declaration from the Company Workspace. */
export function resolveWorkspaceInstanceConfiguration(workspaceRoot: string): {
  path: string; configuration: InstanceBuildConfiguration;
} {
  const path = join(resolve(workspaceRoot), WORKSPACE_INSTANCE_PATH);
  if (!existsSync(path)) throw new Error(`Instance declaration is missing at ${path}. Prepare and commit ${WORKSPACE_INSTANCE_PATH} before building.`);
  const root = realpathSync(workspaceRoot);
  if (!lstatSync(path).isFile()
    || lstatSync(join(workspaceRoot, ".companyos")).isSymbolicLink()
    || !realpathSync(path).startsWith(`${root}${sep}`)) {
    throw new Error(`${WORKSPACE_INSTANCE_PATH} must resolve inside the Company Workspace as a regular file, without symbolic links.`);
  }
  return { path, configuration: loadInstanceBuildConfiguration(path) };
}

export function loadInstanceBuildConfiguration(path: string): InstanceBuildConfiguration {
  return parseInstanceBuildConfiguration(readFileSync(path, "utf8"), path);
}

export function parseInstanceBuildConfiguration(raw: string, path = "Instance binding"): InstanceBuildConfiguration {
  if (/\b(?:token|password|secret|private_key)\s*:/i.test(raw)) {
    throw new Error(`${path}: Instance build declarations contain SecretRefs and bindings, never resolved secret values.`);
  }
  const credentialIndicators = scanCredentialIndicators(raw);
  if (credentialIndicators.length > 0) {
    throw new Error(`${path}: possible ${credentialIndicators[0].label} detected; Instance build declarations never contain resolved credentials.`);
  }
  const data = YAML.parse(raw);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${path}: Instance declaration must be an object.`);
  const allowed = ["version", "instance_id", "environment", "bindings", "connectors", "agent_bindings", "default_agent", "sprint_runtimes", "workflow_bindings", "builder"];
  const extra = Object.keys(data).find((key) => !allowed.includes(key));
  if (extra) throw new Error(`${path}: unsupported Instance field '${extra}'.`);
  if (data?.version !== 1) throw new Error(`${path}: version must be 1.`);
  if (typeof data.instance_id !== "string" || !data.instance_id) throw new Error(`${path}: instance_id is required.`);
  if (typeof data.environment !== "string" || !data.environment) throw new Error(`${path}: environment is required.`);
  if (!Array.isArray(data.bindings)) throw new Error(`${path}: bindings must be a list.`);
  const connectors = parseConnectors(data.connectors, path);
  const agentBindings = parseAgentBindings(data.agent_bindings, path);
  const defaultAgentId = optionalIdentifier(data.default_agent, `${path}: default_agent`);
  if (Object.hasOwn(data, "sprint_runtimes")) throw new Error(`${path}: sprint_runtimes is retired; migrate to declared workflows and workflow_bindings.`);
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
    ...(data.workflow_bindings === undefined ? {} : { workflowBindings: parseWorkflowBindings(data.workflow_bindings) }),
    builder,
  };
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
  if (builder.test_inactivity_days !== undefined && (!Number.isInteger(builder.test_inactivity_days) || builder.test_inactivity_days < 1 || builder.test_inactivity_days > 90)) throw new Error(`${path}: builder.test_inactivity_days must be between 1 and 90.`);
  if (builder.enabled !== undefined && builder.enabled !== true) throw new Error(`${path}: builder.enabled is obsolete; declare or remove the Builder in the Workspace instead.`);
  if (builder.coding_agent?.protocol !== "acp-v1") {
    throw new Error(`${path}: builder.coding_agent.protocol must be 'acp-v1'.`);
  }
  if (builder.coding_agent?.profile !== "claude-code" && builder.coding_agent?.profile !== "codex") {
    throw new Error(`${path}: builder.coding_agent.profile must be 'claude-code' or 'codex'.`);
  }
  return {
    ...(builder.test_inactivity_days !== undefined ? { testInactivityDays: builder.test_inactivity_days } : {}),
    enabled: true,
    ...(builder.test_resources === undefined ? {} : { testResources: parseBuilderTestResources(builder.test_resources) }),
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


function parseWorkflowBindings(value: unknown): WorkflowInstanceBindings {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "direct_recipients")) throw new Error("workflow_bindings must contain only direct_recipients");
  const entries = (value as Record<string, unknown>).direct_recipients;
  if (!Array.isArray(entries)) throw new Error("workflow_bindings.direct_recipients must be a list");
  const binding = { directRecipients: entries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).some((key) => !["binding", "member_id", "destination_binding"].includes(key))) throw new Error("Unsupported workflow direct recipient field");
    return { bindingId: entry.binding, memberId: entry.member_id, destinationBinding: entry.destination_binding };
  }) };
  validateWorkflowInstanceBindings(binding);
  return binding;
}

export function validateWorkflowInstanceBindings(value: WorkflowInstanceBindings): void {
  if (!value || typeof value !== "object" || Object.keys(value).some((key) => key !== "directRecipients") || !Array.isArray(value.directRecipients) || value.directRecipients.length > 10000) throw new Error("Invalid workflow Instance bindings");
  const seen = new Set<string>(); const destinations = new Map<string, string>();
  for (const entry of value.directRecipients) {
    if (!entry || typeof entry !== "object" || Object.keys(entry).sort().join(",") !== "bindingId,destinationBinding,memberId"
      || typeof entry.bindingId !== "string" || typeof entry.memberId !== "string" || typeof entry.destinationBinding !== "string"
      || !/^[a-z][a-z0-9-]{0,62}$/.test(entry.bindingId) || !/^[a-z][a-z0-9-]{0,62}$/.test(entry.destinationBinding)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.memberId)) throw new Error("Workflow direct recipients require exact binding and member IDs");
    const key = JSON.stringify([entry.bindingId, entry.memberId]);
    if (seen.has(key)) throw new Error("Duplicate workflow recipient binding");
    if (destinations.has(entry.destinationBinding) && destinations.get(entry.destinationBinding) !== entry.memberId) throw new Error("One direct destination cannot represent different members");
    seen.add(key); destinations.set(entry.destinationBinding, entry.memberId);
  }
}
