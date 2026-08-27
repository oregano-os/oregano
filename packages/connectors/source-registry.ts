import { sha256 } from "../runtime/canonical.ts";
import type {
  KnowledgeSourceBinding,
  KnowledgeSourceConnector,
  KnowledgeSourceRequirement,
} from "../knowledge/source-contracts.ts";
import {
  SOURCE_CONNECTOR_V1_CONTRACT_VERSION,
  SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
  adaptRepositorySourceV1,
  assertSourceConnectorSupportsV2,
  validateSourceBindingV2,
  validateSourceRequirementV2,
  type SourceBindingV2,
  type SourceConnectorDescriptorV2,
  type SourceConnectorV2,
  type SourceDeliveryMode,
  type SourceKind,
  type SourceReceiptV2,
  type SourceRequirementV2,
} from "../knowledge/source-contracts-v2.ts";
import type { SourceRawAssetStager } from "../knowledge/source-pipeline-store.ts";

export type SourceConnectorOperation = "inspect" | "verify" | "health" | "sync" | "revoke";
export type SupportedSourceRequirement = KnowledgeSourceRequirement | SourceRequirementV2;
export type SupportedSourceBinding = KnowledgeSourceBinding | SourceBindingV2;
export type SupportedSourceConnector = KnowledgeSourceConnector | SourceConnectorV2;

export interface SourceConnectorFactoryEnvironment {
  resolveSecret(reference: string): string | Promise<string>;
  fetch?: typeof globalThis.fetch;
  now?: () => string;
  retryDelay?: (milliseconds: number) => Promise<void>;
  rawAssetStager?: SourceRawAssetStager;
}

export interface SourceConnectorRegistryDescriptor extends SourceConnectorDescriptorV2 {
  acceptedInputContractVersions: Array<
    typeof SOURCE_CONNECTOR_V1_CONTRACT_VERSION | typeof SOURCE_CONNECTOR_V2_CONTRACT_VERSION
  >;
  legacyV1Compatibility: boolean;
}

export interface SourceConnectorRegistration {
  descriptor: SourceConnectorRegistryDescriptor;
  create(input: {
    requirement: SupportedSourceRequirement;
    binding: SupportedSourceBinding;
    normalizedRequirement: SourceRequirementV2;
    normalizedBinding: SourceBindingV2;
    environment: SourceConnectorFactoryEnvironment;
  }): SupportedSourceConnector;
}

export interface SourceConnectorResolution {
  connector: SupportedSourceConnector;
  descriptor: SourceConnectorRegistryDescriptor;
  requirement: SupportedSourceRequirement;
  binding: SupportedSourceBinding;
  normalizedRequirement: SourceRequirementV2;
  normalizedBinding: SourceBindingV2;
  compatibility: "native-v2" | "repository-v1";
  receipt: SourceReceiptV2;
}

const isV1Requirement = (value: SupportedSourceRequirement): value is KnowledgeSourceRequirement => value.version === 1;
const isV1Binding = (value: SupportedSourceBinding): value is KnowledgeSourceBinding => value.version === 1;

const connectorIdentity = (connector: SupportedSourceConnector): {
  connectorId: string;
  connectorVersion: string;
  sourceId: string;
} => "descriptor" in connector
  ? {
      connectorId: connector.descriptor.connectorId,
      connectorVersion: connector.descriptor.connectorVersion,
      sourceId: connector.sourceId,
    }
  : { connectorId: connector.id, connectorVersion: connector.version, sourceId: connector.sourceId };

const validateDescriptor = (descriptor: SourceConnectorRegistryDescriptor): void => {
  if (!descriptor.connectorId.trim() || !descriptor.connectorVersion.trim()) throw new Error("Source Connector descriptor requires an exact Connector identity and version.");
  if (descriptor.contractVersion !== SOURCE_CONNECTOR_V2_CONTRACT_VERSION) throw new Error(`Source Connector '${descriptor.connectorId}' descriptor must use registry contract ${SOURCE_CONNECTOR_V2_CONTRACT_VERSION}.`);
  if (!/^[a-f0-9]{64}$/.test(descriptor.implementationDigest)) throw new Error(`Source Connector '${descriptor.connectorId}' has an invalid implementation digest.`);
  if (descriptor.sourceKinds.length === 0 || descriptor.deliveryModes.length === 0 || descriptor.acceptedInputContractVersions.length === 0) throw new Error(`Source Connector '${descriptor.connectorId}' descriptor has an empty compatibility declaration.`);
  if (new Set(descriptor.sourceKinds).size !== descriptor.sourceKinds.length || new Set(descriptor.deliveryModes).size !== descriptor.deliveryModes.length || new Set(descriptor.acceptedInputContractVersions).size !== descriptor.acceptedInputContractVersions.length) throw new Error(`Source Connector '${descriptor.connectorId}' descriptor contains duplicate compatibility values.`);
  if (descriptor.legacyV1Compatibility !== descriptor.acceptedInputContractVersions.includes(SOURCE_CONNECTOR_V1_CONTRACT_VERSION)) throw new Error(`Source Connector '${descriptor.connectorId}' has inconsistent V1 compatibility metadata.`);
};

export class SourceConnectorRegistry {
  readonly #registrations = new Map<string, SourceConnectorRegistration>();
  readonly #environment: SourceConnectorFactoryEnvironment;

  constructor(input: {
    registrations: readonly SourceConnectorRegistration[];
    environment: SourceConnectorFactoryEnvironment;
  }) {
    this.#environment = input.environment;
    for (const registration of input.registrations) {
      validateDescriptor(registration.descriptor);
      const key = `${registration.descriptor.connectorId}@${registration.descriptor.connectorVersion}`;
      if (this.#registrations.has(key)) throw new Error(`Duplicate Source Connector registration '${key}'.`);
      this.#registrations.set(key, registration);
    }
  }

  descriptors(): SourceConnectorRegistryDescriptor[] {
    return [...this.#registrations.values()]
      .map((entry) => structuredClone(entry.descriptor))
      .sort((left, right) => left.connectorId.localeCompare(right.connectorId) || left.connectorVersion.localeCompare(right.connectorVersion));
  }

  resolve(input: {
    requirement: SupportedSourceRequirement;
    binding: SupportedSourceBinding;
    operation: SourceConnectorOperation;
    observedAt?: string;
  }): SourceConnectorResolution {
    const requirementIsV1 = isV1Requirement(input.requirement);
    const bindingIsV1 = isV1Binding(input.binding);
    if (requirementIsV1 !== bindingIsV1) throw new Error("Source requirement and binding contract versions differ.");

    let normalizedRequirement: SourceRequirementV2;
    let normalizedBinding: SourceBindingV2;
    let compatibility: SourceConnectorResolution["compatibility"];
    let acceptedInputContractVersion: typeof SOURCE_CONNECTOR_V1_CONTRACT_VERSION | typeof SOURCE_CONNECTOR_V2_CONTRACT_VERSION;
    if (requirementIsV1 && bindingIsV1) {
      const adapted = adaptRepositorySourceV1(
        input.requirement as KnowledgeSourceRequirement,
        input.binding as KnowledgeSourceBinding,
        input.observedAt,
      );
      normalizedRequirement = adapted.requirement;
      normalizedBinding = adapted.binding;
      compatibility = "repository-v1";
      acceptedInputContractVersion = SOURCE_CONNECTOR_V1_CONTRACT_VERSION;
    } else {
      normalizedRequirement = validateSourceRequirementV2(input.requirement);
      normalizedBinding = validateSourceBindingV2(input.binding, normalizedRequirement);
      compatibility = "native-v2";
      acceptedInputContractVersion = SOURCE_CONNECTOR_V2_CONTRACT_VERSION;
    }

    const key = `${normalizedBinding.connectorId}@${normalizedBinding.connectorVersion}`;
    const registration = this.#registrations.get(key);
    if (!registration) throw new Error(`Bound Source Connector '${key}' is unavailable.`);
    const descriptor = registration.descriptor;
    if (!descriptor.acceptedInputContractVersions.includes(acceptedInputContractVersion)) throw new Error(`Source Connector '${key}' does not accept Source contract '${acceptedInputContractVersion}'.`);
    if (compatibility === "repository-v1" && !descriptor.legacyV1Compatibility) throw new Error(`Source Connector '${key}' has no explicit repository V1 compatibility registration.`);
    if (!descriptor.sourceKinds.includes(normalizedRequirement.sourceKind)) throw new Error(`Source Connector '${key}' does not support Source kind '${normalizedRequirement.sourceKind}'.`);
    if (!descriptor.deliveryModes.includes(normalizedRequirement.deliveryMode)) throw new Error(`Source Connector '${key}' does not support delivery mode '${normalizedRequirement.deliveryMode}'.`);

    if (compatibility === "native-v2") {
      assertSourceConnectorSupportsV2({ descriptor, requirement: normalizedRequirement, binding: normalizedBinding });
      if (normalizedBinding.state === "revoked") throw new Error(`Source binding '${normalizedBinding.sourceId}' is revoked.`);
      if (input.operation === "sync" && normalizedBinding.state !== "active") throw new Error(`Source binding '${normalizedBinding.sourceId}' is not active for ingestion.`);
      if (input.operation === "sync" && !normalizedBinding.qualification) throw new Error(`Source binding '${normalizedBinding.sourceId}' is not qualified for ingestion.`);
      if (input.operation === "health" && normalizedBinding.state === "bound") throw new Error(`Source binding '${normalizedBinding.sourceId}' is not qualified for health evaluation.`);
    }

    const connector = registration.create({
      requirement: input.requirement,
      binding: input.binding,
      normalizedRequirement,
      normalizedBinding,
      environment: this.#environment,
    });
    const identity = connectorIdentity(connector);
    if (identity.connectorId !== descriptor.connectorId || identity.connectorVersion !== descriptor.connectorVersion || identity.sourceId !== normalizedRequirement.sourceId) throw new Error(`Source Connector factory '${key}' returned a mismatched implementation identity.`);

    const observedAt = input.observedAt ?? this.#environment.now?.() ?? new Date().toISOString();
    const evidenceDigest = sha256({
      sourceId: normalizedRequirement.sourceId,
      connectorId: descriptor.connectorId,
      connectorVersion: descriptor.connectorVersion,
      implementationDigest: descriptor.implementationDigest,
      inputContractVersion: acceptedInputContractVersion,
      targetContractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
      sourceKind: normalizedRequirement.sourceKind,
      deliveryMode: normalizedRequirement.deliveryMode,
      bindingState: normalizedBinding.state,
      operation: input.operation,
      compatibility,
    });
    const receipt: SourceReceiptV2 = {
      contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
      receiptId: sha256({ sourceId: normalizedRequirement.sourceId, operation: "resolve", observedAt, evidenceDigest }),
      sourceId: normalizedRequirement.sourceId,
      connectorId: descriptor.connectorId,
      connectorVersion: descriptor.connectorVersion,
      operation: "resolve",
      outcome: "succeeded",
      observedAt,
      evidenceDigest,
      reasonCode: compatibility === "repository-v1" ? "repository-v1-compatibility" : "native-v2-exact-binding",
    };
    return {
      connector,
      descriptor: structuredClone(descriptor),
      requirement: input.requirement,
      binding: input.binding,
      normalizedRequirement,
      normalizedBinding,
      compatibility,
      receipt,
    };
  }
}

export function sourceConnectorDescriptor(input: {
  connectorId: string;
  connectorVersion: string;
  sourceKinds: SourceKind[];
  deliveryModes: SourceDeliveryMode[];
  acceptedInputContractVersions: SourceConnectorRegistryDescriptor["acceptedInputContractVersions"];
  legacyV1Compatibility?: boolean;
  implementationIdentity: unknown;
}): SourceConnectorRegistryDescriptor {
  return {
    connectorId: input.connectorId,
    connectorVersion: input.connectorVersion,
    contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
    sourceKinds: [...input.sourceKinds],
    deliveryModes: [...input.deliveryModes],
    acceptedInputContractVersions: [...input.acceptedInputContractVersions],
    legacyV1Compatibility: input.legacyV1Compatibility ?? false,
    implementationDigest: sha256({
      connectorId: input.connectorId,
      connectorVersion: input.connectorVersion,
      implementationIdentity: input.implementationIdentity,
    }),
  };
}
