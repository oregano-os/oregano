import type { CapabilityBinding, CapabilityContract, JsonValue } from "../capabilities/contracts.ts";
import type { CompanyToolContract } from "../tool-sdk/contracts.ts";
import type { ResolvedToolSet } from "../toolset-resolver/resolver.ts";
import type { RosterMember } from "../state-store/roster.ts";
import type { AgentBinding, CompiledAgentRouting } from "../runtime/agent-resolver.ts";
import type { BusinessCalendar } from "../domains/sprint/business-time.ts";
import type { SprintDomainDeclaration, Weekday } from "../domains/sprint/contracts.ts";

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

export interface SprintRuntimeInstanceConfiguration {
  definitionId: string;
  agentId: string;
  servicePrincipal: string;
  participantIdentityPrefix: string;
  directDestinations: Record<string, string>;
  workItem?: {
    resourceBinding: string;
    rolloverField: string;
  };
}

export interface InstanceBuildConfiguration {
  version: 1;
  instanceId: string;
  environment: string;
  bindings: CapabilityBinding[];
  connectors?: RuntimeConnectorConfiguration[];
  agentBindings: AgentBinding[];
  defaultAgentId?: string;
  sprintRuntimes?: SprintRuntimeInstanceConfiguration[];
  builder?: BuilderInstanceConfiguration;
}

export interface CompiledSprintTemplate {
  path: string;
  content: string;
  digest: string;
}

export interface CompiledSprintScheduleManifest {
  schemaVersion: 1;
  id: string;
  sourcePath: string;
  activation: "blocked" | "active";
  timeZone: string;
  businessDays: Weekday[];
  holidaysByYear: Record<string, string[]>;
  missingYearPolicy: "assume-no-holidays" | "block";
  deliveryWindow: { opensAt: string; closesAt: string };
  triggers: Array<{
    id: string;
    weekdays: Weekday[];
    at: string;
    holidayShift?: "previous-business-day" | "next-business-day" | "none";
  }>;
  sourceDigest: string;
  provenance: {
    instanceId: string;
    coreCommit: string;
    workspaceCommit: string;
    workbenchVersion: string;
  };
}

export interface CompiledSprintRuntime {
  definitionId: string;
  agentId: string;
  servicePrincipal: string;
  participantIdentityPrefix: string;
  policy: SprintDomainDeclaration;
  calendar: BusinessCalendar;
  schedule: CompiledSprintScheduleManifest;
  templates: {
    reminder: CompiledSprintTemplate;
    chase: CompiledSprintTemplate;
    closeReport: CompiledSprintTemplate;
    retro: CompiledSprintTemplate;
  };
  directDestinations: Record<string, string>;
  directAssignments: Record<string, {
    fromAgentId: string;
    purpose: string;
  }>;
  workItem?: {
    resourceBinding: string;
    rolloverField: string;
  };
  modelTask: string;
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
  sprints?: CompiledSprintRuntime[];
  builder?: BuilderInstanceConfiguration;
  artifactHash: string;
}
