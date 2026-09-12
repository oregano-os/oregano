import type { CapabilityBinding, CapabilityContract, JsonValue } from "../capabilities/contracts.ts";
import type { CompanyToolContract } from "../tool-sdk/contracts.ts";
import type { ResolvedToolSet } from "../toolset-resolver/resolver.ts";
import type { RosterMember } from "../state-store/roster.ts";
import type { AgentBinding, CompiledAgentRouting } from "../runtime/agent-resolver.ts";
import type { WorkspaceReleasePolicy } from "../runtime/release/contracts.ts";
import type { BuilderTestResource } from "../runtime/builder/functional-tests.ts";

export interface BuilderInstanceConfiguration {
  testInactivityDays?: number;
  testResources?: BuilderTestResource[];
  /** Deprecated compatibility input. Workspace presence declares intent. */
  enabled?: true;
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

export interface WorkflowInstanceBindings {
  /** Exact member-to-destination pairs; provider identity qualification is required before activation. */
  directRecipients: Array<{ bindingId: string; memberId: string; destinationBinding: string }>;
}

export interface InstanceBuildConfiguration {
  version: 1;
  instanceId: string;
  environment: string;
  bindings: CapabilityBinding[];
  connectors?: RuntimeConnectorConfiguration[];
  agentBindings: AgentBinding[];
  defaultAgentId?: string;
  workflowBindings?: WorkflowInstanceBindings;
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
  description?: string;
  modelTask?: string;
  conversationCoordinator?: boolean;
  materials: Record<string, string>;
  /** Builder-only existence inventory. Read scope still controls file content. */
  sourcePaths?: readonly string[];
  toolSet: ResolvedToolSet;
  tools: CompiledCompanyTool[];
}

export interface CompanyOSArtifact {
  builderReleasePolicy?: WorkspaceReleasePolicy;
  schemaVersion: 1;
  company: string;
  language?: string;
  instance: { id: string; environment: string };
  provenance: {
    instanceConfigurationDigest?: string;
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
  roster: RosterMember[];
  agents: CompiledAgent[];
  agentRouting: CompiledAgentRouting;
  workflows?: import("./workflow-types.ts").CompiledWorkflow[];
  workflowBindings?: WorkflowInstanceBindings;
  builder?: BuilderInstanceConfiguration;
  artifactHash: string;
}
