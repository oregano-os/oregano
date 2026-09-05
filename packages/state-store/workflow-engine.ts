import type { JsonValue } from "../capabilities/contracts.ts";
import type { CompanyOSArtifact } from "../companyos-builder/types.ts";
import type { RunMeta } from "./interface.ts";

export interface WorkflowStepState {
  status: "running" | "waiting" | "succeeded" | "failed";
  startedAt: string;
  completedAt?: string;
  inputDigest?: string;
  output?: JsonValue;
  /** Only actual completed item outputs, indexed by the canonical typed key digest. */
  items?: Record<string, { key: string | number; output: JsonValue }>;
  evidence?: JsonValue;
}
export interface WorkflowStoredDecision {
  stepId: string;
  role: string;
  status: "pending" | "approved" | "rejected" | "timed-out";
  bound: JsonValue;
  boundDigest: string;
  createdAt: string;
  expiresAt: string;
  approvingPrincipal?: string;
  responseEventId?: string;
  decidedAt?: string;
  /** Frozen exact recipients and retained provider receipts for decision delivery. */
  recipients: string[];
  deliveries: Record<string, JsonValue>;
}
export interface WorkflowMutableState {
  status: "running" | "waiting" | "done" | "cancelled" | "failed";
  cursor: string | null;
  logicalInstant: string;
  steps: Record<string, WorkflowStepState>;
  decisions: Record<string, WorkflowStoredDecision>;
  wait?: { stepId: string; kind: "step" | "delivery" | "decision"; timerId: string; dueAt: string };
  blocked?: { stepId: string; code: string; errorDigest: string };
}
export interface WorkflowRunIdentity {
  instanceId: string;
  runId: string;
  workflowId: string;
  artifactHash: string;
  manifestHash: string;
  /** Deduplicates the authenticated opening event independently of later Artifact changes. */
  originKey: string;
  originDigest: string;
  subjectPrincipal: string;
  trigger: { id: string; instant: string; previous_instant?: string; params: Record<string, JsonValue> };
  fields: Record<string, string>;
  createdAt: string;
}
export interface WorkflowRun extends WorkflowRunIdentity {
  revision: number;
  state: WorkflowMutableState;
  updatedAt: string;
  lease?: { owner: string; token: string; expiresAt: string };
}
export interface WorkflowConversation {
  surface: string;
  accountId: string;
  channelId: string;
  threadId: string;
  /** Present for a private decision delivery; absent for a shared workflow thread. */
  subjectPrincipal?: string;
}
export interface WorkflowAssignment extends WorkflowConversation {
  instanceId: string;
  assignmentKey: string;
  runId: string;
  stepId: string;
  artifactHash: string;
  expiresAt: string;
}
export interface WorkflowStateCommit {
  instanceId: string;
  runId: string;
  expectedRevision: number;
  leaseToken: string;
  now: string;
  state: WorkflowMutableState;
  event: { name: string; stepId: string; principal?: string; evidence?: JsonValue };
  assignments?: WorkflowAssignment[];
}
export interface WorkflowExecutionStore {
  putArtifact(artifact: CompanyOSArtifact): Promise<void>;
  getArtifact(hash: string): Promise<CompanyOSArtifact | undefined>;
  /** Creates control metadata and the execution record together; an opening event cannot select new inputs on redelivery. */
  create(args: { identity: WorkflowRunIdentity; state: WorkflowMutableState; meta: RunMeta }): Promise<WorkflowRun>;
  read(instanceId: string, runId: string): Promise<WorkflowRun | undefined>;
  findOrigin(instanceId: string, workflowId: string, originKey: string): Promise<WorkflowRun | undefined>;
  list(args: { instanceId: string; limit: number; status?: WorkflowMutableState["status"] }): Promise<WorkflowRun[]>;
  claim(args: { instanceId: string; runId: string; owner: string; token: string; now: string; expiresAt: string }): Promise<WorkflowRun | undefined>;
  /** Atomically advances state, records its event and binds delivered conversations; stale leases cannot commit. */
  commit(args: WorkflowStateCommit): Promise<WorkflowRun | undefined>;
  cancel(args: { instanceId: string; runId: string; principal: string; now: string }): Promise<boolean>;
  assignment(args: { instanceId: string; conversation: WorkflowConversation; now: string }): Promise<WorkflowAssignment | undefined>;
}
