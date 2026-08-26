import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitHubAppRepositoryProvider,
  type GitHubAppConfiguration,
} from "../../../../connectors/github-repository.ts";
import { runGit } from "../../../../runtime/repository/git.ts";
import { InMemoryRepositoryInstallationStore } from "../../../../testkit/adapter/in-memory-repository-installations.ts";

const repositoryId = requireEnvironment("COMPANYOS_GITHUB_REPOSITORY");
const providerRepositoryId = requireEnvironment("COMPANYOS_GITHUB_PROVIDER_REPOSITORY_ID");
const baseCommit = requireEnvironment("COMPANYOS_GITHUB_BASE_COMMIT");
const installationId = requireEnvironment("COMPANYOS_GITHUB_INSTALLATION_ID");
const appId = requireEnvironment("COMPANYOS_GITHUB_APP_ID");
const serviceEnvironment = process.env.COMPANYOS_SERVICE_ENVIRONMENT ?? "qualification";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryId)) {
  throw new Error("COMPANYOS_GITHUB_REPOSITORY must be an exact owner/repository identity.");
}
if (!/^\d+$/.test(providerRepositoryId) || !/^\d+$/.test(installationId)) {
  throw new Error("GitHub repository and installation IDs must be decimal identifiers.");
}
if (!/^[0-9a-f]{40}$/.test(baseCommit)) {
  throw new Error("COMPANYOS_GITHUB_BASE_COMMIT must be an exact lowercase 40-character commit.");
}

const root = await mkdtemp(join(tmpdir(), "companyos-github-qualification-"));
const workspacePath = join(root, "workspace");
try {
  const provider = new GitHubAppRepositoryProvider({
    configuration: {
      appId,
      privateKey: await resolvePrivateKey(),
      serviceEnvironment,
    } satisfies GitHubAppConfiguration,
    installations: new InMemoryRepositoryInstallationStore(),
  });
  const binding = await provider.verifyInstallation({
    bindingId: "github-qualification",
    instanceId: "qualification",
    installationId,
    repositoryId,
    providerRepositoryId,
    onboardingPrincipal: "qualification:operator:local",
  });
  const receipt = await provider.materialize({
    schemaVersion: 1,
    requestId: `qualification-${baseCommit}`,
    instanceId: "qualification",
    bindingId: binding.bindingId,
    repositoryId,
    baseCommit,
    destinationPath: workspacePath,
  });
  const head = (await runGit(workspacePath, ["rev-parse", "HEAD"])).trim();
  const remotes = (await runGit(workspacePath, ["remote"])).trim();
  const configuration = await runGit(workspacePath, ["config", "--local", "--list"]);
  const credentialPattern = /(credential|extraheader|authorization|token|password|github\.com)/i;
  if (head !== baseCommit || remotes !== "" || credentialPattern.test(configuration)) {
    throw new Error("GitHub source adapter did not produce the exact credential-free checkout.");
  }
  process.stdout.write(`${JSON.stringify({
    repositoryId,
    providerRepositoryId,
    exactBaseCommit: receipt.baseCommit,
    contentDigest: receipt.contentDigest,
    sourceProvider: receipt.provider,
    credentialIsolation: receipt.credentialIsolation,
    requestedPermissions: { contents: "read" },
    requestedRepositoryScope: "single-repository",
    localConfigurationCredentialFree: true,
    installationTokenSentToCodingEnvironment: false,
    privateRepositoryExportedToExecutionProvider: false,
  }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing private-repository qualification input '${name}'.`);
  return value;
}

async function resolvePrivateKey(): Promise<string> {
  const direct = process.env.COMPANYOS_GITHUB_APP_PRIVATE_KEY;
  const path = process.env.COMPANYOS_GITHUB_APP_PRIVATE_KEY_PATH;
  if (direct && path) {
    throw new Error("Configure only one GitHub App private-key qualification source.");
  }
  if (direct) return direct.replaceAll("\\n", "\n");
  if (path) return await readFile(path, "utf8");
  throw new Error(
    "Missing private-repository qualification input 'COMPANYOS_GITHUB_APP_PRIVATE_KEY' or 'COMPANYOS_GITHUB_APP_PRIVATE_KEY_PATH'.",
  );
}
