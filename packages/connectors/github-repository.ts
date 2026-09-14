import { assertBrainRepositoryBinding } from "../brain/repository-binding.ts";
import { createHash, createHmac, createSign, timingSafeEqual } from "node:crypto";
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
  type BrainRepositoryBinding,
  type BrainRepositoryMutationSource,
  type BrainRepositoryCommitRequest,
  type BrainRepositoryCommitReceipt,
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
import type { GitHubReleaseClient } from "./github-release.ts";
import { assertBrainGitEntry, assertBrainPath } from "../brain/paths.ts";
import { BrainError } from "../brain/contracts.ts";
import { MAX_BRAIN_WRITE_FILES, MAX_BRAIN_WRITE_UNITS } from "../brain/mutations.ts";
import { sha256 as brainDigest } from "../runtime/canonical.ts";
import { CapabilityEffectOutcomeUnknownError } from "../capabilities/contracts.ts";

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

export class GitHubAppRepositoryProvider implements RepositorySourceAdapter, ProposalPublisher, BrainRepositoryMutationSource {
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

  async #brainBinding(request: BrainRepositoryBinding): Promise<RepositoryInstallationBinding> {
    assertBrainRepositoryBinding(request);
    const binding = await this.#installations.requireActive(request.bindingId, request.repositoryId);
    this.#assertBindingEnvironment(binding);
    if (binding.instanceId !== request.instanceId) throw new BrainError("invalid_binding", "Repository installation belongs to another Instance.");
    return binding;
  }

  async brainRevision(request: BrainRepositoryBinding): Promise<string> {
    const binding = await this.#brainBinding(request);
    const signal = AbortSignal.timeout(180_000);
    return this.#withInstallationToken(binding.installationId, binding.providerRepositoryId, { contents: "read" }, async token => {
      const ref = await this.#installationRequest<{ ref: string; object: { sha: string; type: string } }>(token, "GET",
        `/repos/${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.name)}/git/ref/heads/${encodeURIComponent(request.branch)}`, undefined, signal);
      if (ref.ref !== `refs/heads/${request.branch}` || ref.object?.type !== "commit" || !/^[a-f0-9]{40}$/.test(ref.object?.sha)) throw new BrainError("repository_revision_invalid", "Repository returned an invalid branch revision.");
      return ref.object.sha;
    }, signal);
  }

  async brainFiles(request: BrainRepositoryBinding, revision: string): Promise<Record<string, string>> {
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new BrainError("repository_revision_invalid", "Brain reads require an immutable commit.");
    const binding = await this.#brainBinding(request);
    const signal = AbortSignal.timeout(180_000);
    return this.#withInstallationToken(binding.installationId, binding.providerRepositoryId, { contents: "read" }, async token => {
      const root = `/repos/${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.name)}`;
      const commit = await this.#installationRequest<{ sha: string; tree: { sha: string } }>(token, "GET", `${root}/git/commits/${revision}`, undefined, signal);
      if (commit.sha !== revision || !/^[a-f0-9]{40}$/.test(commit.tree?.sha)) throw new BrainError("repository_revision_invalid", "Repository returned a mismatched commit/tree.");
      const tree = await this.#installationRequest<{ truncated: boolean; tree: Array<{ path: string; mode: string; type: string; sha: string; size?: number }> }>(token, "GET", `${root}/git/trees/${commit.tree.sha}?recursive=1`, undefined, signal);
      if (tree.truncated || !Array.isArray(tree.tree)) throw new BrainError("repository_inventory_incomplete", "Brain requires a complete repository tree.");
      const entries = tree.tree.filter(entry => entry.path === "brain" || entry.path.startsWith("brain/"));
      if (new Set(entries.map(entry => entry.path)).size !== entries.length) throw new BrainError("repository_inventory_incomplete", "Brain tree contains duplicate paths.");
      const files = entries.filter(entry => entry.type !== "tree");
      if (files.length > 1000) throw new BrainError("repository_read_bound", "This initial Brain reader supports at most 1000 files per complete scan.");
      for (const entry of entries) {
        if (entry.type === "tree") {
          if (entry.mode !== "040000" || entry.path.split("/").some(part => !part || part.startsWith("."))) throw new BrainError("invalid_file", "Brain directories must be ordinary Git trees.");
        } else {
          assertBrainGitEntry(entry);
          if (!/^[a-f0-9]{40}$/.test(entry.sha) || !Number.isSafeInteger(entry.size) || entry.size! > 400_000 || entry.size! < 0) throw new BrainError("repository_read_bound", "Invalid or oversized Brain blob.");
        }
      }
      if (files.reduce((total, file) => total + file.size!, 0) > 32_000_000) throw new BrainError("repository_read_bound", "Brain scan exceeds its aggregate byte bound.");
      const output: Record<string, string> = {};
      for (let offset = 0; offset < files.length; offset += 5) {
        await Promise.all(files.slice(offset, offset + 5).map(async entry => {
          const blob = await this.#installationRequest<{ sha: string; content: string; encoding: string; size: number }>(token, "GET", `${root}/git/blobs/${entry.sha}`, undefined, signal);
          if (blob.encoding !== "base64" || blob.sha !== entry.sha || blob.size !== entry.size || typeof blob.content !== "string" || blob.content.length > 550_000) throw new BrainError("repository_blob_invalid", "Brain blob receipt does not match the selected tree.");
          const bytes = Buffer.from(blob.content, "base64");
          const hash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
          if (bytes.length !== blob.size || hash !== entry.sha) throw new BrainError("repository_blob_invalid", "Brain blob failed its content identity check.");
          output[entry.path] = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        }));
      }
      return output;
    }, signal);
  }

  #assertBrainCommit(request: BrainRepositoryCommitRequest): void {
    assertBrainRepositoryBinding(request.binding);
    if (typeof request.baseCommit !== "string" || !/^[a-f0-9]{40}$/.test(request.baseCommit)
      || typeof request.operationId !== "string" || !/^[a-f0-9]{64}$/.test(request.operationId)
      || typeof request.inputDigest !== "string" || !/^[a-f0-9]{64}$/.test(request.inputDigest)) throw new BrainError("invalid_input", "Brain publication needs immutable base and operation digests.");
    if (!Array.isArray(request.changes) || !request.changes.length || request.changes.length > MAX_BRAIN_WRITE_FILES
      || new Set(request.changes.map(change => change.path)).size !== request.changes.length) throw new BrainError("write_bound", "Brain publication needs a bounded distinct change set.");
    let units = 0;
    for (const change of request.changes) {
      assertBrainPath(change.path);
      if (change.expectedContentHash !== null && (typeof change.expectedContentHash !== "string" || !/^[a-f0-9]{64}$/.test(change.expectedContentHash))
        || change.markdown !== null && (typeof change.markdown !== "string" || change.markdown.includes("\0") || change.markdown.length > 100_000)
        || change.markdown === null && change.expectedContentHash === null) throw new BrainError("invalid_input", "Invalid expected page digest or Markdown replacement.");
      if (change.markdown !== null && Buffer.from(change.markdown).toString() !== change.markdown) throw new BrainError("invalid_input", "Brain Markdown must have a lossless UTF-8 representation.");
      units += change.markdown?.length ?? 0;
    }
    if (units > MAX_BRAIN_WRITE_UNITS) throw new BrainError("write_bound", "Brain publication exceeds its total text bound.");
  }

  #brainCommitMessage(request: BrainRepositoryCommitRequest): string {
    return `Update sourced Brain knowledge\n\nCompanyOS-Brain-Operation: ${request.operationId}\nCompanyOS-Brain-Input: ${request.inputDigest}`;
  }

  #brainCommitReceipt(request: BrainRepositoryCommitRequest, commit: string): BrainRepositoryCommitReceipt {
    return { repositoryId: request.binding.repositoryId, branch: request.binding.branch, baseCommit: request.baseCommit,
      commit, operationId: request.operationId, inputDigest: request.inputDigest };
  }

  async brainCommit(request: BrainRepositoryCommitRequest): Promise<BrainRepositoryCommitReceipt> {
    this.#assertBrainCommit(request);
    const binding = await this.#brainBinding(request.binding);
    // Independently inspect the base's ordinary Git modes, not just supplied path strings.
    const base = await this.brainFiles(request.binding, request.baseCommit);
    for (const change of request.changes) {
      const prior = Object.hasOwn(base, change.path) ? brainDigest(base[change.path]) : null;
      if (prior !== change.expectedContentHash) throw new BrainError("write_conflict", "A selected page does not match its expected content.");
    }
    if (request.changes.every(change => (base[change.path] ?? null) === change.markdown)) throw new BrainError("empty_mutation", "An unchanged batch must not create a Git commit.");
    if (await this.brainRevision(request.binding) !== request.baseCommit) throw new BrainError("write_conflict", "Repository head moved; recompute the intended change.");
    const signal = AbortSignal.timeout(30_000);
    return this.#withInstallationToken(binding.installationId, binding.providerRepositoryId, { contents: "write" }, async token => {
      // GitHub's expectedHeadOid performs the atomic compare-and-swap. A separate
      // REST ref read plus force:false is insufficient if the branch moves backwards.
      const mutation = `mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid message parents(first:2){nodes{oid}}}}}`;
      const message = this.#brainCommitMessage(request), split = message.indexOf("\n\n");
      const input = { branch: { repositoryNameWithOwner: request.binding.repositoryId, branchName: request.binding.branch },
        expectedHeadOid: request.baseCommit, clientMutationId: request.operationId,
        message: { headline: message.slice(0, split), body: message.slice(split + 2) },
        fileChanges: {
          additions: request.changes.filter(change => change.markdown !== null).map(change => ({ path: change.path, contents: Buffer.from(change.markdown!).toString("base64") })),
          deletions: request.changes.filter(change => change.markdown === null).map(change => ({ path: change.path })),
        } };
      let result: any;
      try { result = await this.#installationRequest(token, "POST", "/graphql", { query: mutation, variables: { input } }, signal); }
      catch { throw new CapabilityEffectOutcomeUnknownError("The knowledge commit outcome is uncertain; reconcile the retained operation before retrying.", { operation_id: request.operationId, base_commit: request.baseCommit }); }
      const commit = result.data?.createCommitOnBranch?.commit;
      if (!commit && result.errors?.length) {
        // No bypass or release path: protected branches stay protected. A caller
        // may prepare a review through the existing governed proposal lifecycle.
        if (await this.brainRevision(request.binding) !== request.baseCommit) throw new BrainError("write_conflict", "Repository head changed during publication.");
        throw new BrainError("repository_review_required", "Repository policy or provider validation rejected direct publication; prepare a governed review.");
      }
      if (!/^[a-f0-9]{40}$/.test(commit?.oid) || commit.message?.trim() !== message || commit.parents?.nodes?.length !== 1 || commit.parents.nodes[0].oid !== request.baseCommit) {
        throw new CapabilityEffectOutcomeUnknownError("The provider returned incomplete knowledge commit evidence; reconcile before retrying.", { operation_id: request.operationId, base_commit: request.baseCommit });
      }
      return this.#brainCommitReceipt(request, commit.oid);
    }, signal);
  }

  async brainFindCommit(request: BrainRepositoryCommitRequest): Promise<BrainRepositoryCommitReceipt | undefined> {
    this.#assertBrainCommit(request);
    const binding = await this.#brainBinding(request.binding), signal = AbortSignal.timeout(30_000);
    const candidates: any[] = await this.#withInstallationToken(binding.installationId, binding.providerRepositoryId, { contents: "read" }, async token => {
      const result: any = await this.#installationRequest(token, "POST", "/graphql", {
        query: `query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){ref(qualifiedName:$branch){target{... on Commit{history(first:100){nodes{oid message changedFilesIfAvailable parents(first:2){nodes{oid}}}}}}}}}`,
        variables: { owner: binding.owner, name: binding.name, branch: `refs/heads/${request.binding.branch}` },
      }, signal);
      if (result.errors?.length || !Array.isArray(result.data?.repository?.ref?.target?.history?.nodes)
        || result.data.repository.ref.target.history.nodes.length > 100) throw new BrainError("write_recovery_required", "Repository history is unavailable for bounded reconciliation.");
      return result.data.repository.ref.target.history.nodes.filter((commit: any) => commit.message?.trim() === this.#brainCommitMessage(request));
    }, signal);
    if (!candidates.length) return undefined;
    const commit = candidates[0];
    if (candidates.length !== 1 || !/^[a-f0-9]{40}$/.test(commit.oid) || commit.parents?.nodes?.length !== 1
      || commit.parents.nodes[0].oid !== request.baseCommit || commit.changedFilesIfAvailable !== request.changes.length) {
      throw new BrainError("write_recovery_required", "The retained operation does not have one matching bounded commit.");
    }
    const before = await this.brainFiles(request.binding, request.baseCommit), after = await this.brainFiles(request.binding, commit.oid);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => before[path] !== after[path]).sort();
    if (JSON.stringify(changed) !== JSON.stringify(request.changes.map(change => change.path).sort())
      || request.changes.some(change => (after[change.path] ?? null) !== change.markdown
        || (Object.hasOwn(before, change.path) ? brainDigest(before[change.path]) : null) !== change.expectedContentHash)) throw new BrainError("write_recovery_required", "The observed commit differs from the prepared knowledge mutation.");
    return this.#brainCommitReceipt(request, commit.oid);
  }

  /** Trusted release only; credentials remain in this maintained Connector. */
  async withReleaseClient<T>(input: { bindingId: string; repositoryId: string; instanceId: string }, use: (client: GitHubReleaseClient) => Promise<T>): Promise<T> {
    const binding = await this.#installations.requireActive(input.bindingId, input.repositoryId);
    this.#assertBindingEnvironment(binding);
    if (binding.instanceId !== input.instanceId) throw new Error("Release repository belongs to another Instance.");
    const prefix = `/repos/${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.name)}`;
    return await this.#withInstallationToken(binding.installationId, binding.providerRepositoryId,
      { contents: "write", pull_requests: "write", checks: "read", administration: "read" }, async (token) => use({
        request: async <R>(method: "GET" | "PUT" | "PATCH", path: string, body?: unknown): Promise<R> => {
          const pathname = decodeURIComponent(path.split("?")[0]!);
          // GitHub comparisons contain `base...head`. Only actual path
          // traversal is forbidden; encoded branch separators remain valid.
          if (!path.startsWith("/") || path.startsWith("//") || path.includes("#")
            || /[\\\\\u0000-\u0020]/.test(pathname)
            || pathname.split("/").some((part) => part === "." || part === "..")) throw new Error("Invalid scoped release path.");
          return await this.#installationRequest<R>(token, method, `${prefix}${path}`, body);
        },
        readyForReview: async (nodeId) => {
          const result = await this.#installationRequest<{ errors?: unknown[] }>(token, "POST", "/graphql", {
            query: "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}", variables: { id: nodeId },
          });
          if (result.errors?.length) throw new Error("GitHub could not mark the checked pull request ready for review.");
        },
      }));
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
        await this.#assertTargetBranch(token, binding, request);
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
              base: request.targetBranchName ?? binding.defaultBranch,
              draft: true,
            },
          );
          const receipt = receiptFromPullRequest(this, request, pullRequest);
          if (receipt.proposalCommit !== proposalCommit) {
            throw new Error("GitHub proposal returned a different outer commit.");
          }
          return receipt;
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

  /** A signed notification selects only the bound repository. Sync always reads its current head. */
  async brainPush(binding: BrainRepositoryBinding, args: { deliveryId: string; event: string; rawBody: string; signature: string; webhookSecret: string }): Promise<{ delivery_id: string; commit: string } | undefined> {
    if (args.rawBody.length > 2_000_000 || !/^[A-Za-z0-9_-]{1,256}$/.test(args.deliveryId)) throw new Error("GitHub push notification exceeds its supported bound.");
    assertWebhookSignature(args.rawBody, args.signature, args.webhookSecret);
    assertBrainRepositoryBinding(binding);
    if (args.event !== "push") return undefined;
    const payload = JSON.parse(args.rawBody) as Record<string, any>;
    if (payload.repository?.full_name !== binding.repositoryId || payload.ref !== `refs/heads/${binding.branch}` || payload.deleted === true) return undefined;
    const installation = await this.#brainBinding(binding);
    if (String(payload.installation?.id ?? "") !== installation.installationId || String(payload.repository?.id ?? "") !== installation.providerRepositoryId) {
      throw new Error("GitHub push installation or repository identity differs from the verified binding.");
    }
    if (typeof payload.after !== "string" || !/^[a-f0-9]{40}$/.test(payload.after) || /^0+$/.test(payload.after)) throw new Error("GitHub push has no immutable commit identity.");
    return { delivery_id: args.deliveryId, commit: payload.after };
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
        await this.#assertTargetBranch(token, binding, request);
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
            base: request.targetBranchName ?? binding.defaultBranch,
            draft: true,
          },
        );
        const receipt = receiptFromPullRequest(this, request, pullRequest);
        if (receipt.proposalCommit !== result.proposalCommit) {
          throw new Error("GitHub proposal returned a different trusted outer commit.");
        }
        return receipt;
      },
    );
  }

  async #assertTargetBranch(
    token: string,
    binding: RepositoryInstallationBinding,
    request: ProposalPublicationRequest,
  ): Promise<void> {
    if (!request.targetBranchName) return;
    const reference = await this.#installationRequest<Record<string, any>>(
      token,
      "GET",
      `/repos/${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.name)}/git/ref/heads/${encodeURIComponent(request.targetBranchName)}`,
    );
    if (
      String(reference.ref ?? "") !== `refs/heads/${request.targetBranchName}`
      || String(reference.object?.sha ?? "") !== request.baseCommit
    ) {
      throw new Error("GitHub proposal target branch does not match the exact validated base commit.");
    }
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
    signal?: AbortSignal,
  ): Promise<T> {
    const created = await this.#appRequest<{ token: string; expires_at: string }>(
      "POST",
      `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      {
        repository_ids: [Number(providerRepositoryId)],
        permissions,
      },
      signal,
    );
    const credential: InstallationToken = { token: created.token, expiresAt: created.expires_at };
    if (!credential.token || !Number.isFinite(Date.parse(credential.expiresAt))) {
      throw new Error("GitHub returned an invalid installation token receipt.");
    }
    try {
      return await use(credential.token);
    } finally {
      await this.#installationRequest<void>(credential.token, "DELETE", "/installation/token", undefined, signal ? AbortSignal.timeout(10_000) : undefined)
        .catch(() => undefined);
    }
  }

  async #appRequest<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return await this.#request<T>(method, path, `Bearer ${this.#appJwt()}`, body, signal);
  }

  async #installationRequest<T>(
    token: string,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    return await this.#request<T>(method, path, `Bearer ${token}`, body, signal);
  }

  async #request<T>(
    method: string,
    path: string,
    authorization: string,
    body?: unknown,
    signal?: AbortSignal,
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
      ...(signal ? { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) } : {}),
    });
    if (!response.ok) {
      if (signal) { await response.body?.cancel(); throw new BrainError("repository_request_failed", `Brain repository request failed (${response.status}).`); }
      const detail = (await response.text()).slice(0, 2_000);
      throw new Error(`GitHub Repository Provider request failed (${response.status}): ${detail}`);
    }
    if (response.status === 204) return undefined as T;
    if (signal) {
      const reader = response.body?.getReader();
      if (!reader) throw new BrainError("repository_response_invalid", "Empty repository response.");
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.length;
          if (size > 5_000_000) throw new BrainError("repository_read_bound", "Repository response exceeds its byte bound.");
          chunks.push(part.value);
        }
      } finally { await reader.cancel(); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
    }
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
  if (request.targetBranchName && String(pullRequest.base?.ref ?? "") !== request.targetBranchName) {
    throw new Error("GitHub proposal targets a different branch than the validated request.");
  }
  if (request.targetBranchName && String(pullRequest.base?.sha ?? "") !== request.baseCommit) {
    throw new Error("GitHub proposal target moved from the exact validated base commit.");
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
