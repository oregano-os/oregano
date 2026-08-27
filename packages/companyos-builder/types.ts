import type { CapabilityBinding, CapabilityContract } from "../capabilities/contracts.ts";
import type { CompanyToolContract } from "../tool-sdk/contracts.ts";
import type { ResolvedToolSet } from "../toolset-resolver/resolver.ts";
import type { RosterMember } from "../state-store/roster.ts";

export interface InstanceBuildConfiguration {
  version: 1;
  instanceId: string;
  environment: string;
  bindings: CapabilityBinding[];
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
  artifactHash: string;
}
