import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertProposalPublicationRequest,
  assertRepositorySourceRequest,
  type ProposalPublicationReceipt,
  type ProposalPublicationRequest,
  type ProposalPublisher,
  type RepositorySourceAdapter,
  type RepositorySourceReceipt,
  type RepositorySourceRequest,
} from "../runtime/repository/contracts.ts";
import {
  applyGitPatch,
  assertMatchingSourceReceipt,
  assertRepositoryDestinationAbsent,
  assertSanitizedMaterializedCheckout,
  readExistingSourceReceipt,
  runGit,
  sanitizeMaterializedCheckout,
  writeSourceReceipt,
} from "../runtime/repository/git.ts";
import { inspectProposalWorkspace, sha256 } from "../runtime/repository/proposal-inspection.ts";
import type {
  TrustedGitCredentialBinding,
  TrustedGitExecutionAdapter,
} from "../runtime/repository/trusted-git-execution.ts";
import type {
  RepositoryInstallationBinding,
  RepositoryInstallationStatus,
  RepositoryInstallationStore,
} from "../state-store/repository-installations.ts";

export interface GitHubAppConfiguration {
  readonly appId: string;
  readonly privateKey: string;
  readonly serviceEnvironment: string;
  readonly apiBaseUrl?: string;
  readonly webBaseUrl?: string;
}

export interface VerifyGitHubInstallationInput {
  readonly bindingId: string;
  readonly instanceId: string;
  readonly installationId: string;
  readonly repositoryId: string;
  readonly providerRepositoryId: string;
  readonly onboardingPrincipal: string;
}

interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  owner: { login: string };
}

interface InstallationToken {
  token: string;
  expiresAt: string;
}

type GitHubPermission = "read" | "write";

export class GitHubAppRepositoryProvider implements RepositorySourceAdapter, ProposalPublisher {
  readonly id = "github-app";
  readonly version = "1.0.0";
  readonly #configuration: Required<Pick<GitHubAppConfiguration, "apiBaseUrl" | "webBaseUrl">>
    & Omit<GitHubAppConfiguration, "apiBaseUrl" | "webBaseUrl">;
  readonly #installations: RepositoryInstallationStore;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #gitExecution: TrustedGitExecutionAdapter | undefined;

  constructor(args: {
    configuration: GitHubAppConfiguration;
    installations: RepositoryInstallationStore;
    gitExecution?: TrustedGitExecutionAdapter;
    fetch?: typeof fetch;
    now?: () => Date;
  }) {
    if (!/^\d+$/.test(args.configuration.appId)) throw new Error("GitHub App id must be numeric.");
    if (!args.configuration.privateKey.includes("PRIVATE KEY")) {
      throw new Error("GitHub App private key is invalid.");
    }
    if (!args.configuration.serviceEnvironment) throw new Error("GitHub App service environment is required.");
    this.#configuration = {
      ...args.configuration,
      apiBaseUrl: args.configuration.apiBaseUrl ?? "https://api.github.com",
      webBaseUrl: args.configuration.webBaseUrl ?? "https://github.com",
    };
    this.#installations = args.installations;
    this.#gitExecution = args.gitExecution;
    this.#fetch = args.fetch ?? fetch;
    this.#now = args.now ?? (() => new Date());
  }

  async verifyInstallation(
    input: VerifyGitHubInstallationInput,
  ): Promise<RepositoryInstallationBinding> {
    for (const [label, value] of Object.entries(input)) {
      if (!value || value.length > 512) throw new Error(`GitHub installation ${label} is invalid.`);
    }
    const installation = await this.#appRequest<Record<string, any>>(
      "GET",
      `/app/installations/${encodeURIComponent(input.installationId)}`,
    );
    if (String(installation.id) !== input.installationId) {
      throw new Error("GitHub returned a different installation identity.");
    }
    const repository = await this.#withInstallationToken(
      input.installationId,
      input.providerRepositoryId,
      { contents: "read" },
      (token) => this.#installationRequest<GitHubRepository>(
        token,
        "GET",
        `/repositories/${encodeURIComponent(input.providerRepositoryId)}`,
      ),
    );
    if (String(repository.id) !== input.providerRepositoryId || repository.full_name !== input.repositoryId) {
      throw new Error("GitHub installation does not authorize the selected repository identity.");
    }
    const timestamp = this.#now().toISOString();
    return await this.#installations.putVerified({
      bindingId: input.bindingId,
      instanceId: input.instanceId,
      providerId: this.id,
      serviceEnvironment: this.#configuration.serviceEnvironment,
      installationId: input.installationId,
      providerRepositoryId: input.providerRepositoryId,
      repositoryId: input.repositoryId,
      owner: repository.owner.login,
      name: repository.name,
      defaultBranch: repository.default_branch,
      status: installation.suspended_at ? "suspended" : "active",
      verifiedAt: timestamp,
      updatedAt: timestamp,
      providerReceipt: {
        account: installation.account?.login ?? "unknown",
        accountType: installation.account?.type ?? "unknown",
        repositorySelection: installation.repository_selection ?? "selected",
        onboardingPrincipal: input.onboardingPrincipal,
      },
    });
  }

  async materialize(request: RepositorySourceRequest): Promise<RepositorySourceReceipt> {
    assertRepositorySourceRequest(request);
    const binding = await this.#installations.requireActive(request.bindingId, request.repositoryId);
    this.#assertBindingEnvironment(binding);
    const existing = await readExistingSourceReceipt(request.destinationPath);
    if (existing) {
      assertMatchingSourceReceipt(existing, request, this.id, this.version);
      if (existing.transfer?.format === "git-bundle") {
        if (existing.transfer.path !== join(request.destinationPath, "repository.bundle")) {
          throw new Error("Existing GitHub source receipt has a different transfer bundle path.");
        }
      } else {
        await assertSanitizedMaterializedCheckout(request.destinationPath, request.baseCommit);
      }
      return existing;
    }
    await assertRepositoryDestinationAbsent(request.destinationPath);
    await mkdir(dirname(request.destinationPath), { recursive: true });
    if (this.#gitExecution) {
      return await this.#materializeThroughTrustedGit(request, binding);
    }
    return await this.#withInstallationToken(
      binding.installationId,
      binding.providerRepositoryId,
      { contents: "read" },
      async (token) => {
        const credentialEnvironment = gitHubGitCredentialEnvironment(token);
        await runGit(dirname(request.destinationPath), [
          "clone",
          "--no-checkout",
          "--filter=blob:none",
          "--",
          `${this.#configuration.webBaseUrl}/${binding.owner}/${binding.name}.git`,
          request.destinationPath,
        ], credentialEnvironment);
        try {
          const resolved = (await runGit(request.destinationPath, [
            "rev-parse", "--verify", `${request.baseCommit}^{commit}`,
          ], credentialEnvironment)).trim();
          if (resolved !== request.baseCommit) throw new Error("GitHub did not provide the exact requested base commit.");
          await runGit(request.destinationPath, [
            "checkout", "--detach", "--force", request.baseCommit,
          ], credentialEnvironment);
          await sanitizeMaterializedCheckout(request.destinationPath);
          await assertSanitizedMaterializedCheckout(request.destinationPath, request.baseCommit);
          const contentDigest = sha256(
            await runGit(request.destinationPath, ["ls-tree", "-r", "--full-tree", request.baseCommit]),
          );
          const receipt: RepositorySourceReceipt = {
            schemaVersion: 1,
            requestId: request.requestId,
            provider: { id: this.id, version: this.version },
            bindingId: request.bindingId,
            repositoryId: request.repositoryId,
            baseCommit: request.baseCommit,
            workspacePath: request.destinationPath,
            contentDigest,
            credentialIsolation: {
              repositoryCredentialPresent: false,
              retainedRemotes: 0,
            },
            materializedAt: this.#now().toISOString(),
          };
          await writeSourceReceipt(request.destinationPath, receipt);
          return receipt;
        } catch (error) {
          await rm(request.destinationPath, { recursive: true, force: true });
          throw error;
        }
      },
    );
  }

  async publish(request: ProposalPublicationRequest): Promise<ProposalPublicationReceipt> {
    assertProposalPublicationRequest(request);
    const binding = await this.#installations.requireActive(request.bindingId, request.repositoryId);
    this.#assertBindingEnvironment(binding);
    if (this.#gitExecution && request.sourceBundlePath && request.diff) {
      return await this.#publishThroughTrustedGit(request, binding);
    }
    if (!request.workspacePath) {
      throw new Error("GitHub local publication requires a materialized workspace.");
    }
    const inspection = await inspectProposalWorkspace(request.workspacePath, request.baseCommit);
    if (inspection.diffDigest !== request.checked.validatedDiffDigest) {
      throw new Error("Proposal diff changed after validation.");
    }
    if (JSON.stringify(inspection.changedPaths) !== JSON.stringify([...request.checked.changedPaths].sort())) {
      throw new Error("Proposal changed paths differ from checked evidence.");
    }
    return await this.#withInstallationToken(
      binding.installationId,
      binding.providerRepositoryId,
      { contents: "write", pull_requests: "write" },
      async (token) => {
        const existingPullRequest = await this.#findPullRequest(token, binding, request.branchName);
        if (existingPullRequest) return receiptFromPullRequest(this, request, existingPullRequest);

        const trusted = await mkdtemp(join(tmpdir(), "companyos-github-publisher-"));
        try {
          const credentialEnvironment = gitHubGitCredentialEnvironment(token);
          await runGit(trusted, [
            "clone",
            "--no-checkout",
            "--filter=blob:none",
            "--",
            `${this.#configuration.webBaseUrl}/${binding.owner}/${binding.name}.git`,
            "repository",
          ], credentialEnvironment);
          const checkout = join(trusted, "repository");
          await runGit(checkout, ["checkout", "--detach", "--force", request.baseCommit], credentialEnvironment);
          await applyGitPatch(checkout, inspection.diff);
          await runGit(checkout, ["add", "--all"]);
          await runGit(checkout, [
            "-c", "user.name=CompanyOS Builder",
            "-c", "user.email=builder@companyos.invalid",
            "commit", "-m", request.title,
          ]);
          const proposalCommit = (await runGit(checkout, ["rev-parse", "HEAD"])).trim();
          await runGit(checkout, [
            "push", "origin", `HEAD:refs/heads/${request.branchName}`,
          ], credentialEnvironment);
          const pullRequest = await this.#installationRequest<Record<string, any>>(
            token,
            "POST",
            `/repos/${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.name)}/pulls`,
            {
              title: request.title,
              body: request.body,
              head: request.branchName,
              base: binding.defaultBranch,
              draft: true,
            },
          );
          return {
            schemaVersion: 1,
            jobId: request.jobId,
            provider: { id: this.id, version: this.version },
            repositoryId: request.repositoryId,
            baseCommit: request.baseCommit,
            proposalCommit,
            branchName: request.branchName,
            proposalUrl: String(pullRequest.html_url),
            publishedAt: this.#now().toISOString(),
          };
        } finally {
          await rm(trusted, { recursive: true, force: true });
        }
      },
    );
  }

  async reconcileInstallationEvent(args: {
    deliveryId: string;
    event: string;
    rawBody: string;
    signature: string;
    webhookSecret: string;
  }): Promise<number> {
    assertWebhookSignature(args.rawBody, args.signature, args.webhookSecret);
    const payload = JSON.parse(args.rawBody) as Record<string, any>;
    const installationId = String(payload.installation?.id ?? "");
    if (!installationId) throw new Error("GitHub installation event has no installation id.");
    if (args.event === "installation_repositories" && payload.action === "removed") {
      let changed = 0;
      for (const repository of payload.repositories_removed ?? []) {
        const providerRepositoryId = String(repository?.id ?? "");
        if (!providerRepositoryId) continue;
        changed += await this.#installations.updateRepositoryStatus({
          providerId: this.id,
          installationId,
          providerRepositoryId,
          status: "revoked",
          providerReceipt: {
            event: args.event,
            action: "removed",
            deliveryId: args.deliveryId,
            providerRepositoryId,
          },
          updatedAt: this.#now(),
        });
      }
      return changed;
    }
    let status: RepositoryInstallationStatus | undefined;
    if (args.event === "installation") {
      if (payload.action === "deleted") status = "revoked";
      else if (payload.action === "suspend") status = "suspended";
      else if (["created", "unsuspend", "new_permissions_accepted"].includes(payload.action)) status = "active";
    }
    if (!status) return 0;
    return await this.#installations.updateStatus({
      providerId: this.id,
      installationId,
      status,
      providerReceipt: {
        event: args.event,
        action: String(payload.action ?? "unknown"),
        deliveryId: args.deliveryId,
      },
      updatedAt: this.#now(),
    });
  }

  #assertBindingEnvironment(binding: RepositoryInstallationBinding): void {
    if (binding.providerId !== this.id || binding.serviceEnvironment !== this.#configuration.serviceEnvironment) {
      throw new Error("Repository installation binding belongs to a different provider environment.");
    }
  }

  async #materializeThroughTrustedGit(
    request: RepositorySourceRequest,
    binding: RepositoryInstallationBinding,
  ): Promise<RepositorySourceReceipt> {
    const gitExecution = this.#gitExecution;
    if (!gitExecution) throw new Error("Trusted Git execution adapter is unavailable.");
    await mkdir(request.destinationPath, { recursive: true });
    const bundlePath = join(request.destinationPath, "repository.bundle");
    try {
      const result = await this.#withInstallationToken(
        binding.installationId,
        binding.providerRepositoryId,
        { contents: "read" },
        async (token) => await gitExecution.materialize({
          operationId: `${request.requestId}:source`,
          remoteUrl: `${this.#configuration.webBaseUrl}/${binding.owner}/${binding.name}.git`,
          baseCommit: request.baseCommit,
          destinationBundlePath: bundlePath,
          credential: trustedGitCredentialBinding(this.#configuration.webBaseUrl, token),
        }),
      );
      const receipt: RepositorySourceReceipt = {
        schemaVersion: 1,
        requestId: request.requestId,
        provider: { id: this.id, version: this.version },
        bindingId: request.bindingId,
        repositoryId: request.repositoryId,
        baseCommit: request.baseCommit,
        workspacePath: request.destinationPath,
        transfer: { format: "git-bundle", path: bundlePath },
        contentDigest: result.contentDigest,
        credentialIsolation: {
          repositoryCredentialPresent: false,
          retainedRemotes: 0,
        },
        materializedAt: this.#now().toISOString(),
      };
      await writeSourceReceipt(request.destinationPath, receipt);
      return receipt;
    } catch (error) {
      await rm(request.destinationPath, { recursive: true, force: true });
      throw error;
    }
  }

  async #publishThroughTrustedGit(
    request: ProposalPublicationRequest,
    binding: RepositoryInstallationBinding,
  ): Promise<ProposalPublicationReceipt> {
    const gitExecution = this.#gitExecution;
    if (!gitExecution || !request.sourceBundlePath || !request.diff) {
      throw new Error("Trusted Git publication inputs are unavailable.");
    }
    return await this.#withInstallationToken(
      binding.installationId,
      binding.providerRepositoryId,
      { contents: "write", pull_requests: "write" },
      async (token) => {
        const existingPullRequest = await this.#findPullRequest(token, binding, request.branchName);
        if (existingPullRequest) return receiptFromPullRequest(this, request, existingPullRequest);
        const result = await gitExecution.publish({
          operationId: `${request.jobId}:publish`,
          sourceBundlePath: request.sourceBundlePath!,
          baseCommit: request.baseCommit,
          diff: request.diff!,
          remoteUrl: `${this.#configuration.webBaseUrl}/${binding.owner}/${binding.name}.git`,
          branchName: request.branchName,
          title: request.title,
          checked: request.checked,
          credential: trustedGitCredentialBinding(this.#configuration.webBaseUrl, token),
        });
        const pullRequest = await this.#installationRequest<Record<string, any>>(
          token,
          "POST",
          `/repos/${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.name)}/pulls`,
          {
            title: request.title,
            body: request.body,
            head: request.branchName,
            base: binding.defaultBranch,
            draft: true,
          },
        );
        return {
          schemaVersion: 1,
          jobId: request.jobId,
          provider: { id: this.id, version: this.version },
          repositoryId: request.repositoryId,
          baseCommit: request.baseCommit,
          proposalCommit: result.proposalCommit,
          branchName: request.branchName,
          proposalUrl: String(pullRequest.html_url),
          publishedAt: this.#now().toISOString(),
        };
      },
    );
  }

  async #findPullRequest(
    token: string,
    binding: RepositoryInstallationBinding,
    branchName: string,
  ): Promise<Record<string, any> | undefined> {
    const query = new URLSearchParams({
      state: "all",
      head: `${binding.owner}:${branchName}`,
      per_page: "1",
    });
    const pulls = await this.#installationRequest<Record<string, any>[]>(
      token,
      "GET",
      `/repos/${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.name)}/pulls?${query}`,
    );
    return pulls[0];
  }

  async #withInstallationToken<T>(
    installationId: string,
    providerRepositoryId: string,
    permissions: Readonly<Record<string, GitHubPermission>>,
    use: (token: string) => Promise<T>,
  ): Promise<T> {
    const created = await this.#appRequest<{ token: string; expires_at: string }>(
      "POST",
      `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      {
        repository_ids: [Number(providerRepositoryId)],
        permissions,
      },
    );
    const credential: InstallationToken = { token: created.token, expiresAt: created.expires_at };
    if (!credential.token || !Number.isFinite(Date.parse(credential.expiresAt))) {
      throw new Error("GitHub returned an invalid installation token receipt.");
    }
    try {
      return await use(credential.token);
    } finally {
      await this.#installationRequest<void>(credential.token, "DELETE", "/installation/token")
        .catch(() => undefined);
    }
  }

  async #appRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    return await this.#request<T>(method, path, `Bearer ${this.#appJwt()}`, body);
  }

  async #installationRequest<T>(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    return await this.#request<T>(method, path, `Bearer ${token}`, body);
  }

  async #request<T>(
    method: string,
    path: string,
    authorization: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.#fetch(`${this.#configuration.apiBaseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: authorization,
        "Content-Type": "application/json",
        "User-Agent": "CompanyOS-Repository-Provider/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 2_000);
      throw new Error(`GitHub Repository Provider request failed (${response.status}): ${detail}`);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  #appJwt(): string {
    const nowSeconds = Math.floor(this.#now().getTime() / 1_000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64Url(JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 9 * 60,
      iss: this.#configuration.appId,
    }));
    const unsigned = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signer.end();
    return `${unsigned}.${signer.sign(this.#configuration.privateKey).toString("base64url")}`;
  }
}

export function createGitHubAppConfigurationFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): GitHubAppConfiguration {
  const appId = environment.COMPANYOS_GITHUB_APP_ID;
  const privateKey = environment.COMPANYOS_GITHUB_APP_PRIVATE_KEY?.replaceAll("\\n", "\n");
  const serviceEnvironment = environment.COMPANYOS_SERVICE_ENVIRONMENT;
  if (!appId || !privateKey || !serviceEnvironment) {
    throw new Error(
      "COMPANYOS_GITHUB_APP_ID, COMPANYOS_GITHUB_APP_PRIVATE_KEY, and COMPANYOS_SERVICE_ENVIRONMENT are required.",
    );
  }
  return { appId, privateKey, serviceEnvironment };
}

/** @internal Exported only so the credential boundary can be regression tested. */
export function gitHubGitCredentialEnvironment(token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
}

/** @internal Exported only so the brokered trusted-Git boundary can be tested. */
export function trustedGitCredentialBinding(
  webBaseUrl: string,
  token: string,
): TrustedGitCredentialBinding {
  const host = new URL(webBaseUrl).hostname;
  const basic = (password: string) => `Basic ${Buffer.from(`x-access-token:${password}`).toString("base64")}`;
  return {
    host,
    placeholderAuthorization: basic("companyos-repository-broker-placeholder"),
    realAuthorization: basic(token),
  };
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function assertWebhookSignature(body: string, signature: string, secret: string): void {
  if (!secret) throw new Error("GitHub webhook secret is required.");
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error("GitHub webhook signature is invalid.");
  }
}

function receiptFromPullRequest(
  provider: Pick<GitHubAppRepositoryProvider, "id" | "version">,
  request: ProposalPublicationRequest,
  pullRequest: Record<string, any>,
): ProposalPublicationReceipt {
  if (pullRequest.draft !== true) {
    throw new Error("GitHub proposal is not a draft pull request.");
  }
  const proposalCommit = String(pullRequest.head?.sha ?? "");
  if (!/^[0-9a-f]{40}$/.test(proposalCommit)) {
    throw new Error("Existing GitHub pull request has no exact proposal commit.");
  }
  return {
    schemaVersion: 1,
    jobId: request.jobId,
    provider: { id: provider.id, version: provider.version },
    repositoryId: request.repositoryId,
    baseCommit: request.baseCommit,
    proposalCommit,
    branchName: request.branchName,
    proposalUrl: String(pullRequest.html_url),
    publishedAt: String(pullRequest.created_at),
  };
}
