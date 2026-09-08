import type { JsonValue } from "../../capabilities/contracts.ts";
import type { CompanyOSArtifact } from "../../companyos-builder/types.ts";
import type { CompiledWorkflow, CompiledWorkflowStep } from "../../companyos-builder/workflow-types.ts";
import type { WorkflowReviewDelivery, WorkflowRun } from "../../state-store/workflow-engine.ts";
import type { RosterMember } from "../../state-store/roster.ts";
import { canonicalJson, jsonDigest, sha256 } from "../canonical.ts";
import { authorizeWorkflowDecisionPrincipal } from "./decision-notice.ts";
import type { WorkflowInvocationContext } from "./context.ts";
import { resolveWorkflowValue } from "./references.ts";
import { workflowEffectReview } from "./effect-review.ts";

export const workflowReviewStepId = (stepId: string, page: number): string => `review:${stepId}:${page}`;
export const workflowReviewEffectKey = (instanceId: string, runId: string, executionStepId: string): string => `workflow-review:${sha256({ instanceId, runId, executionStepId })}`;
export function workflowReviewDeliveryDigest(delivery: Omit<WorkflowReviewDelivery, "digest" | "outputs">): string {
  return jsonDigest({ blockedStepId: delivery.blockedStepId, decisionStepId: delivery.decisionStepId,
    memberId: delivery.memberId, principal: delivery.principal, evidenceDigest: delivery.evidenceDigest, pages: delivery.pages });
}

/** Freeze only normalized outcome evidence, never raw errors or provider payloads. */
export function prepareWorkflowReviewDelivery(args: {
  run: WorkflowRun; workflow: CompiledWorkflow; step: CompiledWorkflowStep;
  roster: RosterMember[]; effect: Record<string, unknown>; input: JsonValue;
}): WorkflowReviewDelivery | undefined {
  const { run, workflow, step } = args;
  const decisions = [...new Set(step.requiresDecisions.map((requirement) => requirement.stepId))];
  if (decisions.length !== 1 || !run.state.blocked || args.effect.status === "succeeded") return undefined;
  const decisionStepId = decisions[0]!, decision = run.state.decisions[decisionStepId];
  const declared = workflow.steps.find((entry) => entry.id === decisionStepId);
  if (!declared?.decision || decision?.status !== "approved" || !decision.approvingPrincipal) return undefined;
  const member = authorizeWorkflowDecisionPrincipal(args.roster, decision.approvingPrincipal, workflow, declared);
  if (!member.id || !decision.recipients.includes(member.id)) throw new Error("Effect review has no exact original human recipient");
  const receipt = decision.deliveries[member.id] as Record<string, JsonValue> | undefined;
  if (typeof receipt?.destination_binding !== "string" || typeof receipt.thread_reference !== "string") throw new Error("Effect review requires the retained decision delivery receipt");
  const review = workflowEffectReview(args.effect, args.input), evidenceDigest = jsonDigest(review);
  const lines = [`Effect status: ${review.status}`, "Item states: verified = retained receipt; unknown = inspect provider; not-attempted = explicit Connector evidence."];
  for (const capability of review.capabilities) {
    lines.push(`Capability: ${capability.capability}; evidence: ${capability.evidenceDigest}`);
    if (capability.items?.length) for (const item of capability.items) lines.push(`${canonicalJson(item.item_id)}: ${item.status}`);
    else lines.push("No verified per-item outcome is available. Inspect the retained provider evidence.");
  }
  if (!review.capabilities.length) lines.push("No verified per-item outcome is available. Inspect the retained effect and provider state.");
  if ("additionalCapabilityReceipts" in review) lines.push(`Additional receipts require operator review: ${review.additionalCapabilityReceipts}.`);
  const chunks: string[][] = [];
  for (let offset = 0; offset < lines.length; offset += 40) chunks.push(lines.slice(offset, offset + 40));
  if (chunks.length > 256) throw new Error("Effect review exceeds the bounded automatic delivery size; inspect all operator review pages");
  const pages = chunks.map((chunk, index) => {
    const content = ["Workflow stopped: effect outcome requires review", `Workflow: ${workflow.id}`, `Run: ${run.runId}`, `Step: ${step.id}`,
      `Evidence: ${evidenceDigest}`, `Page: ${index + 1}/${chunks.length}`, "", ...chunk, "",
      "Execution remains stopped. Do not repeat this action. Check the provider and retained receipts before a separate recovery decision. This message does not authorize retry."].join("\n");
    if (content.length > 20_000) throw new Error("Effect review page exceeds the publication bound");
    const input = { destination_binding: receipt.destination_binding!, thread_reference: receipt.thread_reference!, format: "plain-text", content };
    return { input, inputDigest: jsonDigest(input) };
  });
  const immutable = { blockedStepId: step.id, decisionStepId, memberId: member.id, principal: decision.approvingPrincipal, evidenceDigest, pages };
  return { ...immutable, digest: workflowReviewDeliveryDigest(immutable), outputs: [] };
}

/** The host supplies a persisted page; model arguments never select its payload or audience. */
export function workflowReviewNoticeInput(artifact: CompanyOSArtifact, workflow: CompiledWorkflow, step: CompiledWorkflowStep, context: WorkflowInvocationContext): JsonValue {
  const delivery = context.reviewDelivery;
  if (context.mode !== "review" || !delivery || delivery.blocked || delivery.decisionStepId !== step.id || !step.decision
    || delivery.digest !== workflowReviewDeliveryDigest(delivery)) throw new Error("Effect review has no valid frozen delivery");
  const page = delivery.outputs.length, frozen = delivery.pages[page];
  if (!frozen || jsonDigest(frozen.input) !== frozen.inputDigest || context.item !== undefined || context.itemKey !== undefined) throw new Error("Effect review has no exact pending page");
  const decision = context.decisions[step.id];
  if (decision?.status !== "approved" || decision.approvingPrincipal !== delivery.principal || context.subjectPrincipal !== delivery.principal) throw new Error("Effect review recipient differs from the recorded human approver");
  const member = authorizeWorkflowDecisionPrincipal(context.currentRoster, delivery.principal, workflow, step);
  if (member.id !== delivery.memberId || !decision.recipients?.includes(member.id!)) throw new Error("Effect review recipient is no longer the exact authorized human");
  const binding = resolveWorkflowValue(step.decision.via, workflow, context);
  const destinations = artifact.workflowBindings?.directRecipients.filter((entry) => entry.bindingId === binding && entry.memberId === member.id) ?? [];
  const input = frozen.input as Record<string, JsonValue>;
  if (destinations.length !== 1 || input.destination_binding !== destinations[0]!.destinationBinding || input.format !== "plain-text"
    || typeof input.thread_reference !== "string" || typeof input.content !== "string") throw new Error("Effect review destination differs from its exact reviewed decision binding");
  const fence = context.dispatchFence;
  if (!fence?.review || fence.stepId !== delivery.blockedStepId || fence.review.digest !== delivery.digest || fence.review.page !== page
    || fence.review.inputDigest !== frozen.inputDigest || fence.review.executionStepId !== workflowReviewStepId(delivery.blockedStepId, page)) throw new Error("Effect review requires its own exact leased dispatch fence");
  return structuredClone(frozen.input);
}
