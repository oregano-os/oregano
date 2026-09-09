import type { CompiledWorkflow, CompiledWorkflowStep } from "../../companyos-builder/workflow-types.ts";
import type { WorkflowMutableState } from "../../state-store/workflow-engine.ts";

/** Notification audience only, never write authority. Follow compiled references,
 * not returned business text, and refuse multiple or unresolved decisions. */
export function workflowReviewDecision(workflow: CompiledWorkflow, step: CompiledWorkflowStep, state: WorkflowMutableState): string | undefined {
  const decisions = new Set<string>(), visited = new Set<string>();
  const visitStep = (current: CompiledWorkflowStep): void => {
    if (visited.has(current.id)) return;
    visited.add(current.id);
    if (current.decision) { decisions.add(current.id); return; }
    for (const requirement of current.requiresDecisions) decisions.add(requirement.stepId);
    if (current.requiresDecisions.length) return;
    visitValue(current.input);
    visitValue(current.message?.vars);
  };
  const visitValue = (value: unknown): void => {
    if (typeof value === "string") {
      const id = /^\$steps\.([A-Za-z0-9_-]+)(?:\.|$)/.exec(value)?.[1];
      if (!id || state.steps[id]?.status !== "succeeded") return;
      const dependency = workflow.steps.find((candidate) => candidate.id === id);
      if (dependency) visitStep(dependency);
    } else if (Array.isArray(value)) value.forEach(visitValue);
    else if (value && typeof value === "object") Object.values(value).forEach(visitValue);
  };
  visitStep(step);
  const id = decisions.size === 1 ? [...decisions][0] : undefined;
  return id && state.decisions[id]?.status === "approved" ? id : undefined;
}
