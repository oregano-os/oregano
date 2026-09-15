import type { CapabilityCallContext, CapabilityResult, Connector } from "../capabilities/contracts.ts";
import { validateJsonSchemaValue } from "../capabilities/validation.ts";
import type { CompanyOSArtifact } from "../companyos-builder/types.ts";
import { BrainError } from "../brain/contracts.ts";
import { BrainReads } from "../brain/reads.ts";
import { synthesizeBrain, type BrainSynthesisModel } from "../brain/synthesis.ts";
import { BRAIN_CAPABILITIES } from "../brain/tools.ts";
import { BrainRecoveryPendingError, type BrainWrites } from "../brain/writes.ts";
import { CapabilityEffectOutcomeUnknownError } from "../capabilities/contracts.ts";
import type { BrainRememberInput, BrainForgetInput } from "../brain/mutations.ts";
import { sha256 } from "../runtime/canonical.ts";

export class BrainConnector implements Connector {
  readonly id = "oregano/brain";
  readonly version = "0.1.0";
  readonly capabilities = BRAIN_CAPABILITIES.map(contract => contract.id);
  readonly artifact: CompanyOSArtifact;
  readonly reads: BrainReads;
  readonly model?: BrainSynthesisModel;
  readonly writes?: () => BrainWrites;
  constructor(args: { artifact: CompanyOSArtifact; reads: BrainReads; model?: BrainSynthesisModel; writes?: () => BrainWrites }) {
    if (!args.artifact.brain || args.artifact.brain.readingPolicy !== "company-wide" || args.reads.scope.instance_id !== args.artifact.instance.id) {
      throw new BrainError("adoption_required", "Brain needs a matching Instance and explicit Workspace reading policy.");
    }
    this.artifact = args.artifact; this.reads = new BrainReads(args.reads.store, args.reads.scope, args.artifact.brain.configurationDigest); this.model = args.model; this.writes = args.writes;
  }
  async invoke(capability: string, input: unknown, context: CapabilityCallContext): Promise<CapabilityResult> {
    return this.#execute(capability, input, context, false);
  }
  async reconcile(capability: string, input: unknown, context: CapabilityCallContext): Promise<CapabilityResult> {
    return this.#execute(capability, input, context, true);
  }
  async #execute(capability: string, input: unknown, context: CapabilityCallContext, recovery: boolean): Promise<CapabilityResult> {
    const contract = BRAIN_CAPABILITIES.find(contract => contract.id === capability);
    if (!contract) throw new BrainError("unsupported_operation", "Unknown Brain operation.");
    const agent = this.artifact.agents.find(agent => agent.id === context.agentId);
    const grant = agent?.toolSet.tools.find(tool => tool.runtimeId === context.toolId && tool.capabilities.some(bound => bound.id === capability));
    if (context.instanceId !== this.artifact.instance.id || !grant || context.subject?.status !== "active"
      || !context.subject.groupIds.includes("company:active")) throw new BrainError("access_denied", "Brain requires an active authenticated company subject and this Agent's effective Tool grant.");
    const errors = validateJsonSchemaValue(contract.inputSchema, input);
    if (errors.length) throw new BrainError("invalid_input", errors.join("; "));
    const value = input as Record<string, any>;
    if (capability === "brain.remember" || capability === "brain.forget") {
      if (!this.writes) throw new BrainError("write_binding_required", "This Instance has no qualified repository write binding.");
      const writes = this.writes();
      if (writes.options.scope.instance_id !== this.reads.scope.instance_id || writes.options.scope.repository_id !== this.reads.scope.repository_id
        || sha256(writes.options.configuration) !== this.artifact.brain!.configurationDigest) throw new BrainError("binding_mismatch", "Write binding and governed Brain configuration must match this Artifact.");
      let output;
      try {
        output = await writes.execute(capability === "brain.remember" ? "remember" : "forget", input as BrainRememberInput | BrainForgetInput, context,
          { only: recovery, fence: context.dispatchFence });
      } catch (error) {
        if (context.workflow && error instanceof CapabilityEffectOutcomeUnknownError) throw new BrainRecoveryPendingError(error.evidence);
        throw error;
      }
      if (context.workflow && output.sync_status === "pending") throw new BrainRecoveryPendingError({ operation_id: output.operation_id, saved_commit: output.saved_commit, sync_status: output.sync_status });
      return { output, evidence: { operation_id: output.operation_id, input_digest: sha256(input), result_digest: sha256(output),
        access_decision: { allowed: true, policy_digest: this.artifact.brain!.policyDigest, reason: "active-company-member-with-write-grant" } } };
    }
    if (recovery) throw new BrainError("unsupported_operation", "Only Brain writes have effect receipts to reconcile.");
    const output = capability === "brain.recall" ? await this.reads.recall(value as { query: string })
      : capability === "brain.entity" ? await this.reads.entity(value.name)
      : capability === "brain.context_pack" ? await this.reads.contextPack(value as { entities: string })
      : capability === "brain.delta" ? await this.reads.delta(value)
      : await synthesizeBrain(this.reads, value.question, context.agentId, this.model);
    return { output, evidence: { indexed_revision: output.indexed_revision, configuration_digest: this.artifact.brain!.configurationDigest,
      query_digest: sha256(input), result_digest: sha256(output), access_decision: { allowed: true, policy_digest: this.artifact.brain!.policyDigest, reason: "active-company-member" } } };
  }
}
