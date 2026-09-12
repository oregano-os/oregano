import type { CompanyOSArtifact } from "../../companyos-builder/types.ts";
import type { RunMeta } from "../../state-store/interface.ts";
import type { WorkflowAssignment, WorkflowConversation, WorkflowMutableState, WorkflowRunIdentity } from "../../state-store/workflow-engine.ts";
import { canonicalJson, sha256, jsonDigest } from "../canonical.ts";
import { assertWorkflowArtifact } from "./guard.ts";
import { workflowReviewDeliveryDigest } from "./review-notice.ts";
import { workflowReviewDecision } from "./review-dependency.ts";

export function workflowInstant(value: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("Workflow state requires an exact UTC ISO instant");
}
const identifier = (value: string): void => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/.test(value)) throw new Error("Invalid bounded workflow identity");
};
const digest = (value: string): void => { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid workflow digest"); };
const safeObject = (value: unknown): void => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workflow state requires an object");
  if (Object.keys(value).some((key) => ["__proto__", "constructor", "prototype"].includes(key))) throw new Error("Unsafe workflow state key");
};

export const workflowRunId = (identity: Pick<WorkflowRunIdentity, "instanceId" | "workflowId" | "originKey">): string => `workflow:${sha256({ instanceId: identity.instanceId, workflowId: identity.workflowId, originKey: identity.originKey })}`;
export const workflowOriginDigest = (identity: WorkflowRunIdentity): string => sha256({
  instanceId: identity.instanceId, workflowId: identity.workflowId, originKey: identity.originKey,
  subjectPrincipal: identity.subjectPrincipal, trigger: identity.trigger, fields: identity.fields,
});
export const workflowAssignmentKey = (instanceId: string, conversation: WorkflowConversation): string => sha256({
  ...(conversation.decisionMessageId === undefined ? {} : { decisionMessageId: conversation.decisionMessageId }),
  instanceId, surface: conversation.surface, accountId: conversation.accountId, channelId: conversation.channelId, threadId: conversation.threadId,
});

/** Publication indexes cannot be mistaken for executable assignments. */
export const workflowPublicationKey = (instanceId: string, conversation: WorkflowConversation, messageId: string): string =>
  sha256({ conversation: workflowAssignmentKey(instanceId, conversation), publicationMessageId: messageId });

export function validateWorkflowCreation(identity: WorkflowRunIdentity, state: WorkflowMutableState, meta: RunMeta, artifact: CompanyOSArtifact): void {
  assertWorkflowArtifact(artifact);
  for (const value of [identity.instanceId, identity.runId, identity.workflowId, identity.originKey, identity.subjectPrincipal]) identifier(value);
  for (const value of [identity.artifactHash, identity.manifestHash, identity.originDigest]) digest(value);
  workflowInstant(identity.createdAt); workflowInstant(identity.trigger.instant);
  if (identity.trigger.previous_instant) workflowInstant(identity.trigger.previous_instant);
  safeObject(identity.fields); safeObject(identity.trigger.params);
  const workflow = artifact.workflows?.find((candidate) => candidate.id === identity.workflowId);
  const agent = artifact.agents.find((candidate) => candidate.id === workflow?.agentId);
  if (!workflow || !agent || identity.instanceId !== artifact.instance.id || identity.artifactHash !== artifact.artifactHash || identity.manifestHash !== workflow.manifestHash) throw new Error("Workflow creation differs from its pinned Artifact");
  if (identity.runId !== workflowRunId(identity)) throw new Error("Workflow run ID differs from its opening identity");
  if (identity.originDigest !== workflowOriginDigest(identity)) throw new Error("Workflow opening digest differs from its immutable input");
  if (Object.keys(identity.fields).some((field) => !workflow.instance.fields.includes(field)) || workflow.instance.key.some((field) => !identity.fields[field])) throw new Error("Workflow fields do not match the declared instance key");
  if (Object.values(identity.fields).some((value) => typeof value !== "string" || !value.length || value.length > 1000)) throw new Error("Workflow instance fields must be bounded strings");
  if (meta.runId !== identity.runId || meta.workflow !== identity.workflowId || meta.workflowVersion !== String(workflow.version)
    || meta.companyCommit !== artifact.provenance.workspaceCommit || meta.companySnapshotHash !== artifact.provenance.workspaceHash
    || meta.agentDefinitionHash !== sha256({ instructions: agent.instructions, materials: agent.materials })) throw new Error("Workflow control metadata differs from its pinned Artifact");
  if (state.status !== "running" || state.cursor !== workflow.entry || Object.keys(state.steps).length || Object.keys(state.decisions).length || state.wait || state.blocked || state.reviewDelivery) throw new Error("New workflow must start at its empty entry state");
  validateWorkflowState(state, identity.workflowId, artifact);
}

export function validateWorkflowState(state: WorkflowMutableState, workflowId: string, artifact: CompanyOSArtifact, previous?: WorkflowMutableState): void {
  safeObject(state); safeObject(state.steps); safeObject(state.decisions);
  if (!["running", "waiting", "done", "cancelled", "failed"].includes(state.status)) throw new Error("Invalid workflow status");
  workflowInstant(state.logicalInstant);
  const workflow = artifact.workflows?.find((candidate) => candidate.id === workflowId);
  if (!workflow) throw new Error("Workflow is missing from its historical Artifact");
  const ids = new Set(workflow.steps.map((step) => step.id));
  if (state.cursor !== null && !ids.has(state.cursor)) throw new Error("Workflow cursor is not a compiled step");
  if (state.status === "done" && state.cursor !== null) throw new Error("Completed workflow cannot retain an active cursor");
  if (["running", "waiting"].includes(state.status) && state.cursor === null) throw new Error("Active workflow requires a cursor");
  if (Buffer.byteLength(canonicalJson(state), "utf8") > 64 * 1024 * 1024) throw new Error("Workflow snapshot exceeds 64 MiB");
  for (const [id, step] of Object.entries(state.steps)) {
    if (!ids.has(id) || !["running", "waiting", "succeeded", "failed"].includes(step.status)) throw new Error("Invalid workflow step state");
    workflowInstant(step.startedAt);
    if (step.completedAt) workflowInstant(step.completedAt);
    if (step.status === "succeeded" && (!step.completedAt || step.output === undefined)) throw new Error("Completed step requires time and output evidence");
    if (step.inputDigest) digest(step.inputDigest);
    const prior = previous?.steps[id];
    if (prior?.status === "succeeded" && canonicalJson(prior) !== canonicalJson(step)) throw new Error("Completed workflow output is immutable");
    if (prior?.inputDigest && prior.inputDigest !== step.inputDigest) throw new Error("Workflow step input identity is immutable");
    for (const [key, item] of Object.entries(prior?.items ?? {})) if (canonicalJson(step.items?.[key]) !== canonicalJson(item)) throw new Error("Completed workflow item output is immutable");
    for (const [recipient, recovery] of Object.entries(prior?.publicationRecoveries ?? {})) {
      if (canonicalJson(step.publicationRecoveries?.[recipient]) !== canonicalJson(recovery)) throw new Error("Publication recovery history is immutable");
    }
    for (const [recipient, recovery] of Object.entries(step.publicationRecoveries ?? {})) {
      const decision = state.decisions[id], priorDecision = previous?.decisions[id];
      identifier(recipient); identifier(recovery.principal); digest(recovery.inputDigest); workflowInstant(recovery.authorizedAt);
      if (!/^workflow:[a-f0-9]{64}$/.test(recovery.priorEffectKey) || recovery.proof === undefined || !decision?.recipients.includes(recipient)) throw new Error("Invalid publication recovery evidence");
      if (!prior?.publicationRecoveries?.[recipient] && (previous?.blocked?.stepId !== id || previous.blocked.code !== "step-failed"
        || previous.status !== "waiting" || previous.cursor !== id || state.cursor !== id || state.status !== "running" || state.blocked
        || priorDecision?.status !== "pending" || priorDecision.expiresAt <= recovery.authorizedAt || Object.hasOwn(priorDecision.deliveries, recipient)
        || canonicalJson(priorDecision) !== canonicalJson(decision))) throw new Error("Publication recovery requires its unchanged blocked pending decision");
    }
  }
  for (const [id, decision] of Object.entries(state.decisions)) {
    const declaration = workflow.steps.find((step) => step.id === id)?.decision;
    if (!declaration || decision.stepId !== id || decision.role !== declaration.role || !["pending", "approved", "rejected", "timed-out"].includes(decision.status)) throw new Error("Invalid workflow decision state");
    workflowInstant(decision.createdAt); workflowInstant(decision.expiresAt); digest(decision.boundDigest);
    if (decision.boundDigest !== jsonDigest(decision.bound)) throw new Error("Workflow decision digest differs from its bound payload");
    if (!Array.isArray(decision.recipients) || decision.recipients.length > 1000 || new Set(decision.recipients).size !== decision.recipients.length) throw new Error("Invalid workflow decision recipients");
    if (decision.expiresAt <= decision.createdAt) throw new Error("Workflow decision needs a future finite deadline");
    if (decision.status === "approved" || decision.status === "rejected") {
      if (!decision.approvingPrincipal || !decision.responseEventId || !decision.decidedAt) throw new Error("Human decision requires authenticated response evidence");
      workflowInstant(decision.decidedAt);
    }
    const prior = previous?.decisions[id];
    if (prior) {
      for (const key of ["stepId", "role", "bound", "boundDigest", "createdAt", "expiresAt", "recipients"] as const) if (canonicalJson(prior[key]) !== canonicalJson(decision[key])) throw new Error("Workflow decision binding is immutable");
      if (prior.status !== "pending" && canonicalJson(prior) !== canonicalJson(decision)) throw new Error("A decided workflow request is immutable");
      for (const [key, receipt] of Object.entries(prior.deliveries)) if (canonicalJson(receipt) !== canonicalJson(decision.deliveries[key])) throw new Error("Workflow decision delivery evidence is immutable");
    }
  }
  for (const id of Object.keys(previous?.steps ?? {})) if (!Object.hasOwn(state.steps, id)) throw new Error("Workflow step history cannot be removed");
  for (const id of Object.keys(previous?.decisions ?? {})) if (!Object.hasOwn(state.decisions, id)) throw new Error("Workflow decision history cannot be removed");
  const delivery = state.reviewDelivery, priorDelivery = previous?.reviewDelivery;
  if (priorDelivery && !delivery) throw new Error("Effect review delivery history cannot be removed");
  if (delivery) {
    const failed = workflow.steps.find((step) => step.id === delivery.blockedStepId), decision = state.decisions[delivery.decisionStepId];
    if (!failed || workflowReviewDecision(workflow, failed, state) !== delivery.decisionStepId
      || decision?.status !== "approved" || decision.approvingPrincipal !== delivery.principal || !decision.recipients.includes(delivery.memberId)) throw new Error("Effect review must retain its original approved decision");
    if (!priorDelivery && (state.status !== "waiting" || state.blocked?.stepId !== delivery.blockedStepId || state.cursor !== delivery.blockedStepId)) throw new Error("Effect review must start from the stopped business step");
    const receipt = decision.deliveries[delivery.memberId] as Record<string, unknown> | undefined;
    digest(delivery.digest); digest(delivery.evidenceDigest);
    if (!Array.isArray(delivery.pages) || !delivery.pages.length || delivery.pages.length > 256 || !Array.isArray(delivery.outputs)
      || delivery.outputs.length > delivery.pages.length || delivery.digest !== workflowReviewDeliveryDigest(delivery)) throw new Error("Invalid frozen effect review pages");
    for (const page of delivery.pages) {
      const input = page.input as Record<string, unknown>;
      safeObject(input); digest(page.inputDigest);
      if (page.inputDigest !== jsonDigest(input) || Object.keys(input).sort().join(",") !== "content,destination_binding,format,thread_reference"
        || input.format !== "plain-text" || typeof input.content !== "string" || input.content.length > 20_000
        || typeof input.thread_reference !== "string" || input.thread_reference !== receipt?.thread_reference || input.destination_binding !== receipt?.destination_binding) throw new Error("Effect review changed its payload or original decision conversation");
    }
    if (delivery.blocked) digest(delivery.blocked.errorDigest);
    if (priorDelivery) {
      if (delivery.digest !== priorDelivery.digest || delivery.outputs.length < priorDelivery.outputs.length || delivery.outputs.length > priorDelivery.outputs.length + 1) throw new Error("Effect review pages are immutable and advance one receipt at a time");
      for (const [index, output] of priorDelivery.outputs.entries()) if (canonicalJson(delivery.outputs[index]) !== canonicalJson(output)) throw new Error("Effect review publication evidence is immutable");
      if (priorDelivery.blocked && canonicalJson(delivery) !== canonicalJson(priorDelivery)) throw new Error("Uncertain effect review publication requires separate human inspection");
    } else if (delivery.outputs.length || delivery.blocked) throw new Error("New effect review cannot claim prior delivery");
    for (const output of delivery.outputs as Record<string, unknown>[]) if (typeof output?.message_id !== "string" || output.destination_binding !== receipt?.destination_binding || output.thread_reference !== receipt?.thread_reference) throw new Error("Effect review receipt differs from the original conversation");
  }
  if (state.wait) {
    if (state.wait.stepId !== state.cursor || !["step", "delivery", "decision", "start", "records"].includes(state.wait.kind)) throw new Error("Workflow wait does not match its cursor");
    workflowInstant(state.wait.dueAt); identifier(state.wait.timerId);
  }
}

export function validateWorkflowLease(args: { owner: string; token: string; now: string; expiresAt: string }): void {
  identifier(args.owner); identifier(args.token); workflowInstant(args.now); workflowInstant(args.expiresAt);
  const duration = Date.parse(args.expiresAt) - Date.parse(args.now);
  if (duration <= 0 || duration > 300_000) throw new Error("Workflow worker lease must last at most five minutes");
}

export function validateWorkflowAssignment(assignment: WorkflowAssignment, identity: WorkflowRunIdentity, artifact: CompanyOSArtifact, now: string): void {
  identifier(assignment.surface);
  for (const value of [assignment.accountId, assignment.channelId, assignment.threadId, ...(assignment.decisionMessageId === undefined ? [] : [assignment.decisionMessageId])]) if (typeof value !== "string" || !value.length || value.length > 1000 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid workflow conversation identifier");
  if (assignment.subjectPrincipal) identifier(assignment.subjectPrincipal);
  workflowInstant(assignment.expiresAt);
  if (assignment.expiresAt <= now || !artifact.workflows?.find((workflow) => workflow.id === identity.workflowId)?.steps.some((step) => step.id === assignment.stepId)) throw new Error("Workflow assignment must bind a current deadline and compiled step");
  const publication = assignment.publication;
  if (publication) {
    const step = artifact.workflows?.find((workflow) => workflow.id === identity.workflowId)?.steps.find((step) => step.id === assignment.stepId);
    if (!step?.message && !step?.decision) throw new Error("Publication evidence must belong to a compiled message or decision");
    if (typeof publication.messageId !== "string" || !publication.messageId.length || publication.messageId.length > 1000
      || /[\u0000-\u001f\u007f]/.test(publication.messageId) || typeof publication.content !== "string" || publication.content.length > 20_000
      || !["plain-text", "provider-markdown"].includes(publication.format)) throw new Error("Invalid bounded publication evidence");
    workflowInstant(publication.publishedAt);
    if (!Number.isSafeInteger(publication.sequence) || publication.sequence < 1) throw new Error("Invalid publication commit sequence");
    if (publication.contentDigest !== sha256({ content: publication.content, format: publication.format })) throw new Error("Publication content digest differs from delivered text");
  }
  const expected = publication ? workflowPublicationKey(assignment.instanceId, assignment, publication.messageId) : workflowAssignmentKey(assignment.instanceId, assignment);
  if (assignment.assignmentKey !== expected || assignment.runId !== identity.runId || assignment.instanceId !== identity.instanceId || assignment.artifactHash !== identity.artifactHash) throw new Error("Workflow assignment differs from the exact delivered conversation and run");
}
