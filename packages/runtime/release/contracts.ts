import type { RosterMember } from "../../state-store/roster.ts";

export type ChangeClass = "content" | "behavior" | "security";
export interface ReleaseSelector {
  readonly members: readonly string[];
  readonly groups: readonly string[];
}
export interface WorkspaceReleasePolicy {
  readonly version: 1;
  readonly acceptance: Readonly<Record<ChangeClass, {
    readonly mode: "requester" | "steward";
    readonly eligible: ReleaseSelector;
    readonly independent: boolean;
  }>>;
  readonly deployers: ReleaseSelector;
}
export interface ReleaseCandidate {
  readonly version: 1;
  readonly id: string;
  readonly instanceId: string;
  readonly repositoryId: string;
  readonly targetBranch: string;
  readonly baseCommit: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly coreCommit: string;
  readonly configurationDigest: string;
  readonly policyDigest: string;
  readonly diffDigest: string;
  readonly changeClass: ChangeClass;
  readonly requester: string;
  readonly sourceConversation: string;
  readonly sourceMessageId?: string;
  readonly requiredChecks: readonly string[];
  readonly checksDigest: string;
  readonly previousArtifactHash: string;
  readonly migration?: { readonly id: string; readonly digest: string; readonly reversible: boolean };
}
export interface ReleaseAuthorization {
  readonly roster: readonly RosterMember[];
  readonly policy: WorkspaceReleasePolicy;
  /** Digest of the current accepted policy and membership, never the proposed policy. */
  readonly policyDigest: string;
}
export interface RepositoryCandidateInspection {
  readonly repositoryId: string;
  readonly targetBranch: string;
  readonly currentBase: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly diffDigest: string;
  readonly changeClass: ChangeClass;
  readonly checksDigest: string;
  readonly checks: readonly { readonly id: string; readonly status: "passed" | "pending" | "failed" }[];
  readonly protectionEnforced: boolean;
}
export type ReleaseOperation<T> = { readonly state: "pending" } | { readonly state: "succeeded"; readonly receipt: T };
export interface MergeReceipt {
  readonly repositoryId: string;
  readonly targetBranch: string;
  readonly candidateCommit: string;
  readonly baseCommit: string;
  readonly mergedCommit: string;
  readonly mergedTree: string;
}
export interface ProductionArtifactReceipt {
  readonly artifactHash: string;
  readonly instanceId: string;
  readonly environment: "production";
  readonly coreCommit: string;
  readonly workspaceCommit: string;
  readonly configurationDigest: string;
}
export interface DeploymentReceipt extends ProductionArtifactReceipt {
  readonly deploymentId: string;
}
export interface ProductionVerification extends DeploymentReceipt {
  readonly ready: boolean;
  readonly migrationDigest?: string;
}
export interface ReleaseExecutionContext {
  readonly operationId: string;
  readonly candidate: ReleaseCandidate;
}
/**
 * Trusted provider boundary. Mutating methods MUST reconcile/reuse operationId,
 * including after an ambiguous timeout. They must never treat retry as another
 * merge, migration, deployment or rollback. Provider keys stay behind this port.
 */
export interface ReleaseExecutionAdapter {
  readonly id: string;
  authorization(instanceId: string): Promise<ReleaseAuthorization>;
  inspect(candidate: ReleaseCandidate): Promise<RepositoryCandidateInspection>;
  currentProduction(instanceId: string): Promise<ProductionVerification>;
  merge(context: ReleaseExecutionContext): Promise<ReleaseOperation<MergeReceipt>>;
  build(context: ReleaseExecutionContext & { readonly merge: MergeReceipt }): Promise<ReleaseOperation<ProductionArtifactReceipt>>;
  migrate?(context: ReleaseExecutionContext & { readonly artifact: ProductionArtifactReceipt }): Promise<ReleaseOperation<{ readonly digest: string }>>;
  deploy(context: ReleaseExecutionContext & { readonly artifact: ProductionArtifactReceipt; readonly previousArtifactHash: string }): Promise<ReleaseOperation<DeploymentReceipt>>;
  verify(context: ReleaseExecutionContext & { readonly deployment: DeploymentReceipt }): Promise<ReleaseOperation<ProductionVerification>>;
  rollback?(context: ReleaseExecutionContext & { readonly deployment: DeploymentReceipt; readonly previousArtifactHash: string }): Promise<ReleaseOperation<ProductionVerification>>;
}
