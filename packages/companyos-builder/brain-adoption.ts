import YAML from "yaml";
import { sha256 } from "../runtime/canonical.ts";
import { parseBrainConfiguration } from "../brain/configuration.ts";
import type { BrainConfiguration } from "../brain/contracts.ts";

export interface WorkspaceRuntimePolicy {
  commonToolGrants: string[];
  digest: string;
  path: ".companyos/governance.yaml";
  brainReading?: "company-wide";
}
export interface BrainAdoption { configuration: BrainConfiguration; configurationDigest: string; readingPolicy: "company-wide"; policyDigest: string }

/** Bounded extension to existing governed Workspace authority, not Instance enablement. */
export function compileWorkspaceRuntimePolicy(files: Record<string, string>): WorkspaceRuntimePolicy | undefined {
  const policy = YAML.parse(files[".companyos/governance.yaml"] ?? "")?.runtime;
  if (policy === undefined) return undefined;
  if (!policy || typeof policy !== "object" || Array.isArray(policy) || Object.keys(policy).some(key => !["common_tool_grants", "brain_reading"].includes(key))) throw new Error("Invalid Workspace runtime governance policy.");
  const grants = policy.common_tool_grants ?? [];
  if (!Array.isArray(grants) || grants.length > 100 || new Set(grants).size !== grants.length
    || grants.some(grant => typeof grant !== "string" || !/^oregano:[a-z0-9_/-]+$/.test(grant))) throw new Error("Common Workspace Tool grants must be explicit unique standard Tool identifiers.");
  if (policy.brain_reading !== undefined && policy.brain_reading !== "company-wide") throw new Error("Only explicitly declared company-wide Brain content reading is supported.");
  return { commonToolGrants: grants, digest: sha256(policy), path: ".companyos/governance.yaml", ...(policy.brain_reading ? { brainReading: policy.brain_reading } : {}) };
}

export function compileBrainAdoption(files: Record<string, string>, policy: WorkspaceRuntimePolicy | undefined): BrainAdoption | undefined {
  const declaration = files[".companyos/brain.yaml"];
  if (declaration === undefined) {
    if (policy?.brainReading || policy?.commonToolGrants.some(grant => grant.startsWith("oregano:brain/"))) throw new Error("Brain adoption requires .companyos/brain.yaml.");
    return undefined;
  }
  if (policy?.brainReading !== "company-wide") throw new Error("Brain adoption requires explicit company-wide reading in Workspace governance.");
  const configuration = parseBrainConfiguration(declaration);
  return { configuration, configurationDigest: sha256(configuration), readingPolicy: policy.brainReading, policyDigest: policy.digest };
}
