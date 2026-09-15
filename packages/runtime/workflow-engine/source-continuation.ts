import type { CompanyOSArtifact } from "../../companyos-builder/types.ts";
import type { WorkflowRun, WorkflowMutableState } from "../../state-store/workflow-engine.ts";
import { sha256, canonicalJson, jsonDigest } from "../canonical.ts";

export const sourceContinuationOrigin = (runId: string) => `source-continuation:${sha256({ predecessor: runId })}`;
export const sourceContinuationRunId = (run: Pick<WorkflowRun, "instanceId" | "workflowId" | "runId">) =>
  `workflow:${sha256({ instanceId: run.instanceId, workflowId: run.workflowId, originKey: sourceContinuationOrigin(run.runId) })}`;

/** Never restart a possible writer, human collection, delegated child or model Tool conversation. */
export function assertUnwrittenSource(state: WorkflowMutableState, workflowId: string, artifact: CompanyOSArtifact) {
  const workflow = artifact.workflows?.find(item => item.id === workflowId);
  if (!workflow || !state.sourceAdmission || state.sourcePredecessor || state.sourceRestart
    || !["running", "waiting"].includes(state.status) || state.reviewDelivery || Object.keys(state.decisions).length)
    throw new Error("Source continuation requires an unfinished original source run without decisions or a prior continuation");
  for (const [id, result] of [...Object.entries(state.steps), ...(state.readRepairs ?? []).flatMap(repair => Object.entries(repair.steps))]) {
    const step = workflow.steps.find(item => item.id === id);
    // The engine persists an empty foreach input before completing it without Tool dispatch.
    // Require the full canonical proof, including archived repair snapshots.
    if (step?.kind === "effect" && step.forEach && !result.agent && !result.publicationRecoveries
      && result.status === "succeeded" && result.completedAt && result.inputDigest === jsonDigest([])
      && result.items && Object.keys(result.items).length === 0
      && canonicalJson(result.output) === canonicalJson({ items: [] })
      && Object.keys(result).every(key => ["status", "startedAt", "completedAt", "inputDigest", "items", "output"].includes(key))) continue;
    if (!step || result.agent || result.publicationRecoveries || !["compute", "route"].includes(step.kind) || step.maxRisk !== "R0"
      || (step.tool && (step.tool.risk !== "R0" || step.tool.capabilities.some(binding => !artifact.capabilityCatalog.some(capability =>
        capability.id === binding.id && capability.version === binding.version && capability.mode === "read" && capability.minimumRisk === "R0")))))
      throw new Error("Source continuation requires only attempted R0 computations and routing, without possible writes");
  }
}
export function validateSourceContinuation(state: WorkflowMutableState, previous: WorkflowMutableState | undefined, workflowId: string, artifact: CompanyOSArtifact) {
  const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const runId = (value: unknown) => typeof value === "string" && /^workflow:[a-f0-9]{64}$/.test(value);
  if (previous && canonicalJson(previous.sourcePredecessor ?? null) !== canonicalJson(state.sourcePredecessor ?? null)) throw new Error("Source predecessor is immutable");
  if (state.sourcePredecessor && (!state.sourceAdmission || Object.keys(state.sourcePredecessor).sort().join(",") !== "artifactHash,runId"
    || !runId(state.sourcePredecessor.runId) || !digest(state.sourcePredecessor.artifactHash))) throw new Error("Invalid source predecessor");
  if (previous?.sourceRestart && canonicalJson(previous.sourceRestart) !== canonicalJson(state.sourceRestart ?? null)) throw new Error("Source continuation is immutable");
  const restart = state.sourceRestart;
  if (!restart) return;
  if (Object.keys(restart).sort().join(",") !== "artifactHash,authorizedAt,principal,reasonDigest,successorRunId"
    || !runId(restart.successorRunId) || !digest(restart.artifactHash) || !digest(restart.reasonDigest)
    || typeof restart.principal !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/.test(restart.principal)
    || !Number.isFinite(Date.parse(restart.authorizedAt)) || new Date(restart.authorizedAt).toISOString() !== restart.authorizedAt
    || state.status !== "cancelled" || !state.sourceAdmission || state.sourcePredecessor) throw new Error("Invalid source continuation proof");
  if (previous && !previous.sourceRestart) {
    assertUnwrittenSource(previous, workflowId, artifact);
    const expected = { ...structuredClone(previous), status: "cancelled", sourceRestart: restart };
    delete expected.wait;
    if (canonicalJson(expected) !== canonicalJson(state)) throw new Error("Source continuation must preserve all original results, repairs and admission");
  }
}
