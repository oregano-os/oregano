import type { CapabilityBinding, CapabilityContract, RiskLevel } from "../capabilities/contracts.ts";
import { maximumRisk } from "../capabilities/contracts.ts";
import { sha256 } from "../runtime/canonical.ts";
import type { CompanyToolContract } from "../tool-sdk/contracts.ts";

export interface ResolvedTool {
  grantId: string;
  runtimeId: string;
  version: string;
  risk: RiskLevel;
  capabilities: Array<{ id: string; version: string; connector: string; connectorVersion: string }>;
  contractDigest: string;
}

export interface ResolvedToolSet {
  resolverVersion: "1";
  agentId: string;
  tools: ResolvedTool[];
  hash: string;
}

export interface ResolveToolSetInput {
  agentId: string;
  grants: string[];
  companyTools: CompanyToolContract[];
  standardTools?: CompanyToolContract[];
  capabilityCatalog: readonly CapabilityContract[];
  allowedCapabilities: readonly string[];
  bindings: readonly CapabilityBinding[];
}

export function resolveToolSet(input: ResolveToolSetInput): ResolvedToolSet {
  const errors: string[] = [];
  const capabilityById = new Map(input.capabilityCatalog.map((contract) => [contract.id, contract]));
  const bindingByCapability = new Map<string, CapabilityBinding>();
  for (const binding of input.bindings) {
    if (bindingByCapability.has(binding.capability)) errors.push(`Duplicate Instance binding for '${binding.capability}'.`);
    bindingByCapability.set(binding.capability, binding);
  }
  const tools = [...input.companyTools, ...(input.standardTools ?? [])];
  const byGrant = new Map<string, CompanyToolContract[]>();
  for (const tool of tools) byGrant.set(tool.grantId, [...(byGrant.get(tool.grantId) ?? []), tool]);
  const seenGrants = new Set<string>();
  const resolved: ResolvedTool[] = [];

  for (const grant of [...input.grants].sort()) {
    if (seenGrants.has(grant)) {
      errors.push(`Duplicate Tool grant '${grant}' for agent '${input.agentId}'.`);
      continue;
    }
    seenGrants.add(grant);
    const candidates = (byGrant.get(grant) ?? []).filter((tool) => tool.agentId === input.agentId || grant.startsWith("oregano:"));
    if (candidates.length === 0) {
      errors.push(`Unknown Tool grant '${grant}' for agent '${input.agentId}'.`);
      continue;
    }
    if (candidates.length !== 1) {
      errors.push(`Ambiguous Tool grant '${grant}' for agent '${input.agentId}'.`);
      continue;
    }
    const tool = candidates[0];
    const capabilities: ResolvedTool["capabilities"] = [];
    let risk = tool.risk;
    for (const capabilityId of tool.capabilities) {
      const contract = capabilityById.get(capabilityId);
      if (!contract) {
        errors.push(`Tool '${tool.runtimeId}' requires unknown Capability '${capabilityId}'.`);
        continue;
      }
      if (!input.allowedCapabilities.includes(capabilityId)) {
        errors.push(`Workspace does not allow Capability '${capabilityId}' required by '${tool.runtimeId}'.`);
        continue;
      }
      const binding = bindingByCapability.get(capabilityId);
      if (!binding) {
        errors.push(`Instance does not bind Capability '${capabilityId}' required by '${tool.runtimeId}'.`);
        continue;
      }
      if (binding.contractVersion !== contract.version) {
        errors.push(`Capability '${capabilityId}' requires contract ${contract.version}, but binding declares ${binding.contractVersion}.`);
        continue;
      }
      risk = maximumRisk(risk, contract.minimumRisk);
      capabilities.push({
        id: contract.id,
        version: contract.version,
        connector: binding.connector,
        connectorVersion: binding.connectorVersion,
      });
    }
    resolved.push({
      grantId: grant,
      runtimeId: tool.runtimeId,
      version: tool.version,
      risk,
      capabilities: capabilities.sort((a, b) => a.id.localeCompare(b.id)),
      contractDigest: sha256(tool),
    });
  }
  if (errors.length > 0) throw new Error(`ToolSet resolution failed:\n- ${errors.join("\n- ")}`);
  const manifest = {
    resolverVersion: "1" as const,
    agentId: input.agentId,
    tools: resolved.sort((a, b) => a.runtimeId.localeCompare(b.runtimeId)),
  };
  return { ...manifest, hash: sha256(manifest) };
}
