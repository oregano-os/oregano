import type { ReleaseCandidate, MergeReceipt, ProductionArtifactReceipt, DeploymentReceipt, ProductionVerification } from "../runtime/release/contracts.ts";

export type ReleaseStage = "approved" | "merging" | "merged" | "building" | "built" | "migrating" | "migrated" | "deploying" | "deployed" | "verifying" | "live" | "failed" | "rolling-back" | "rolled-back";
export interface ReleaseRun {
  readonly id: string;
  readonly candidate: ReleaseCandidate;
  readonly candidateDigest: string;
  readonly acceptedBy: string;
  readonly acceptedAt: string;
  readonly stage: ReleaseStage;
  readonly revision: number;
  readonly updatedAt: string;
  readonly merge?: MergeReceipt;
  readonly artifact?: ProductionArtifactReceipt;
  readonly migrationDigest?: string;
  readonly deployment?: DeploymentReceipt;
  readonly verification?: ProductionVerification;
  readonly failure?: string;
  readonly rollbackBy?: string;
  readonly notificationDelivered?: boolean;
}
export interface ReleaseLease {
  readonly run: ReleaseRun;
  readonly token: string;
  readonly expiresAt: string;
}
/** CAS and one per-Instance execution lease are enforced by the storage adapter. */
export interface ReleaseRunStore {
  create(run: ReleaseRun): Promise<ReleaseRun>;
  get(id: string): Promise<ReleaseRun | undefined>;
  claim(instanceId: string, workerId: string, now: string, leaseMs: number): Promise<ReleaseLease | undefined>;
  save(lease: ReleaseLease, run: ReleaseRun, now: string): Promise<ReleaseLease>;
  release(lease: ReleaseLease): Promise<void>;
  requestRollback(id: string, actor: string, expectedRevision: number, now: string): Promise<ReleaseRun>;
}
export function releaseIsTerminal(run: ReleaseRun): boolean {
  return ["live", "failed", "rolled-back"].includes(run.stage);
}
