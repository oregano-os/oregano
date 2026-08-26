import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
import { inspectProposalWorkspace, sha256 } from "../runtime/repository/proposal-inspection.ts";
import {
  applyGitPatch,
  assertMatchingSourceReceipt,
  assertRepositoryDestinationAbsent,
  assertSanitizedMaterializedCheckout,
  readExistingSourceReceipt,
  runGit,
  runGitOptional,
  sanitizeMaterializedCheckout,
  writeSourceReceipt,
} from "../runtime/repository/git.ts";

export interface LocalGitRepositoryBinding {
  readonly id: string;
  readonly repositoryId: string;
  readonly repositoryPath: string;
}

export class LocalGitRepositorySourceAdapter implements RepositorySourceAdapter {
  readonly id = "local-git";
  readonly version = "1.0.0";
  readonly #bindings: readonly LocalGitRepositoryBinding[];

  constructor(bindings: readonly LocalGitRepositoryBinding[]) {
    this.#bindings = bindings;
  }

  async materialize(request: RepositorySourceRequest): Promise<RepositorySourceReceipt> {
    assertRepositorySourceRequest(request);
    const binding = this.binding(request.bindingId, request.repositoryId);
    const existing = await readExistingSourceReceipt(request.destinationPath);
    if (existing) {
      assertMatchingSourceReceipt(existing, request, this.id, this.version);
      await assertSanitizedMaterializedCheckout(request.destinationPath, request.baseCommit);
      return existing;
    }
    await assertRepositoryDestinationAbsent(request.destinationPath);
    await mkdir(dirname(request.destinationPath), { recursive: true });
    const baseCommit = (await runGit(binding.repositoryPath, [
      "rev-parse", "--verify", `${request.baseCommit}^{commit}`,
    ])).trim();
    if (baseCommit !== request.baseCommit) throw new Error("Local Git binding did not resolve the exact base commit.");
    await runGit(dirname(request.destinationPath), [
      "clone",
      "--no-checkout",
      "--no-hardlinks",
      "--",
      resolve(binding.repositoryPath),
      request.destinationPath,
    ]);
    try {
      await runGit(request.destinationPath, ["checkout", "--detach", "--force", request.baseCommit]);
      await sanitizeMaterializedCheckout(request.destinationPath);
      await assertSanitizedMaterializedCheckout(request.destinationPath, request.baseCommit);
      const contentDigest = sha256(await runGit(request.destinationPath, ["ls-tree", "-r", "--full-tree", request.baseCommit]));
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
        materializedAt: new Date().toISOString(),
      };
      await writeSourceReceipt(request.destinationPath, receipt);
      return receipt;
    } catch (error) {
      await rm(request.destinationPath, { recursive: true, force: true });
      throw error;
    }
  }

  private binding(bindingId: string, repositoryId: string): LocalGitRepositoryBinding {
    const matches = this.#bindings.filter((candidate) => candidate.id === bindingId);
    if (matches.length !== 1) throw new Error(`Local Git source binding '${bindingId}' is unavailable or ambiguous.`);
    const binding = matches[0]!;
    if (binding.repositoryId !== repositoryId) {
      throw new Error(`Local Git source binding '${bindingId}' does not authorize repository '${repositoryId}'.`);
    }
    return binding;
  }
}

export class LocalGitProposalPublisher implements ProposalPublisher {
  readonly id = "local-git";
  readonly version = "1.0.0";
  readonly #bindings: readonly LocalGitRepositoryBinding[];

  constructor(bindings: readonly LocalGitRepositoryBinding[]) {
    this.#bindings = bindings;
  }

  async publish(request: ProposalPublicationRequest): Promise<ProposalPublicationReceipt> {
    assertProposalPublicationRequest(request);
    const binding = this.binding(request.bindingId, request.repositoryId);
    const inspection = await inspectProposalWorkspace(request.workspacePath, request.baseCommit);
    if (inspection.diffDigest !== request.checked.validatedDiffDigest) {
      throw new Error("Proposal diff changed after validation.");
    }
    if (JSON.stringify(inspection.changedPaths) !== JSON.stringify([...request.checked.changedPaths].sort())) {
      throw new Error("Proposal changed paths differ from checked evidence.");
    }
    const existingCommit = await runGitOptional(binding.repositoryPath, [
      "rev-parse", "--verify", `refs/heads/${request.branchName}^{commit}`,
    ]);
    if (existingCommit) return this.existingReceipt(request, existingCommit.trim());

    const trusted = await mkdtemp(join(tmpdir(), "companyos-proposal-publisher-"));
    try {
      await runGit(trusted, ["clone", "--no-checkout", "--no-hardlinks", "--", resolve(binding.repositoryPath), "repository"]);
      const checkout = join(trusted, "repository");
      await runGit(checkout, ["checkout", "--detach", "--force", request.baseCommit]);
      await applyGitPatch(checkout, inspection.diff);
      await runGit(checkout, ["add", "--all"]);
      await runGit(checkout, [
        "-c", "user.name=CompanyOS Builder",
        "-c", "user.email=builder@companyos.invalid",
        "commit", "-m", request.title,
      ]);
      const proposalCommit = (await runGit(checkout, ["rev-parse", "HEAD"])).trim();
      await runGit(checkout, ["push", "origin", `HEAD:refs/heads/${request.branchName}`]);
      return {
        schemaVersion: 1,
        jobId: request.jobId,
        provider: { id: this.id, version: this.version },
        repositoryId: request.repositoryId,
        baseCommit: request.baseCommit,
        proposalCommit,
        branchName: request.branchName,
        proposalUrl: `local-git://${encodeURIComponent(request.repositoryId)}/proposals/${encodeURIComponent(request.branchName)}`,
        publishedAt: new Date().toISOString(),
      };
    } finally {
      await rm(trusted, { recursive: true, force: true });
    }
  }

  private binding(bindingId: string, repositoryId: string): LocalGitRepositoryBinding {
    const binding = this.#bindings.find((candidate) => candidate.id === bindingId);
    if (!binding || binding.repositoryId !== repositoryId) {
      throw new Error(`Local Git publisher binding '${bindingId}' does not authorize repository '${repositoryId}'.`);
    }
    return binding;
  }

  private async existingReceipt(
    request: ProposalPublicationRequest,
    proposalCommit: string,
  ): Promise<ProposalPublicationReceipt> {
    return {
      schemaVersion: 1,
      jobId: request.jobId,
      provider: { id: this.id, version: this.version },
      repositoryId: request.repositoryId,
      baseCommit: request.baseCommit,
      proposalCommit,
      branchName: request.branchName,
      proposalUrl: `local-git://${encodeURIComponent(request.repositoryId)}/proposals/${encodeURIComponent(request.branchName)}`,
      publishedAt: new Date(0).toISOString(),
    };
  }
}
