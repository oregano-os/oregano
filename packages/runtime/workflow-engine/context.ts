import type { WorkflowDispatchFence } from "../../state-store/interface.ts";
import type { JsonValue } from "../../capabilities/contracts.ts";
import type { RosterMember } from "../../state-store/roster.ts";
import type { WorkflowReviewDelivery, WorkflowStepState } from "../../state-store/workflow-engine.ts";

export interface WorkflowReferenceContext {
  steps: Record<string, JsonValue>;
  trigger: { id: string; instant: string; previous_instant?: string; params: Record<string, JsonValue> };
  instance: Record<string, string>;
  item?: JsonValue;
}

export interface WorkflowDecisionEvidence {
  stepId: string;
  status: "pending" | "approved" | "rejected";
  boundDigest: string;
  approvingPrincipal?: string;
  expiresAt: string;
  recipients?: string[];
}

/** Supplied only by the trusted host's persisted run/assignment reader. Never a Tool argument. */
export interface WorkflowInvocationContext extends WorkflowReferenceContext {
  mode: "engine" | "conversation" | "review";
  runId: string;
  workflowId: string;
  stepId: string;
  artifactHash: string;
  manifestHash: string;
  status: "running" | "waiting" | "cancelled" | "failed" | "done";
  subjectPrincipal: string;
  itemKey?: string | number;
  decisions: Record<string, WorkflowDecisionEvidence>;
  currentRoster: RosterMember[];
  dispatchFence?: WorkflowDispatchFence;
  reviewDelivery?: WorkflowReviewDelivery;
  publicationRecoveries?: WorkflowStepState["publicationRecoveries"];
}

export interface WorkflowContextReader {
  /** Resolves from a host-owned dispatch lease or authenticated conversation assignment. No model-selected keys. */
  read(): Promise<WorkflowInvocationContext | undefined>;
}

export interface WorkflowEvidence {
  workflow_id: string;
  workflow_version: string | number;
  manifest_hash: string;
  workspace_commit: string;
  artifact_hash: string;
  instance_id: string;
  run_id: string;
  step_id: string;
  item_key?: string | number;
  purpose?: "effect-review";
  reviewed_step_id?: string;
  review_page?: number;
}
