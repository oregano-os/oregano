import { generateText } from "ai";
import type { CompanyOSArtifact, RuntimeConnectorConfiguration } from "../../../companyos-builder/types.ts";
import { BrainError } from "../../../brain/contracts.ts";
import { BrainReads } from "../../../brain/reads.ts";
import { parseBrainRepositoryBinding } from "../../../brain/repository-binding.ts";
import { syncBrain } from "../../../brain/sync.ts";
import { BrainConnector } from "../../../connectors/brain.ts";
import { GitHubAppRepositoryProvider, createGitHubAppConfigurationFromEnvironment } from "../../../connectors/github-repository.ts";
import { PostgresBrainStore } from "../../../state-postgres/brain-store.ts";
import { qualifyCompanyDatabase } from "../../../state-postgres/database-bootstrap.ts";
import { createPostgresCompanyRecordsStore } from "../../../state-postgres/records-store.ts";
import { createPostgresRepositoryInstallationStore } from "../../../state-postgres/repository-installation-store.ts";
import { createLanguageGenerator } from "./language-generation.ts";
import { resolveModelExecution } from "./model-execution.ts";

export function brainRuntimeBinding(artifact: CompanyOSArtifact, entry: RuntimeConnectorConfiguration) {
  if (entry.connector !== "oregano/brain" || entry.connectorVersion !== "0.1.0" || !artifact.brain) throw new BrainError("adoption_required", "Brain needs Workspace adoption and a supported Instance connector binding.");
  const binding = parseBrainRepositoryBinding(entry.configuration, artifact.instance.id);
  return { binding, scope: { instance_id: binding.instanceId, repository_id: binding.repositoryId } };
}

export function createRuntimeBrainConnector(artifact: CompanyOSArtifact, entry: RuntimeConnectorConfiguration, environment: NodeJS.ProcessEnv = process.env) {
  const { scope } = brainRuntimeBinding(artifact, entry);
  return new BrainConnector({ artifact, reads: new BrainReads(new PostgresBrainStore(), scope), model: {
    prepare() {
      // Selection failures stay outside synthesis' extractive fallback. Reuse the
      // existing model runtime; one prepared selection produces exactly one call.
      const execution = resolveModelExecution({ profile: "reasoning", task: "brain.synthesize", requiredCapability: "language", environment });
      return createLanguageGenerator({ resolve: () => execution, generate: generateText });
    },
  } });
}

/** Trusted operator path. Schema qualification is read-only; migration is explicit. */
export async function syncRuntimeBrain(artifact: CompanyOSArtifact, entry: RuntimeConnectorConfiguration) {
  const { binding, scope } = brainRuntimeBinding(artifact, entry);
  await qualifyCompanyDatabase();
  const repository = new GitHubAppRepositoryProvider({ configuration: createGitHubAppConfigurationFromEnvironment(),
    installations: createPostgresRepositoryInstallationStore() });
  return syncBrain({ scope, configuration: artifact.brain!.configuration, store: new PostgresBrainStore(),
    leases: createPostgresCompanyRecordsStore(), repository: {
      revision: () => repository.brainRevision(binding), read: revision => repository.brainFiles(binding, revision),
    } });
}
