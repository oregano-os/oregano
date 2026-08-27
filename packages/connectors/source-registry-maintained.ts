import {
  SOURCE_CONNECTOR_V1_CONTRACT_VERSION,
  SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
} from "../knowledge/source-contracts-v2.ts";
import { GitHubKnowledgeSourceConnectorV2 } from "./github-knowledge-source-v2.ts";
import { GranolaKnowledgeSourceConnectorV2 } from "./granola-knowledge-source-v2.ts";
import { LocalFileKnowledgeSourceConnectorV2 } from "./local-file-knowledge-source-v2.ts";
import {
  SourceConnectorRegistry,
  sourceConnectorDescriptor,
  type SourceConnectorFactoryEnvironment,
  type SourceConnectorRegistration,
} from "./source-registry.ts";

export const GITHUB_SOURCE_V1_DESCRIPTOR = sourceConnectorDescriptor({
  connectorId: "oregano/github-repository-source",
  connectorVersion: "1.0.0",
  sourceKinds: ["repository"],
  deliveryModes: ["pull"],
  acceptedInputContractVersions: [SOURCE_CONNECTOR_V1_CONTRACT_VERSION],
  legacyV1Compatibility: true,
  implementationIdentity: "core-maintained-github-repository-source-v1-through-v2-pipeline",
});

export const GITHUB_SOURCE_V2_DESCRIPTOR = sourceConnectorDescriptor({
  connectorId: "oregano/github-repository-source",
  connectorVersion: "2.0.0",
  sourceKinds: ["repository"],
  deliveryModes: ["pull"],
  acceptedInputContractVersions: [SOURCE_CONNECTOR_V2_CONTRACT_VERSION],
  implementationIdentity: "core-maintained-github-repository-source-v2",
});

export const GRANOLA_SOURCE_V2_DESCRIPTOR = sourceConnectorDescriptor({
  connectorId: "oregano/granola-meeting-source",
  connectorVersion: "2.0.0",
  sourceKinds: ["meeting"],
  deliveryModes: ["hybrid"],
  acceptedInputContractVersions: [SOURCE_CONNECTOR_V2_CONTRACT_VERSION],
  implementationIdentity: "core-maintained-granola-meeting-source-v2",
});

export const LOCAL_FILE_SOURCE_V2_DESCRIPTOR = sourceConnectorDescriptor({
  connectorId: "oregano/local-file-source",
  connectorVersion: "2.0.0",
  sourceKinds: ["local-file"],
  deliveryModes: ["pull"],
  acceptedInputContractVersions: [SOURCE_CONNECTOR_V2_CONTRACT_VERSION],
  implementationIdentity: "core-maintained-exact-local-file-source-v2",
});

export function maintainedSourceConnectorRegistrations(): SourceConnectorRegistration[] {
  return [
    {
      descriptor: GITHUB_SOURCE_V1_DESCRIPTOR,
      create: ({ normalizedRequirement, normalizedBinding, environment }) => new GitHubKnowledgeSourceConnectorV2({
        requirement: normalizedRequirement,
        binding: normalizedBinding,
        descriptor: GITHUB_SOURCE_V1_DESCRIPTOR,
        resolveSecret: environment.resolveSecret,
        fetch: environment.fetch,
        now: environment.now,
        retryDelay: environment.retryDelay,
      }),
    },
    {
      descriptor: GITHUB_SOURCE_V2_DESCRIPTOR,
      create: ({ normalizedRequirement, normalizedBinding, environment }) => new GitHubKnowledgeSourceConnectorV2({
        requirement: normalizedRequirement,
        binding: normalizedBinding,
        descriptor: GITHUB_SOURCE_V2_DESCRIPTOR,
        resolveSecret: environment.resolveSecret,
        fetch: environment.fetch,
        now: environment.now,
        retryDelay: environment.retryDelay,
      }),
    },
    {
      descriptor: GRANOLA_SOURCE_V2_DESCRIPTOR,
      create: ({ normalizedRequirement, normalizedBinding, environment }) => new GranolaKnowledgeSourceConnectorV2({
        requirement: normalizedRequirement,
        binding: normalizedBinding,
        descriptor: GRANOLA_SOURCE_V2_DESCRIPTOR,
        resolveSecret: environment.resolveSecret,
        fetch: environment.fetch,
        now: environment.now,
        retryDelay: environment.retryDelay,
        rawAssetStager: environment.rawAssetStager,
      }),
    },
    {
      descriptor: LOCAL_FILE_SOURCE_V2_DESCRIPTOR,
      create: ({ normalizedRequirement, normalizedBinding, environment }) => new LocalFileKnowledgeSourceConnectorV2({
        requirement: normalizedRequirement,
        binding: normalizedBinding,
        descriptor: LOCAL_FILE_SOURCE_V2_DESCRIPTOR,
        now: environment.now,
      }),
    },
  ];
}

export function createMaintainedSourceConnectorRegistry(environment: SourceConnectorFactoryEnvironment): SourceConnectorRegistry {
  return new SourceConnectorRegistry({
    registrations: maintainedSourceConnectorRegistrations(),
    environment,
  });
}
