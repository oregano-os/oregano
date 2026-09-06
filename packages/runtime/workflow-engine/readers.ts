import { findByCanonicalPrincipal, isHumanRosterMember, type RosterMember } from "../../state-store/roster.ts";
import type { WorkflowConversation, WorkflowExecutionStore, WorkflowRun } from "../../state-store/workflow-engine.ts";
import type { WorkflowContextReader, WorkflowInvocationContext } from "./context.ts";
import { workflowItems } from "./references.ts";
import { canonicalJson } from "../canonical.ts";
import { workflowReviewNoticeInput, workflowReviewStepId } from "./review-notice.ts";

export class WorkflowLeaseLostError extends Error {
  constructor() { super("Workflow worker no longer owns the active execution lease"); this.name = "WorkflowLeaseLostError"; }
}

export function workflowContext(run: WorkflowRun, roster: RosterMember[]): WorkflowInvocationContext {
  if (!run.state.cursor) throw new Error("Terminal workflow has no Tool context");
  return {
    mode: "engine", runId: run.runId, workflowId: run.workflowId, stepId: run.state.cursor,
    artifactHash: run.artifactHash, manifestHash: run.manifestHash, status: run.state.status, subjectPrincipal: run.subjectPrincipal,
    steps: Object.fromEntries(Object.entries(run.state.steps).filter(([, step]) => step.status === "succeeded").map(([id, step]) => [id, structuredClone(step.output!)])),
    trigger: structuredClone(run.trigger), instance: structuredClone(run.fields), currentRoster: structuredClone(roster),
    decisions: Object.fromEntries(Object.entries(run.state.decisions).map(([id, decision]) => [id, {
      stepId: decision.stepId, status: decision.status === "timed-out" ? "rejected" : decision.status,
      boundDigest: decision.boundDigest, expiresAt: decision.expiresAt, recipients: [...decision.recipients],
      ...(decision.approvingPrincipal ? { approvingPrincipal: decision.approvingPrincipal } : {}),
    }])),
  };
}

/** Constructed by the worker from its own claim, never from model Tool arguments. */
export class WorkflowRunContextReader implements WorkflowContextReader {
  readonly #args: {
    store: WorkflowExecutionStore; instanceId: string; runId: string; leaseToken: string;
    roster: () => Promise<RosterMember[]>; clock: () => string; itemKey?: string | number;
  };
  constructor(args: { store: WorkflowExecutionStore; instanceId: string; runId: string; leaseToken: string; roster: () => Promise<RosterMember[]>; clock: () => string; itemKey?: string | number }) { this.#args = args; }
  async read(): Promise<WorkflowInvocationContext> {
    const now = this.#args.clock();
    const run = await this.#args.store.read(this.#args.instanceId, this.#args.runId);
    if (!run || run.state.status !== "running" || run.state.blocked || run.lease?.token !== this.#args.leaseToken || run.lease.expiresAt <= now) throw new WorkflowLeaseLostError();
    const ctx = workflowContext(run, await this.#args.roster());
    ctx.dispatchFence = { instanceId: run.instanceId, runId: run.runId, stepId: ctx.stepId, leaseToken: this.#args.leaseToken, now };
    if (this.#args.itemKey !== undefined) {
      const artifact = await this.#args.store.getArtifact(run.artifactHash);
      const workflow = artifact?.workflows?.find((workflow) => workflow.id === run.workflowId);
      const step = workflow?.steps.find((step) => step.id === ctx.stepId);
      if (!artifact || !workflow || !step) throw new Error("Workflow historical Artifact or step is unavailable");
      if (step.decision) {
        ctx.itemKey = this.#args.itemKey;
        return ctx;
      }
      const item = workflowItems(step, workflow, ctx).find((item) => canonicalJson(item.key) === canonicalJson(this.#args.itemKey));
      if (!item) throw new Error("Workflow item is not in its persisted collection");
      ctx.itemKey = item.key; ctx.item = item.value;
    }
    return ctx;
  }
}

/** Only the original approved conversation can receive stopped-effect control pages. */
export class WorkflowReviewContextReader implements WorkflowContextReader {
  readonly args: { store: WorkflowExecutionStore; instanceId: string; runId: string; leaseToken: string; roster: () => Promise<RosterMember[]>; clock: () => string };
  constructor(args: { store: WorkflowExecutionStore; instanceId: string; runId: string; leaseToken: string; roster: () => Promise<RosterMember[]>; clock: () => string }) { this.args = args; }
  async read(): Promise<WorkflowInvocationContext> {
    const now = this.args.clock(), run = await this.args.store.read(this.args.instanceId, this.args.runId);
    const delivery = run?.state.reviewDelivery;
    if (!run || run.state.status !== "waiting" || !run.state.blocked || run.state.blocked.stepId !== run.state.cursor
      || !delivery || delivery.blocked || delivery.blockedStepId !== run.state.cursor || run.lease?.token !== this.args.leaseToken || run.lease.expiresAt <= now) throw new WorkflowLeaseLostError();
    const page = delivery.outputs.length, frozen = delivery.pages[page];
    if (!frozen) throw new WorkflowLeaseLostError();
    const artifact = await this.args.store.getArtifact(run.artifactHash), workflow = artifact?.workflows?.find((entry) => entry.id === run.workflowId);
    const step = workflow?.steps.find((entry) => entry.id === delivery.decisionStepId);
    if (!artifact || !workflow || !step) throw new Error("Effect review historical definition is unavailable");
    const context: WorkflowInvocationContext = { ...workflowContext(run, await this.args.roster()), mode: "review", stepId: step.id,
      subjectPrincipal: delivery.principal, reviewDelivery: structuredClone(delivery),
      dispatchFence: { instanceId: run.instanceId, runId: run.runId, stepId: delivery.blockedStepId, leaseToken: this.args.leaseToken, now,
        review: { digest: delivery.digest, page, inputDigest: frozen.inputDigest, executionStepId: workflowReviewStepId(delivery.blockedStepId, page) } } };
    workflowReviewNoticeInput(artifact, workflow, step, context);
    return context;
  }
}

/** The host passes an authenticated transport identity, not a requested run/step lookup. */
export class WorkflowConversationContextReader implements WorkflowContextReader {
  readonly #args: {
    store: WorkflowExecutionStore; instanceId: string; conversation: WorkflowConversation;
    subjectPrincipal: string; roster: () => Promise<RosterMember[]>; clock: () => string;
  };
  constructor(args: { store: WorkflowExecutionStore; instanceId: string; conversation: WorkflowConversation; subjectPrincipal: string; roster: () => Promise<RosterMember[]>; clock: () => string }) { this.#args = args; }
  async read(): Promise<WorkflowInvocationContext | undefined> {
    const assignment = await this.#args.store.assignment({ instanceId: this.#args.instanceId,
      conversation: { ...this.#args.conversation, subjectPrincipal: this.#args.subjectPrincipal }, now: this.#args.clock() });
    if (!assignment) return undefined;
    const run = await this.#args.store.read(this.#args.instanceId, assignment.runId);
    if (!run || !run.state.cursor || run.artifactHash !== assignment.artifactHash) throw new Error("Workflow conversation assignment has no matching pinned run");
    const roster = await this.#args.roster(), subject = findByCanonicalPrincipal(roster, this.#args.subjectPrincipal);
    if (!subject || !isHumanRosterMember(subject) || !/^(active|aktiv)$/i.test(subject.status)) throw new Error("Workflow conversation requires an authenticated active human");
    return { ...workflowContext(run, roster), mode: "conversation", subjectPrincipal: this.#args.subjectPrincipal };
  }
}
