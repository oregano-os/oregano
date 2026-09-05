import { validateJsonSchemaValue } from "../../capabilities/validation.ts";
import { RISK_ORDER, type JsonValue, type RiskLevel } from "../../capabilities/contracts.ts";
import type { CompanyOSArtifact, CompiledCompanyTool } from "../../companyos-builder/types.ts";
import type { CompiledWorkflow, CompiledWorkflowStep } from "../../companyos-builder/workflow-types.ts";
import { authorizePrincipalApproval, isHumanRosterMember } from "../../state-store/roster.ts";
import { sha256, canonicalJson, jsonDigest } from "../canonical.ts";
import { resolveWorkflowValue, valueAt, workflowItems } from "./references.ts";
import type { WorkflowContextReader, WorkflowEvidence, WorkflowInvocationContext, WorkflowReferenceContext } from "./context.ts";

export interface WorkflowGuardRequest {
  runId: string;
  stepId: string;
  agentId: string;
  grantId: string;
  input: unknown;
  subjectPrincipal?: string;
}
export interface GuardedWorkflowInvocation {
  context: WorkflowInvocationContext;
  workflow: CompiledWorkflow;
  step: CompiledWorkflowStep;
  evidence: WorkflowEvidence;
  idempotencyKey: string;
}

export function workflowExecutionStepId(stepId: string, itemKey?: string | number): string {
  return itemKey === undefined ? stepId : `${stepId}:${jsonDigest(itemKey)}`;
}

export function workflowEffectKey(artifact: CompanyOSArtifact, context: Pick<WorkflowInvocationContext, "workflowId" | "runId" | "stepId" | "itemKey">): string {
  // Input digest is compared at the claim, not used to mint a new identity.
  return `workflow:${sha256({ instanceId: artifact.instance.id, workflowId: context.workflowId, runId: context.runId, stepId: context.stepId, itemKey: context.itemKey })}`;
}

export function assertWorkflowArtifact(artifact: CompanyOSArtifact): void {
  const { artifactHash, ...content } = artifact;
  const digest = sha256({ ...content, provenance: { ...content.provenance, builtAt: undefined } });
  if (digest !== artifactHash) throw new Error("Workflow Artifact content does not match its pinned hash");
  for (const workflow of artifact.workflows ?? []) {
    const { manifestHash, ...manifest } = workflow;
    if (manifestHash !== sha256(manifest)) throw new Error(`Workflow '${workflow.id}' manifest hash is invalid`);
    if (workflow.provenance.instanceId !== artifact.instance.id || workflow.provenance.coreCommit !== artifact.provenance.coreCommit || workflow.provenance.workspaceCommit !== artifact.provenance.workspaceCommit) throw new Error("Workflow provenance differs from the enclosing Artifact");
  }
}

export function workflowToolInput(artifact: CompanyOSArtifact, workflow: CompiledWorkflow, step: CompiledWorkflowStep, context: WorkflowReferenceContext): JsonValue {
  if (!step.message) {
    const input = resolveWorkflowValue(step.input ?? {}, workflow, context);
    if (step.allPages) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Paged workflow Tool input must be an object");
      input.all_pages = true;
    }
    if (step.requireSyncedThrough !== undefined) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Synchronization-bound Tool input must be an object");
      input.require_synced_through = resolveWorkflowValue(step.requireSyncedThrough, workflow, context);
    }
    return input;
  }
  const template = workflow.templates.find((template) => template.path === step.message!.template);
  if (!template) throw new Error("Workflow template is absent from the pinned Artifact");
  const variables = resolveWorkflowValue(step.message.vars, workflow, context);
  const content = template.content.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g, (_match, name: string) => {
    const value = valueAt(variables, [name], "Template variables");
    if (!["string", "number", "boolean"].includes(typeof value)) throw new Error(`Template variable '${name}' must be a scalar`);
    return String(value);
  });
  let destination = resolveWorkflowValue(step.message.destination, workflow, context);
  if (typeof destination !== "string") throw new Error("Workflow destination must be a binding ID");
  if (step.message.recipient !== undefined) {
    const memberId = resolveWorkflowValue(step.message.recipient, workflow, context);
    if (typeof memberId !== "string") throw new Error("Workflow recipient must be a stable member ID");
    const recipients = artifact.workflowBindings?.directRecipients.filter((entry) => entry.bindingId === destination && entry.memberId === memberId) ?? [];
    if (recipients.length !== 1) throw new Error(`No exact Instance destination for workflow recipient '${memberId}'`);
    destination = recipients[0]!.destinationBinding;
  }
  return {
    destination_binding: destination, content, format: template.format,
    ...(step.message.thread === undefined ? {} : { thread_reference: resolveWorkflowValue(step.message.thread, workflow, context) }),
  };
}

/** The reader is constructor-injected by trusted Core hosting. Request fields cannot select it. */
export async function guardWorkflowInvocation(args: {
  artifact: CompanyOSArtifact;
  reader?: WorkflowContextReader;
  request: WorkflowGuardRequest;
  tool: CompiledCompanyTool;
  risk: RiskLevel;
}): Promise<GuardedWorkflowInvocation | undefined> {
  const workflows = args.artifact.workflows ?? [];
  if (!workflows.length) return undefined;
  if (!args.reader) throw new Error("A workflow Artifact requires a trusted workflow context reader; model context cannot authorize Tools");
  const loaded = await args.reader.read();
  const reserved = workflows.some((workflow) => workflow.agentId === args.request.agentId && workflow.reservedEffects.includes(args.tool.contract.runtimeId));
  if (!loaded) {
    if (reserved) throw new Error("This Tool is reserved for an active workflow step; missing run context cannot bypass the guard");
    return undefined;
  }
  const context = structuredClone(loaded);
  const workflow = workflows.find((workflow) => workflow.id === context.workflowId);
  if (!workflow || context.artifactHash !== args.artifact.artifactHash || context.manifestHash !== workflow.manifestHash) throw new Error("Workflow context does not match the pinned Artifact and manifest");
  const step = workflow.steps.find((step) => step.id === context.stepId);
  if (!step || workflow.agentId !== args.request.agentId || context.runId !== args.request.runId || workflowExecutionStepId(step.id, context.itemKey) !== args.request.stepId) throw new Error("Tool call does not match the trusted run, Agent and step assignment");
  if (context.subjectPrincipal !== args.request.subjectPrincipal) throw new Error("Tool subject differs from the trusted workflow assignment");
  if (context.mode === "conversation") {
    if (context.status !== "waiting" || !step.conversationalTools.includes(args.request.grantId) || reserved) throw new Error("Tool is outside the waiting step's conversational allowlist");
  } else {
    if (context.status !== "running") throw new Error("Workflow run is not eligible for dispatch");
    if (!step.allowedTools.includes(args.tool.contract.runtimeId) || step.tool?.grantId !== args.request.grantId) throw new Error("Tool is outside the current workflow step");
    if (RISK_ORDER[args.risk] > RISK_ORDER[step.maxRisk]) throw new Error("Tool risk exceeds the current workflow step");
    if (step.tool?.contractDigest !== sha256(args.tool.contract) || step.tool.version !== args.tool.contract.version) throw new Error("Workflow Tool contract differs from the pinned step");
    const validateRecipient = (itemContext: WorkflowReferenceContext) => {
      if (step.message?.recipient === undefined) return;
      const memberId = resolveWorkflowValue(step.message.recipient, workflow, itemContext);
      const members = context.currentRoster.filter((member) => member.id === memberId);
      if (members.length !== 1 || !isHumanRosterMember(members[0]!) || !/^(active|aktiv)$/i.test(members[0]!.status)) throw new Error("Workflow direct recipient is not one exact active human");
    };
    if (step.forEach) {
      const items = workflowItems(step, workflow, context);
      const selected = items.find((item) => canonicalJson(item.key) === canonicalJson(context.itemKey));
      if (!selected || canonicalJson(selected.value) !== canonicalJson(context.item)) throw new Error("Workflow item is not the exact keyed item in the frozen collection");
      // Validate every item and destination before permitting even the first dispatch.
      for (const item of items) {
        const itemContext = { ...context, item: item.value };
        const input = workflowToolInput(args.artifact, workflow, step, itemContext);
        if (validateJsonSchemaValue(args.tool.contract.inputSchema, input).length) throw new Error("Workflow collection contains invalid Tool input");
        validateRecipient(itemContext);
      }
    } else if (context.itemKey !== undefined || context.item !== undefined) throw new Error("A scalar workflow step cannot receive an item identity");
    const expected = workflowToolInput(args.artifact, workflow, step, context);
    if (canonicalJson(expected) !== canonicalJson(args.request.input)) throw new Error("Tool input or destination/resource binding differs from the compiled workflow step");
    validateRecipient(context);
  }
  return {
    context, workflow, step, idempotencyKey: workflowEffectKey(args.artifact, context),
    evidence: { workflow_id: workflow.id, workflow_version: workflow.version, manifest_hash: workflow.manifestHash,
      workspace_commit: args.artifact.provenance.workspaceCommit, artifact_hash: args.artifact.artifactHash,
      instance_id: args.artifact.instance.id, run_id: context.runId, step_id: step.id,
      ...(context.itemKey === undefined ? {} : { item_key: context.itemKey }) },
  };
}

/** Applied before new dispatch, after already-successful effect recovery has been considered. */
export function authorizeWorkflowDecisions(guard: GuardedWorkflowInvocation, input: unknown, risk: RiskLevel, now = new Date()): string | undefined {
  const principals = new Set<string>();
  for (const requirement of guard.step.requiresDecisions) {
    const decision = guard.context.decisions[requirement.stepId];
    const declaration = guard.workflow.steps.find((step) => step.id === requirement.stepId)?.decision;
    if (!decision || !declaration || decision.stepId !== requirement.stepId || decision.status !== "approved" || !decision.approvingPrincipal) throw new Error("Workflow effect requires its recorded human decision");
    if (!Number.isFinite(Date.parse(decision.expiresAt)) || Date.parse(decision.expiresAt) <= now.getTime()) throw new Error("Workflow decision has expired");
    const bound = resolveWorkflowValue(declaration.binds, guard.workflow, guard.context);
    if (jsonDigest(bound) !== decision.boundDigest || jsonDigest(valueAt(input, requirement.payloadPath)) !== decision.boundDigest) throw new Error("Workflow decision digest differs from the exact effect payload");
    const authorized = authorizePrincipalApproval(guard.context.currentRoster, decision.approvingPrincipal, risk);
    if (!authorized.ok || authorized.member?.role !== declaration.role) throw new Error("Workflow decision requires an active authorized human in the declared role");
    principals.add(decision.approvingPrincipal);
  }
  if (RISK_ORDER[risk] >= RISK_ORDER.R3 && principals.size !== 1) throw new Error("Workflow R3/R4 effect requires one bound human approval");
  return [...principals][0];
}
