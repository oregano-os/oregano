import {
  GitHubAppRepositoryProvider,
  createGitHubAppConfigurationFromEnvironment,
} from "../../../../connectors/github-repository.ts";
import { BuilderService } from "../../../../runtime/builder/service.ts";
import { TrustedGitProposalValidator } from "../../../../runtime/builder/workbench-validator.ts";
import { createPostgresBuilderJobStore } from "../../../../state-postgres/builder-job-store.ts";
import { createPostgresRepositoryInstallationStore } from "../../../../state-postgres/repository-installation-store.ts";
import { loadArtifact } from "../artifact.ts";
import { VercelSandboxBuilderExecutionAdapter } from "./sandbox-execution-adapter.ts";
import { VercelSandboxTrustedGitExecutionAdapter } from "./trusted-git-sandbox.ts";

let githubProvider: GitHubAppRepositoryProvider | undefined;
let builderService: BuilderService | undefined;
let trustedGitExecution: VercelSandboxTrustedGitExecutionAdapter | undefined;

export function getTrustedGitExecution(): VercelSandboxTrustedGitExecutionAdapter {
  trustedGitExecution ??= new VercelSandboxTrustedGitExecutionAdapter();
  return trustedGitExecution;
}

export function getGitHubRepositoryProvider(): GitHubAppRepositoryProvider {
  githubProvider ??= new GitHubAppRepositoryProvider({
    configuration: createGitHubAppConfigurationFromEnvironment(),
    installations: createPostgresRepositoryInstallationStore(),
    gitExecution: getTrustedGitExecution(),
  });
  return githubProvider;
}

export function getBuilderService(): BuilderService {
  if (builderService) return builderService;
  const artifact = loadArtifact();
  if (!artifact.builder) throw new Error("This Company Instance has no enabled Builder binding.");
  if (artifact.builder.execution.adapter !== "vercel-sandbox") {
    throw new Error(`Unsupported maintained Builder execution adapter '${artifact.builder.execution.adapter}'.`);
  }
  const repositoryProvider = getGitHubRepositoryProvider();
  builderService = new BuilderService({
    jobs: createPostgresBuilderJobStore(),
    source: repositoryProvider,
    execution: new VercelSandboxBuilderExecutionAdapter(),
    validator: new TrustedGitProposalValidator(getTrustedGitExecution()),
    publisher: repositoryProvider,
    configuration: artifact.builder,
  });
  return builderService;
}
