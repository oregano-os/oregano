import type { CapabilityCallContext, CapabilityResult, Connector } from "../capabilities/contracts.ts";
import { validateJsonSchemaValue } from "../capabilities/validation.ts";
import type { CompanyOSArtifact } from "../companyos-builder/types.ts";
import { BrainError } from "../brain/contracts.ts";
import { BrainReads } from "../brain/reads.ts";
import { synthesizeBrain, type BrainSynthesisModel } from "../brain/synthesis.ts";
import { BRAIN_READ_CAPABILITIES } from "../brain/tools.ts";
import { sha256 } from "../runtime/canonical.ts";

export class BrainConnector implements Connector {
  readonly id = "oregano/brain";
  readonly version = "0.1.0";
  readonly capabilities = BRAIN_READ_CAPABILITIES.map(contract => contract.id);
  readonly artifact: CompanyOSArtifact;
  readonly reads: BrainReads;
  readonly model?: BrainSynthesisModel;
  constructor(args: { artifact: CompanyOSArtifact; reads: BrainReads; model?: BrainSynthesisModel }) {
    if (!args.artifact.brain || args.artifact.brain.readingPolicy !== "company-wide" || args.reads.scope.instance_id !== args.artifact.instance.id) {
      throw new BrainError("adoption_required", "Brain needs a matching Instance and explicit Workspace reading policy.");
    }
    this.artifact = args.artifact; this.reads = new BrainReads(args.reads.store, args.reads.scope, args.artifact.brain.configurationDigest); this.model = args.model;
  }
  async invoke(capability: string, input: unknown, context: CapabilityCallContext): Promise<CapabilityResult> {
    const contract = BRAIN_READ_CAPABILITIES.find(contract => contract.id === capability);
    if (!contract) throw new BrainError("unsupported_operation", "Unknown Brain read operation.");
    const agent = this.artifact.agents.find(agent => agent.id === context.agentId);
    const grant = agent?.toolSet.tools.find(tool => tool.runtimeId === context.toolId && tool.capabilities.some(bound => bound.id === capability));
    if (context.instanceId !== this.artifact.instance.id || !grant || context.subject?.status !== "active"
      || !context.subject.groupIds.includes("company:active")) throw new BrainError("access_denied", "Brain requires an active authenticated company subject and this Agent's effective Tool grant.");
    const errors = validateJsonSchemaValue(contract.inputSchema, input);
    if (errors.length) throw new BrainError("invalid_input", errors.join("; "));
    const value = input as Record<string, any>;
    const output = capability === "brain.recall" ? await this.reads.recall(value as { query: string })
      : capability === "brain.entity" ? await this.reads.entity(value.name)
      : capability === "brain.context_pack" ? await this.reads.contextPack(value as { entities: string })
      : await synthesizeBrain(this.reads, value.question, context.agentId, this.model);
    if (output.indexed_revision.configuration_digest !== this.artifact.brain!.configurationDigest) {
      throw new BrainError("sync_required", "The Brain projection has not indexed the deployed configuration yet.");
    }
    return { output, evidence: { indexed_revision: output.indexed_revision, configuration_digest: this.artifact.brain!.configurationDigest,
      query_digest: sha256(input), result_digest: sha256(output), access_decision: { allowed: true, policy_digest: this.artifact.brain!.policyDigest, reason: "active-company-member" } } };
  }
}
