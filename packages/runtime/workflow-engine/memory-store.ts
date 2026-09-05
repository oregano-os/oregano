import type { CompanyOSArtifact } from "../../companyos-builder/types.ts";
import type { WorkflowDispatchFence } from "../../state-store/interface.ts";
import type { WorkflowAssignment, WorkflowExecutionStore, WorkflowRun, WorkflowStateCommit } from "../../state-store/workflow-engine.ts";
import { canonicalJson, sha256 } from "../canonical.ts";
import { InMemoryStateStore } from "../memory-state.ts";
import { assertWorkflowArtifact } from "./guard.ts";
import { validateWorkflowAssignment, validateWorkflowCreation, validateWorkflowLease, validateWorkflowState, workflowAssignmentKey, workflowInstant } from "./state-validation.ts";

const key = (instance: string, id: string): string => canonicalJson([instance, id]);
const active = (run: WorkflowRun): boolean => run.state.status === "running" || run.state.status === "waiting";

/** Memory model of the same atomic boundaries as the maintained Postgres store. */
export class InMemoryWorkflowExecutionStore implements WorkflowExecutionStore {
  readonly control = new InMemoryStateStore();
  readonly #artifacts = new Map<string, CompanyOSArtifact>();
  readonly #runs = new Map<string, WorkflowRun>();
  readonly #assignments = new Map<string, WorkflowAssignment>();

  constructor() {
    this.control.workflowFence = (fence: WorkflowDispatchFence) => {
      const run = this.#runs.get(key(fence.instanceId, fence.runId));
      return !!run && run.state.status === "running" && !run.state.blocked && run.state.cursor === fence.stepId
        && run.lease?.token === fence.leaseToken && Date.parse(run.lease.expiresAt) > Math.max(Date.parse(fence.now), Date.now());
    };
  }

  async putArtifact(artifact: CompanyOSArtifact): Promise<void> {
    assertWorkflowArtifact(artifact);
    if (!this.#artifacts.has(artifact.artifactHash)) this.#artifacts.set(artifact.artifactHash, structuredClone(artifact));
  }
  async getArtifact(hash: string): Promise<CompanyOSArtifact | undefined> {
    const artifact = this.#artifacts.get(hash);
    if (artifact) assertWorkflowArtifact(artifact);
    return artifact && structuredClone(artifact);
  }
  async create(args: Parameters<WorkflowExecutionStore["create"]>[0]): Promise<WorkflowRun> {
    const artifact = this.#artifacts.get(args.identity.artifactHash);
    if (!artifact) throw new Error("Workflow historical Artifact is unavailable");
    validateWorkflowCreation(args.identity, args.state, args.meta, artifact);
    const existing = [...this.#runs.values()].find((run) => run.instanceId === args.identity.instanceId && run.workflowId === args.identity.workflowId && run.originKey === args.identity.originKey)
      ?? this.#runs.get(key(args.identity.instanceId, args.identity.runId));
    if (existing) {
      if (existing.originDigest !== args.identity.originDigest || existing.originKey !== args.identity.originKey) throw new Error("Workflow opening identity conflicts with changed input");
      return structuredClone(existing);
    }
    const prior = this.control.runs.get(args.meta.runId);
    if (prior && Object.entries(args.meta).some(([name, value]) => prior[name] !== value)) throw new Error("Workflow run conflicts with existing control metadata");
    const run: WorkflowRun = { ...structuredClone(args.identity), revision: 0, state: structuredClone(args.state), updatedAt: args.identity.createdAt };
    this.control.runs.set(args.meta.runId, { ...args.meta, status: args.state.status });
    this.#runs.set(key(run.instanceId, run.runId), run);
    this.control.appendEventSync({ runId: run.runId, stepId: run.state.cursor!, actor: "agent", subjectPrincipal: run.subjectPrincipal, event: "workflow.opened", status: "succeeded", payload: { artifact_hash: run.artifactHash, manifest_hash: run.manifestHash, origin_digest: run.originDigest } });
    return structuredClone(run);
  }
  async read(instanceId: string, runId: string): Promise<WorkflowRun | undefined> {
    const run = this.#runs.get(key(instanceId, runId));
    return run && structuredClone(run);
  }
  async findOrigin(instanceId: string, workflowId: string, originKey: string): Promise<WorkflowRun | undefined> {
    const run = [...this.#runs.values()].find((run) => run.instanceId === instanceId && run.workflowId === workflowId && run.originKey === originKey);
    return run && structuredClone(run);
  }
  async list(args: Parameters<WorkflowExecutionStore["list"]>[0]): Promise<WorkflowRun[]> {
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200) throw new Error("Workflow listing limit must be from 1 to 200");
    return [...this.#runs.values()].filter((run) => run.instanceId === args.instanceId && (!args.status || run.state.status === args.status))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.runId.localeCompare(b.runId)).slice(0, args.limit).map((run) => structuredClone(run));
  }
  async claim(args: Parameters<WorkflowExecutionStore["claim"]>[0]): Promise<WorkflowRun | undefined> {
    validateWorkflowLease(args);
    const run = this.#runs.get(key(args.instanceId, args.runId));
    if (!run || !active(run) || (run.lease && run.lease.expiresAt > args.now)) return undefined;
    run.lease = { owner: args.owner, token: args.token, expiresAt: args.expiresAt };
    return structuredClone(run);
  }
  async commit(args: WorkflowStateCommit): Promise<WorkflowRun | undefined> {
    workflowInstant(args.now);
    const run = this.#runs.get(key(args.instanceId, args.runId));
    if (!run || !active(run) || run.revision !== args.expectedRevision || run.lease?.token !== args.leaseToken || Date.parse(run.lease.expiresAt) <= Math.max(Date.parse(args.now), Date.now())) return undefined;
    const artifact = this.#artifacts.get(run.artifactHash);
    if (!artifact) throw new Error("Workflow historical Artifact is unavailable");
    validateWorkflowState(args.state, run.workflowId, artifact, run.state);
    for (const assignment of args.assignments ?? []) {
      validateWorkflowAssignment(assignment, run, artifact, args.now);
      const previous = this.#assignments.get(key(run.instanceId, assignment.assignmentKey));
      if (previous && canonicalJson(previous) !== canonicalJson(assignment)) throw new Error("Workflow conversation is already bound to another assignment");
    }
    run.state = structuredClone(args.state); run.revision++; run.updatedAt = args.now; delete run.lease;
    for (const assignment of args.assignments ?? []) this.#assignments.set(key(run.instanceId, assignment.assignmentKey), structuredClone(assignment));
    this.control.runs.get(run.runId)!.status = run.state.status;
    this.control.appendEventSync({ runId: run.runId, stepId: args.event.stepId, actor: "agent", subjectPrincipal: args.event.principal,
      event: args.event.name, status: "succeeded", evidence: args.event.evidence,
      payload: { revision: run.revision, state_digest: sha256(run.state), artifact_hash: run.artifactHash, manifest_hash: run.manifestHash } });
    return structuredClone(run);
  }
  async cancel(args: Parameters<WorkflowExecutionStore["cancel"]>[0]): Promise<boolean> {
    workflowInstant(args.now);
    const run = this.#runs.get(key(args.instanceId, args.runId));
    if (!run || !active(run)) return false;
    run.state.status = "cancelled"; delete run.state.wait; delete run.lease; run.revision++; run.updatedAt = args.now;
    this.control.runs.get(run.runId)!.status = "cancelled";
    this.control.appendEventSync({ runId: run.runId, stepId: run.state.cursor ?? "end", actor: "human:operator", subjectPrincipal: args.principal, event: "workflow.cancelled", status: "succeeded", payload: { revision: run.revision } });
    return true;
  }
  async assignment(args: Parameters<WorkflowExecutionStore["assignment"]>[0]): Promise<WorkflowAssignment | undefined> {
    workflowInstant(args.now);
    const assignment = this.#assignments.get(key(args.instanceId, workflowAssignmentKey(args.instanceId, args.conversation)));
    if (!assignment || assignment.expiresAt <= args.now || (assignment.subjectPrincipal && assignment.subjectPrincipal !== args.conversation.subjectPrincipal)) return undefined;
    const run = this.#runs.get(key(args.instanceId, assignment.runId));
    return run && active(run) ? structuredClone(assignment) : undefined;
  }
}
