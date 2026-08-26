import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  GitHubAppRepositoryProvider,
  createGitHubAppConfigurationFromEnvironment,
} from "../../../../connectors/github-repository.ts";
import { BuilderService } from "../../../../runtime/builder/service.ts";
import { CompanyOSWorkbenchProposalValidator } from "../../../../runtime/builder/workbench-validator.ts";
import { createPostgresBuilderJobStore } from "../../../../state-postgres/builder-job-store.ts";
import { createPostgresRepositoryInstallationStore } from "../../../../state-postgres/repository-installation-store.ts";
import { loadArtifact } from "../artifact.ts";
import { VercelSandboxBuilderExecutionAdapter } from "./sandbox-execution-adapter.ts";

let githubProvider: GitHubAppRepositoryProvider | undefined;
let builderService: BuilderService | undefined;

export function getGitHubRepositoryProvider(): GitHubAppRepositoryProvider {
  githubProvider ??= new GitHubAppRepositoryProvider({
    configuration: createGitHubAppConfigurationFromEnvironment(),
    installations: createPostgresRepositoryInstallationStore(),
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
    validator: new CompanyOSWorkbenchProposalValidator({ cliPath: resolveWorkbenchCli() }),
    publisher: repositoryProvider,
    configuration: artifact.builder,
  });
  return builderService;
}

function resolveWorkbenchCli(): string {
  const candidates = [
    resolve(process.cwd(), "packages/cli/src/cli.mjs"),
    resolve(process.cwd(), "../cli/src/cli.mjs"),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error("The version-pinned CompanyOS Workbench CLI is unavailable in the Builder coordinator.");
  return path;
}
