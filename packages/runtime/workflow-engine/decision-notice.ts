import type { JsonValue, RiskLevel } from "../../capabilities/contracts.ts";
import { RISK_ORDER } from "../../capabilities/contracts.ts";
import type { CompanyOSArtifact } from "../../companyos-builder/types.ts";
import type { CompiledWorkflow, CompiledWorkflowStep } from "../../companyos-builder/workflow-types.ts";
import { authorizePrincipalApproval, isHumanRosterMember, type RosterMember } from "../../state-store/roster.ts";
import { canonicalJson, jsonDigest, sha256 } from "../canonical.ts";
import type { WorkflowInvocationContext } from "./context.ts";
import { resolveWorkflowValue, valueAt } from "./references.ts";

export function workflowDecisionRisk(workflow: CompiledWorkflow, stepId: string): RiskLevel {
  return workflow.steps.filter((step) => step.requiresDecisions.some((requirement) => requirement.stepId === stepId))
    .reduce<RiskLevel>((risk, step) => RISK_ORDER[step.maxRisk] > RISK_ORDER[risk] ? step.maxRisk : risk, "R0");
}
export function workflowDecisionId(runId: string, stepId: string, boundDigest: string): string {
  return sha256({ runId, stepId, boundDigest });
}
export function workflowDecisionMemberAllowed(member: RosterMember, workflow: CompiledWorkflow, step: CompiledWorkflowStep): boolean {
  return !!member.id && isHumanRosterMember(member) && /^(active|aktiv)$/i.test(member.status) && (step.decision?.role === "subject" ? step.decision.recipient !== undefined && RISK_ORDER[workflowDecisionRisk(workflow, step.id)] <= 2 : member.role === step.decision?.role)
    && (step.decision?.role === "subject" || workflowDecisionRisk(workflow, step.id) === "R0" || member.mayApprove.includes(workflowDecisionRisk(workflow, step.id)));
}
export function authorizeWorkflowDecisionPrincipal(roster: RosterMember[], principal: string, workflow: CompiledWorkflow, step: CompiledWorkflowStep): RosterMember {
  const risk = workflowDecisionRisk(workflow, step.id);
  const auth = authorizePrincipalApproval(roster, principal, risk === "R0" ? "R1" : risk);
  if (!auth.member || !workflowDecisionMemberAllowed(auth.member, workflow, step) || (step.decision?.role !== "subject" && risk !== "R0" && !auth.ok)) throw new Error("Workflow decision requires an authenticated active human in the authorized role");
  return auth.member;
}

/** Deterministic rendering also permits retrospective input verification after expiry. */
export function renderWorkflowDecisionNotice(args: { runId: string; workflowId: string; stepId: string; role: string; expiresAt: string; bound: JsonValue; destinationBinding: string; threadReference?: string; presentation?: { explanation: string; approve: string; reject: string } }): JsonValue {
  const id = workflowDecisionId(args.runId, args.stepId, jsonDigest(args.bound));
  if (args.presentation) {
    const content = [args.presentation.explanation || "Please review the proposed change before deciding.",
      `Decision expires: ${args.expiresAt}`, "Exact proposed changes:", canonicalJson(args.bound)].join("\n\n");
    if (content.length > 20_000) throw new Error("Decision payload is too large for a complete review notice; it must not be truncated");
    return { destination_binding: args.destinationBinding, ...(args.threadReference === undefined ? {} : { thread_reference: args.threadReference }), content, format: "provider-markdown",
      decision: { request_id: id, approve_label: args.presentation.approve, reject_label: args.presentation.reject } };
  }
  const content = ["Approval required", `Workflow: ${args.workflowId}`, `Step: ${args.stepId}`, `Role: ${args.role}`,
    `Expires: ${args.expiresAt}`, `Request: ${id}`, "", "Complete bound payload:", canonicalJson(args.bound), "",
    `Reply in this thread with APPROVE ${id} or REJECT ${id}.`].join("\n");
  if (content.length > 20_000) throw new Error("Decision payload is too large for a complete review notice; it must not be truncated");
  return { destination_binding: args.destinationBinding, content, format: "plain-text" };
}

export function workflowDecisionPresentation(workflow: CompiledWorkflow, step: CompiledWorkflowStep, context: WorkflowInvocationContext) {
  const presentation = step.decision?.presentation;
  if (!presentation) return undefined; // Preserve the exact inputs of historical Artifacts.
  let explanation = "";
  if (presentation.message) {
    const template = workflow.templates.find((entry) => entry.path === presentation.message!.template);
    if (!template) throw new Error("Decision template is absent from the pinned Artifact");
    const variables = resolveWorkflowValue(presentation.message.vars, workflow, context);
    explanation = template.content.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g, (_match, name: string) => {
      const value = valueAt(variables, [name], "Decision template variables");
      if (!["string", "number", "boolean"].includes(typeof value)) throw new Error("Decision template variables must be scalar");
      return String(value);
    });
  }
  return { explanation, ...presentation.labels };
}

/** Only a captured prior publication to this exact destination may supply the parent. */
export function workflowDecisionThread(workflow: CompiledWorkflow, step: CompiledWorkflowStep, context: WorkflowInvocationContext, destination: string): string | undefined {
  if (step.decision?.thread === undefined) return undefined;
  const sourceId = /^\$steps\.([a-z][a-z0-9-]*)\.thread_reference$/.exec(String(step.decision.thread))?.[1];
  const source = sourceId && context.steps[sourceId];
  const receipt = source as Record<string, JsonValue> | undefined;
  const thread = resolveWorkflowValue(step.decision.thread, workflow, context);
  if (typeof thread !== "string" || !thread || receipt?.destination_binding !== destination || receipt.thread_reference !== thread)
    throw new Error("Decision parent must be a prior receipt for the exact recipient destination");
  return thread;
}

/** Generic control notice; the complete bound JSON is displayed without truncation. */
export function workflowDecisionNoticeInput(artifact: CompanyOSArtifact, workflow: CompiledWorkflow, step: CompiledWorkflowStep, context: WorkflowInvocationContext): JsonValue {
  const decision = context.decisions[step.id];
  if (!step.decision || !decision || decision.status !== "pending" || typeof context.itemKey !== "string" || !decision.recipients?.includes(context.itemKey)) throw new Error("Decision delivery has no persisted pending request and exact recipient");
  const now = Math.max(Date.now(), Date.parse(context.dispatchFence?.now ?? new Date().toISOString()));
  if (!Number.isFinite(Date.parse(decision.expiresAt)) || Date.parse(decision.expiresAt) <= now) throw new Error("Decision notice has expired");
  const members = context.currentRoster.filter((member) => member.id === context.itemKey);
  if (members.length !== 1 || !workflowDecisionMemberAllowed(members[0]!, workflow, step)) throw new Error("Decision notice recipient is no longer in the authorized human role");
  const bound = resolveWorkflowValue(step.decision.binds, workflow, context);
  if (jsonDigest(bound) !== decision.boundDigest) throw new Error("Decision notice payload differs from the persisted bound digest");
  const binding = resolveWorkflowValue(step.decision.via, workflow, context);
  const destinations = artifact.workflowBindings?.directRecipients.filter((entry) => entry.bindingId === binding && entry.memberId === context.itemKey) ?? [];
  if (destinations.length !== 1) throw new Error("Decision notice requires an exact qualified recipient destination");
  return renderWorkflowDecisionNotice({ runId: context.runId, workflowId: workflow.id, stepId: step.id, role: step.decision.role,
    threadReference: workflowDecisionThread(workflow, step, context, destinations[0]!.destinationBinding),
    presentation: workflowDecisionPresentation(workflow, step, context), expiresAt: decision.expiresAt, bound, destinationBinding: destinations[0]!.destinationBinding });
}

/** Short replies are accepted only on the actual delivered subject-confirmation thread. */
export function subjectDecisionReply(text: string, role: string, language = "en"): "approved" | "rejected" | undefined {
  if (role !== "subject") return undefined;
  const value = text.trim().toLowerCase();
  const german = language.toLowerCase().split(/[-_]/)[0] === "de";
  if (value === (german ? "ja" : "yes")) return "approved";
  if (value === (german ? "nein" : "no")) return "rejected";
  return undefined;
}
