import type { CapabilityBinding, CapabilityContract, JsonValue } from "../capabilities/contracts.ts";
import type { CompanyToolContract } from "../tool-sdk/contracts.ts";
import type { ResolvedToolSet } from "../toolset-resolver/resolver.ts";
import type { RosterMember } from "../state-store/roster.ts";
import type { AgentBinding, CompiledAgentRouting } from "../runtime/agent-resolver.ts";

export interface BuilderInstanceConfiguration {
  enabled: true;
  execution: {
    adapter: string;
    profile: string;
  };
  codingAgent: {
    protocol: "acp-v1";
    profile: "claude-code" | "codex";
  };
  repository: {
    repositoryId: string;
    sourceBinding: string;
    proposalPublisherBinding: string;
    targetBranchName?: string;
  };
}

/**
 * One exact, non-secret Connector installation for a Company Instance.
 * Provider credentials are represented only by bounded SecretRefs inside the
 * configuration object and are resolved by the selected Runner.
 */
export interface RuntimeConnectorConfiguration {
  id: string;
  connector: string;
  connectorVersion: string;
  configuration: { [key: string]: JsonValue };
}

export interface InstanceBuildConfiguration {
  version: 1;
  instanceId: string;
  environment: string;
  bindings: CapabilityBinding[];
  connectors?: RuntimeConnectorConfiguration[];
  agentBindings: AgentBinding[];
  defaultAgentId?: string;
  builder?: BuilderInstanceConfiguration;
}

export interface CompiledCompanyTool {
  contract: CompanyToolContract;
  compiledSource: string;
  sourceDigest: string;
}

export interface CompiledAgent {
  id: string;
  instructions: string;
  materials: Record<string, string>;
  toolSet: ResolvedToolSet;
  tools: CompiledCompanyTool[];
}

export interface CompanyOSArtifact {
  schemaVersion: 1;
  company: string;
  instance: { id: string; environment: string };
  provenance: {
    coreVersion: string;
    coreCommit: string;
    workspaceVersion: string;
    workspaceCommit: string;
    workbenchVersion: string;
    workspaceHash: string;
    capabilityCatalogHash: string;
    resolvedToolSetHash: string;
    builtAt: string;
  };
  capabilityCatalog: CapabilityContract[];
  bindings: CapabilityBinding[];
  connectors?: RuntimeConnectorConfiguration[];
  knowledge?: {
    bundleSchemaVersion: 3;
    okfVersion: "0.1";
    bundleHash: string;
    policyHash: string;
    documentCount: number;
    fragmentCount: number;
  };
  roster: RosterMember[];
  agents: CompiledAgent[];
  agentRouting: CompiledAgentRouting;
  builder?: BuilderInstanceConfiguration;
  artifactHash: string;
}
