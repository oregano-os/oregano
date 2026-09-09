import type { JsonValue } from "../../capabilities/contracts.ts";
import type { CompanyOSArtifact } from "../../companyos-builder/types.ts";
import type { CompiledWorkflow, CompiledWorkflowStep } from "../../companyos-builder/workflow-types.ts";
import type { StateStore } from "../../state-store/interface.ts";
import type { WorkflowRun } from "../../state-store/workflow-engine.ts";
import type { RosterMember } from "../../state-store/roster.ts";
import { jsonDigest } from "../canonical.ts";
import { workflowContext } from "./readers.ts";
import { workflowEffectKey, workflowExecutionStepId, workflowToolInput } from "./guard.ts";
import { resolveWorkflowValue } from "./references.ts";

/** Trusted provider implementation, never an operator-supplied assertion or a model decision. */
export type VerifyPublicationNotSent = (args: { artifact: CompanyOSArtifact; input: JsonValue; effect: Record<string, unknown> }) => Promise<JsonValue | undefined>;

export async function prepareDecisionRecovery(args: {
  run: WorkflowRun; artifact: CompanyOSArtifact; workflow: CompiledWorkflow; step: CompiledWorkflowStep;
  roster: RosterMember[]; control: StateStore; verify?: VerifyPublicationNotSent; now: string; principal: string;
}) {
  const { run, artifact, workflow, step, now } = args;
  const decision = run.state.decisions[step.id], ctx = workflowContext(run, args.roster);
  if (!args.verify || run.state.status !== "waiting" || run.state.blocked?.code !== "step-failed" || run.state.blocked.stepId !== step.id
    || !step.decision || step.tool?.runtimeId !== "oregano:communications/publish" || !decision || decision.status !== "pending" || decision.expiresAt <= now
    || decision.boundDigest !== jsonDigest(resolveWorkflowValue(step.decision.binds, workflow, ctx))) throw new Error("Recovery requires an unchanged, unexpired blocked pending decision and trusted no-send verification");
  const state = structuredClone(run.state), inputs: JsonValue[] = [];
  for (const recipient of decision.recipients) {
    if (Object.hasOwn(decision.deliveries, recipient)) continue;
    const context = { ...ctx, itemKey: recipient }, key = workflowEffectKey(artifact, context);
    const effect = await args.control.getEffect(key);
    if (!effect) continue; // This recipient has not attempted a send.
    const input = workflowToolInput(artifact, workflow, step, context), inputDigest = jsonDigest(input);
    if (ctx.publicationRecoveries?.[recipient] || effect.status !== "failed" || (effect.run_id ?? effect.runId) !== run.runId
      || (effect.step_id ?? effect.stepId) !== workflowExecutionStepId(step.id, recipient)
      || (effect.input_hash ?? effect.inputHash) !== inputDigest) throw new Error("Effect is not an unretried failed publication of the exact pending decision");
    const proof = await args.verify({ artifact, input, effect });
    if (proof === undefined) throw new Error("Provider could not prove that this publication was never sent");
    (state.steps[step.id]!.publicationRecoveries ??= {})[recipient] = { priorEffectKey: key, inputDigest, proof, principal: args.principal, authorizedAt: now };
    inputs.push(input);
  }
  if (!inputs.length) throw new Error("No failed unpublished decision needs recovery");
  delete state.blocked; delete state.wait; state.status = "running"; state.steps[step.id]!.status = "running";
  return { state, inputs };
}
