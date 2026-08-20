import type {
  CapabilityBinding,
  CapabilityCallContext,
  CapabilityContract,
  CapabilityResult,
  Connector,
} from "../capabilities/contracts.ts";
import { validateJsonSchemaValue } from "../capabilities/validation.ts";

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
    const binding = this.#bindings.get(capability);
    if (!binding) throw new Error(`Capability '${capability}' is not bound in this Instance.`);
    if (binding.contractVersion !== contract.version) throw new Error(`Binding for '${capability}' has incompatible contract version.`);
    const connector = this.#connectors.get(`${binding.connector}@${binding.connectorVersion}`);
    if (!connector) throw new Error(`Bound Connector '${binding.connector}@${binding.connectorVersion}' is unavailable.`);
    if (!connector.capabilities.includes(capability)) throw new Error(`Connector '${connector.id}' does not implement '${capability}'.`);
    const result = await connector.invoke(capability, input, context);
    const outputErrors = validateJsonSchemaValue(contract.outputSchema, result.output);
    if (outputErrors.length > 0) throw new Error(`Connector '${connector.id}' returned invalid '${capability}' output: ${outputErrors.join("; ")}`);
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
