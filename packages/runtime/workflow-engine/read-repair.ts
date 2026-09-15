import type { CompanyOSArtifact } from "../../companyos-builder/types.ts";
import type { CompiledWorkflow } from "../../companyos-builder/workflow-types.ts";
import type { WorkflowMutableState, WorkflowReadRepair } from "../../state-store/workflow-engine.ts";
import { canonicalJson, sha256 } from "../canonical.ts";

export const MAX_WORKFLOW_READ_REPAIRS = 3;

/** Select an unbroken read-only path. Decisions, routing, waits and effects are never rewound. */
export function workflowReadRepairSteps(artifact: CompanyOSArtifact, workflow: CompiledWorkflow, from: string, through: string): string[] {
  const selected: string[] = [];
  let id = from;
  while (!selected.includes(id) && selected.length < workflow.steps.length) {
    const step = workflow.steps.find(candidate => candidate.id === id), tool = step?.tool;
    if (!step || step.kind !== "compute" || step.maxRisk !== "R0" || !tool || tool.risk !== "R0"
      || tool.capabilities.some(binding => !artifact.capabilityCatalog.some(capability => capability.id === binding.id
        && capability.version === binding.version && capability.mode === "read" && capability.minimumRisk === "R0"))) {
      throw new Error("Read repair requires a linear R0 Tool phase without effects, decisions or waits");
    }
    selected.push(id);
    if (id === through) return selected;
    if (step.next.length !== 1 || step.next[0] === "end") break;
    id = step.next[0]!;
  }
  throw new Error("Read repair does not reach the blocked step through one linear read phase");
}

export function prepareWorkflowReadRepair(args: { artifact: CompanyOSArtifact; workflow: CompiledWorkflow; state: WorkflowMutableState; fromStepId: string; principal: string; now: string; reason: string }): WorkflowMutableState {
  const { state, artifact, workflow } = args;
  if (state.status !== "waiting" || !state.blocked || state.cursor !== state.blocked.stepId || state.wait || state.reviewDelivery) throw new Error("Read repair requires a blocked Workflow without a pending wait or effect review");
  if ((state.readRepairs?.length ?? 0) >= MAX_WORKFLOW_READ_REPAIRS) throw new Error("Workflow read repair limit reached");
  if (typeof args.reason !== "string" || !/^[^\u0000-\u001f]{1,255}$/.test(args.reason)) throw new Error("Read repair needs a bounded reason");
  const ids = workflowReadRepairSteps(artifact, workflow, args.fromStepId, state.cursor);
  if (ids.some(id => !state.steps[id])) throw new Error("Read repair can only restart previously attempted steps");
  const next = structuredClone(state), repair: WorkflowReadRepair = {
    fromStepId: args.fromStepId, throughStepId: state.cursor, principal: args.principal, authorizedAt: args.now,
    reasonDigest: sha256(args.reason), blocked: structuredClone(state.blocked),
    steps: Object.fromEntries(ids.map(id => [id, structuredClone(state.steps[id]!)])),
  };
  next.readRepairs = [...(next.readRepairs ?? []), repair];
  for (const id of ids) delete next.steps[id];
  next.cursor = args.fromStepId; next.status = "running"; delete next.blocked;
  return next;
}

/** The sole exception to step retention is one exact, append-only read repair snapshot. */
export function validateWorkflowReadRepairs(state: WorkflowMutableState, workflow: CompiledWorkflow, artifact: CompanyOSArtifact, previous?: WorkflowMutableState): Set<string> {
  const history = state.readRepairs ?? [], prior = previous?.readRepairs ?? [];
  if (!Array.isArray(history) || history.length > MAX_WORKFLOW_READ_REPAIRS || history.length < prior.length
    || (previous && history.length > prior.length + 1)) throw new Error("Invalid bounded Workflow read repair history");
  for (const [index, repair] of history.entries()) {
    if (!repair || Object.keys(repair).sort().join(",") !== "authorizedAt,blocked,fromStepId,principal,reasonDigest,steps,throughStepId"
      || typeof repair.principal !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/.test(repair.principal)
      || !/^[a-f0-9]{64}$/.test(repair.reasonDigest) || !Number.isFinite(Date.parse(repair.authorizedAt))
      || new Date(repair.authorizedAt).toISOString() !== repair.authorizedAt || repair.blocked?.stepId !== repair.throughStepId) throw new Error("Invalid Workflow read repair evidence");
    const ids = workflowReadRepairSteps(artifact, workflow, repair.fromStepId, repair.throughStepId);
    if (!repair.steps || canonicalJson(Object.keys(repair.steps).sort()) !== canonicalJson([...ids].sort())) throw new Error("Read repair must retain every selected step");
    if (index < prior.length && canonicalJson(prior[index]) !== canonicalJson(repair)) throw new Error("Workflow read repair history is immutable");
  }
  if (history.length === prior.length || !previous) return new Set();
  const repair = history.at(-1)!;
  const expected = prepareWorkflowReadRepair({ artifact, workflow, state: previous, fromStepId: repair.fromStepId,
    principal: repair.principal, now: repair.authorizedAt, reason: "validated separately" });
  expected.readRepairs!.at(-1)!.reasonDigest = repair.reasonDigest;
  if (canonicalJson(expected) !== canonicalJson(state)) throw new Error("Read repair must archive exact prior outputs and change only the selected read phase");
  return new Set(Object.keys(repair.steps));
}
