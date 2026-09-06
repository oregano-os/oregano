import type { JsonValue, RiskLevel } from "../../capabilities/contracts.ts";
import { RISK_ORDER } from "../../capabilities/contracts.ts";
import type { CompanyOSArtifact } from "../../companyos-builder/types.ts";
import type { CompiledWorkflow, CompiledWorkflowStep } from "../../companyos-builder/workflow-types.ts";
import { authorizePrincipalApproval, isHumanRosterMember, type RosterMember } from "../../state-store/roster.ts";
import { canonicalJson, jsonDigest, sha256 } from "../canonical.ts";
import type { WorkflowInvocationContext } from "./context.ts";
import { resolveWorkflowValue } from "./references.ts";

export function workflowDecisionRisk(workflow: CompiledWorkflow, stepId: string): RiskLevel {
  return workflow.steps.filter((step) => step.requiresDecisions.some((requirement) => requirement.stepId === stepId))
    .reduce<RiskLevel>((risk, step) => RISK_ORDER[step.maxRisk] > RISK_ORDER[risk] ? step.maxRisk : risk, "R0");
}
export function workflowDecisionId(runId: string, stepId: string, boundDigest: string): string {
  return sha256({ runId, stepId, boundDigest });
}
export function workflowDecisionMemberAllowed(member: RosterMember, workflow: CompiledWorkflow, step: CompiledWorkflowStep): boolean {
  return !!member.id && isHumanRosterMember(member) && /^(active|aktiv)$/i.test(member.status) && member.role === step.decision?.role
    && (workflowDecisionRisk(workflow, step.id) === "R0" || member.mayApprove.includes(workflowDecisionRisk(workflow, step.id)));
}
export function authorizeWorkflowDecisionPrincipal(roster: RosterMember[], principal: string, workflow: CompiledWorkflow, step: CompiledWorkflowStep): RosterMember {
  const risk = workflowDecisionRisk(workflow, step.id);
  const auth = authorizePrincipalApproval(roster, principal, risk === "R0" ? "R1" : risk);
  if (!auth.member || !workflowDecisionMemberAllowed(auth.member, workflow, step) || (risk !== "R0" && !auth.ok)) throw new Error("Workflow decision requires an authenticated active human in the authorized role");
  return auth.member;
}

/** Deterministic rendering also permits retrospective input verification after expiry. */
export function renderWorkflowDecisionNotice(args: { runId: string; workflowId: string; stepId: string; role: string; expiresAt: string; bound: JsonValue; destinationBinding: string }): JsonValue {
  const id = workflowDecisionId(args.runId, args.stepId, jsonDigest(args.bound));
  const content = ["Approval required", `Workflow: ${args.workflowId}`, `Step: ${args.stepId}`, `Role: ${args.role}`,
    `Expires: ${args.expiresAt}`, `Request: ${id}`, "", "Complete bound payload:", canonicalJson(args.bound), "",
    `Reply in this thread with APPROVE ${id} or REJECT ${id}.`].join("\n");
  if (content.length > 20_000) throw new Error("Decision payload is too large for a complete review notice; it must not be truncated");
  return { destination_binding: args.destinationBinding, content, format: "plain-text" };
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
    expiresAt: decision.expiresAt, bound, destinationBinding: destinations[0]!.destinationBinding });
}
