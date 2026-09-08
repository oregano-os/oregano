import { CapabilityEffectOutcomeUnknownError } from "../capabilities/contracts.ts";
import type {
  CapabilityBinding,
  CapabilityCallContext,
  CapabilityContract,
  CapabilityResult,
  Connector,
} from "../capabilities/contracts.ts";
import { validateJsonSchemaValue } from "../capabilities/validation.ts";
import { batchItemIds, capabilityEffectReview, matchingBatchReview } from "../capabilities/effect-review.ts";

export class ConnectorRegistry {
  readonly #contracts = new Map<string, CapabilityContract>();
  readonly #connectors = new Map<string, Connector>();
  readonly #bindings = new Map<string, CapabilityBinding>();

  constructor(args: {
    contracts: readonly CapabilityContract[];
    connectors: readonly Connector[];
    bindings: readonly CapabilityBinding[];
  }) {
    for (const contract of args.contracts) this.#contracts.set(contract.id, contract);
    for (const connector of args.connectors) {
      const key = `${connector.id}@${connector.version}`;
      if (this.#connectors.has(key)) throw new Error(`Duplicate Connector '${key}'.`);
      this.#connectors.set(key, connector);
    }
    for (const binding of args.bindings) {
      if (this.#bindings.has(binding.capability)) throw new Error(`Duplicate binding for '${binding.capability}'.`);
      this.#bindings.set(binding.capability, binding);
    }
  }

  async invoke(capability: string, input: unknown, context: CapabilityCallContext): Promise<CapabilityResult> {
    const contract = this.#contracts.get(capability);
    if (!contract) throw new Error(`Unknown Capability '${capability}'.`);
    const inputErrors = validateJsonSchemaValue(contract.inputSchema, input);
    if (inputErrors.length > 0) throw new Error(`Invalid input for '${capability}': ${inputErrors.join("; ")}`);
    const requestedIds = capability === "work-item.batch-update" ? batchItemIds(input) : undefined;
    if (capability === "work-item.batch-update" && !requestedIds) throw new Error("Batch request must contain unique bounded work-item identities");
    const binding = this.#bindings.get(capability);
    if (!binding) throw new Error(`Capability '${capability}' is not bound in this Instance.`);
    if (binding.contractVersion !== contract.version) throw new Error(`Binding for '${capability}' has incompatible contract version.`);
    const connector = this.#connectors.get(`${binding.connector}@${binding.connectorVersion}`);
    if (!connector) throw new Error(`Bound Connector '${binding.connector}@${binding.connectorVersion}' is unavailable.`);
    if (!connector.capabilities.includes(capability)) throw new Error(`Connector '${connector.id}' does not implement '${capability}'.`);
    const identity = { connector: connector.id, connector_version: connector.version, capability, contract_version: contract.version };
    const unknown = (message: string, evidence: unknown) => {
      const raw = evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence as Record<string, unknown> : {};
      const ids = requestedIds;
      const review = ids ? matchingBatchReview(raw.effect_review, ids) : capabilityEffectReview(raw.effect_review);
      return new CapabilityEffectOutcomeUnknownError(message, { ...identity, provider_evidence: evidence, ...(review ? { effect_review: review } : {}) });
    };
    let result: CapabilityResult;
    try { result = await connector.invoke(capability, input, context); }
    catch (error) {
      if (error instanceof CapabilityEffectOutcomeUnknownError) throw unknown(error.message, error.evidence);
      throw error;
    }
    const outputErrors = validateJsonSchemaValue(contract.outputSchema, result.output);
    if (outputErrors.length > 0) {
      const message = `Connector '${connector.id}' returned invalid '${capability}' output: ${outputErrors.join("; ")}`;
      if (contract.mode === "effect") throw unknown(message, { output: result.output, provider_evidence: result.evidence });
      throw new Error(message);
    }
    if (capability === "work-item.batch-update") {
      const output = result.output as { complete: boolean; results: Array<{ work_item_id?: unknown }> }, ids = requestedIds!;
      const returned = output.results.map((item) => item?.work_item_id);
      if (!output.complete || returned.length !== ids.length || new Set(returned).size !== ids.length || ids.some((id) => !returned.includes(id))) {
        throw unknown("Batch outcome is incomplete or does not account for every requested item; human review is required", result.evidence);
      }
    }
    return {
      output: result.output,
      evidence: {
        ...result.evidence,
        connector: connector.id,
        connector_version: connector.version,
        capability,
        contract_version: contract.version,
      },
    };
  }
}
