import { retainedRecordsBuildInputs } from "../../../../companyos-builder/records-build-input.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";
import type { WorkflowExecutionStore } from "../../../../state-store/workflow-engine.ts";
import { sha256 } from "../../../../runtime/canonical.ts";
import { releaseAuthorization } from "../../../../runtime/release/policy.ts";
import { authorizeRelease } from "../../../../runtime/release/coordinator.ts";
import { checkedBuilderProposal, type BuilderFunctionalTests } from "../../../../runtime/builder/functional-tests.ts";
import { inspectGitHubCandidate, mergeGitHubCandidate, type GitHubCandidateInput } from "../../../../connectors/github-release.ts";
import type { GitHubAppRepositoryProvider } from "../../../../connectors/github-repository.ts";
import { VercelProductionReleaseHost, type ReleasePrivateState } from "../../../../connectors/vercel-release.ts";
import type { CompanyOSArtifact } from "../../../../companyos-builder/types.ts";
import type { BuilderJob } from "../../../../state-store/builder-jobs.ts";
import type { CheckedProposal, ProposalPublicationReceipt } from "../../../../runtime/repository/contracts.ts";
import type { DeploymentReceipt, ProductionArtifactReceipt, ReleaseCandidate, ReleaseExecutionAdapter, ReleaseExecutionContext, MergeReceipt } from "../../../../runtime/release/contracts.ts";
import type { VercelSandboxTrustedGitExecutionAdapter } from "./trusted-git-sandbox.ts";
import { rebindBuilderReleaseEnvironment } from "./release-environment.ts";

interface CandidateRecord { candidate: ReleaseCandidate; github: GitHubCandidateInput; previous: DeploymentReceipt; job?: BuilderJob; }
interface BuiltRecord { receipt: ProductionArtifactReceipt; encodedArtifact: string; environmentOverrides: Record<string, string>; deploymentId?: string; }

/** Composition only: company policy and secret-free Instance binding plus maintained providers. */
export class HostedBuilderReleaseAdapter implements ReleaseExecutionAdapter {
  readonly id = "github-vercel";
  readonly configurationDigest: string;
  private readonly dependencies: {
    artifact: CompanyOSArtifact; state: ReleasePrivateState;
    github: GitHubAppRepositoryProvider; compiler: VercelSandboxTrustedGitExecutionAdapter;
    host: VercelProductionReleaseHost;
    artifacts: Pick<WorkflowExecutionStore, "putArtifact" | "getArtifact">;
    environment: NodeJS.ProcessEnv;
    functionalTests?: BuilderFunctionalTests;
    revisionPending?(job: { jobId: string }): Promise<boolean>;
  };
  constructor(dependencies: HostedBuilderReleaseAdapter["dependencies"]) {
    this.dependencies = dependencies;
    const { artifact } = dependencies;
    if (!artifact.builder || !artifact.builderReleasePolicy || artifact.instance.environment !== "production") throw new Error("Release requires the company's Builder policy and production Instance.");
    const digest = artifact.provenance.instanceConfigurationDigest;
    if (!digest || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Release requires the running Artifact's exact Instance configuration digest.");
    this.configurationDigest = digest;
  }
  async authorization(instanceId: string) {
    const { artifact } = this.dependencies;
    if (instanceId !== artifact.instance.id) throw new Error("Release authority belongs to another Instance.");
    const production = await this.currentProduction(instanceId);
    if (production.artifactHash !== artifact.artifactHash) throw new Error("This runtime no longer holds the active company policy; use the current production instance.");
    return releaseAuthorization(artifact.builderReleasePolicy!, artifact.roster);
  }
  async currentProduction(instanceId: string) {
    const { health } = await this.dependencies.host.current();
    if (health.instanceId !== instanceId) throw new Error("Live health identifies another Instance.");
    return health;
  }
  #binding() {
    const { artifact } = this.dependencies;
    return { instanceId: artifact.instance.id, bindingId: artifact.builder!.repository.proposalPublisherBinding,
      repositoryId: artifact.builder!.repository.repositoryId };
  }
  #key(id: string, testDigest?: string) { return `release:candidate:${sha256([this.dependencies.artifact.instance.id, id, ...(testDigest ? [testDigest] : [])])}`; }
  async #record(candidate: ReleaseCandidate) {
    const record = await this.dependencies.state.get<CandidateRecord>(this.#key(candidate.id, candidate.functionalTestDigest))
      ?? (candidate.functionalTestDigest ? await this.dependencies.state.get<CandidateRecord>(this.#key(candidate.id)) : undefined);
    if (!record || sha256(record.candidate) !== sha256(candidate)) throw new Error("Release candidate differs from trusted preparation.");
    return record;
  }
  async prepareCandidate(job: BuilderJob): Promise<ReleaseCandidate> {
    const { artifact, github, state } = this.dependencies;
    if (await this.dependencies.revisionPending?.(job)) throw new Error("Changes were requested for this candidate.");
    const evidence = job.evidence as { proposal?: ProposalPublicationReceipt; validation?: CheckedProposal } | undefined;
    const published = evidence?.proposal; const checked = evidence?.validation;
    if (job.state !== "published" || !job.brief || !published || !checked?.validationPassed || !checked.releaseChangeClass
      || job.instanceId !== artifact.instance.id || job.repositoryId !== artifact.builder!.repository.repositoryId
      || job.baseCommit !== artifact.provenance.workspaceCommit || job.brief.artifactHash !== artifact.artifactHash
      || published.jobId !== job.jobId || published.baseCommit !== job.baseCommit || published.repositoryId !== job.repositoryId) throw new Error("Only the exact independently checked current Workspace proposal can be released.");
    const functionalTest = job.brief.brief.test.strategy === "test-resources"
      ? await this.dependencies.functionalTests?.releaseEvidence(job, false) : undefined;
    if (job.brief.brief.test.strategy !== "auto" && !functionalTest) throw new Error("This change requires its selected test evidence before automatic release.");
    rebindBuilderReleaseEnvironment({ previous: artifact, next: artifact,
      changedPaths: checked.changedPaths, environment: this.dependencies.environment });
    const url = new URL(published.proposalUrl);
    const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
    if (url.origin !== "https://github.com" || match?.[1] !== job.repositoryId) throw new Error("Published proposal URL does not identify the bound repository.");
    const input: GitHubCandidateInput = { repositoryId: job.repositoryId,
      targetBranch: artifact.builder!.repository.targetBranchName ?? "main", baseCommit: job.baseCommit,
      candidateCommit: published.proposalCommit, pullRequestNumber: Number(match[2]),
      changedPaths: checked.changedPaths, workbenchChecks: checked.checks, changeClass: checked.releaseChangeClass };
    const inspection = await github.withReleaseClient(this.#binding(), (client) => inspectGitHubCandidate(client, input));
    if ((!inspection.protectionEnforced && inspection.mergeStrategy !== "exact-fast-forward") || inspection.currentBase !== job.baseCommit || inspection.checks.some((check) => check.status !== "passed")) throw new Error("The exact merge strategy and all candidate checks must pass before acceptance.");
    const authority = await this.authorization(job.instanceId);
    const previous = await this.currentProduction(job.instanceId);
    if (previous.configurationDigest !== this.configurationDigest || previous.coreCommit !== artifact.provenance.coreCommit) throw new Error("Current production configuration differs from the compiled Instance.");
    const candidate: ReleaseCandidate = {
      version: 1, id: job.jobId, instanceId: job.instanceId, repositoryId: job.repositoryId,
      targetBranch: input.targetBranch, baseCommit: job.baseCommit, candidateCommit: input.candidateCommit,
      candidateTree: inspection.candidateTree, coreCommit: artifact.provenance.coreCommit,
      configurationDigest: this.configurationDigest, policyDigest: authority.policyDigest,
      diffDigest: inspection.diffDigest, changeClass: inspection.changeClass, requester: job.requesterPrincipal,
      sourceConversation: job.sourceConversationKey, requiredChecks: inspection.checks.map((check) => check.id),
      checksDigest: inspection.checksDigest, previousArtifactHash: previous.artifactHash,
      ...(functionalTest ? { functionalTestDigest: functionalTest.digest } : {}),
    };
    const key = this.#key(candidate.id, candidate.functionalTestDigest);
    const existing = await state.get<CandidateRecord>(key);
    if (existing && sha256(existing.candidate) !== sha256(candidate)) throw new Error("Candidate evidence changed; prepare a new proposal.");
    await state.setIfNotExists(key, { candidate, github: input, previous, job } satisfies CandidateRecord);
    return candidate;
  }
  async inspect(candidate: ReleaseCandidate) {
    const record = await this.#record(candidate);
    await this.#assertFunctionalTest(record);
    return await this.dependencies.github.withReleaseClient(this.#binding(), (client) => inspectGitHubCandidate(client, record.github));
  }
  async merge(context: ReleaseExecutionContext) {
    const record = await this.#record(context.candidate);
    await this.#assertFunctionalTest(record);
    const receipt = await this.dependencies.github.withReleaseClient(this.#binding(), (client) => mergeGitHubCandidate(client, record.github, context.candidate));
    return receipt ? { state: "succeeded" as const, receipt } : { state: "pending" as const };
  }
  async #assertFunctionalTest(record: CandidateRecord) {
    if (await this.dependencies.revisionPending?.({ jobId: record.candidate.id })) throw new Error("This candidate has a pending revision.");
    if (!record.candidate.functionalTestDigest) return;
    if (!record.job || !this.dependencies.functionalTests) throw new Error("Functional test evidence is unavailable.");
    const result = await this.dependencies.functionalTests.releaseEvidence(record.job, true);
    if (result.digest !== record.candidate.functionalTestDigest) throw new Error("The accepted functional test changed.");
  }
  async acceptFunctionalTest(candidate: ReleaseCandidate, actor: string, actionId: string) {
    if (await this.dependencies.revisionPending?.({ jobId: candidate.id })) throw new Error("This candidate has a pending revision.");
    if (!candidate.functionalTestDigest) return;
    authorizeRelease(candidate, actor, await this.authorization(candidate.instanceId));
    const record = await this.#record(candidate), tests = this.dependencies.functionalTests;
    if (!record.job || !tests) throw new Error("Functional test evidence is unavailable.");
    const { session, digest } = await tests.releaseEvidence(record.job, false);
    if (digest !== candidate.functionalTestDigest) throw new Error("The displayed test result is stale.");
    if (session.stage === "accepted") {
      if (session.acceptance?.principal !== actor) throw new Error("The test was accepted by another human.");
      return;
    }
    await tests.accept(session.id, { principal: actor, actionId, resultDigest: digest, acceptedAt: new Date().toISOString() });
  }
  async compileTestArtifact(job: BuilderJob): Promise<CompanyOSArtifact> {
    const { artifact, github, compiler, state } = this.dependencies;
    const { proposal, checked, brief } = checkedBuilderProposal(job);
    if (job.instanceId !== artifact.instance.id || job.repositoryId !== artifact.builder!.repository.repositoryId
      || job.baseCommit !== artifact.provenance.workspaceCommit || brief.artifactHash !== artifact.artifactHash) throw new Error("Test source does not match the current Workspace.");
    await this.authorization(job.instanceId);
    const key = `builder:test-artifact:${sha256([job.jobId, proposal.proposalCommit, this.configurationDigest])}`;
    const existing = await state.get<{ artifactHash: string }>(key);
    if (existing) {
      const retained = await this.dependencies.artifacts.getArtifact(existing.artifactHash);
      if (!retained || retained.provenance.workspaceCommit !== proposal.proposalCommit || retained.provenance.coreCommit !== artifact.provenance.coreCommit
        || retained.provenance.instanceConfigurationDigest !== this.configurationDigest) throw new Error("Retained test Artifact has different provenance.");
      return retained;
    }
    const temp = await mkdtemp(join(tmpdir(), "companyos-test-compile-"));
    try {
      const source = await github.materialize({ schemaVersion: 1, requestId: `${job.jobId}:test`, instanceId: job.instanceId,
        bindingId: artifact.builder!.repository.sourceBinding, repositoryId: job.repositoryId, baseCommit: proposal.proposalCommit, destinationPath: join(temp, "workspace") });
      if (!source.transfer) throw new Error("Test compilation requires the credential-free source bundle.");
      const { artifact: compiled } = await compiler.compileArtifact({ operationId: `${job.jobId}:test`,
        sourceBundlePath: source.transfer.path, workspaceCommit: proposal.proposalCommit, coreCommit: artifact.provenance.coreCommit,
        instanceId: job.instanceId, configurationDigest: this.configurationDigest, recordsBuildInputs: retainedRecordsBuildInputs(artifact) });
      const { artifactHash, ...content } = compiled;
      if (sha256({ ...content, provenance: { ...content.provenance, builtAt: undefined } }) !== artifactHash
        || compiled.provenance.workspaceCommit !== proposal.proposalCommit || compiled.provenance.coreCommit !== artifact.provenance.coreCommit
        || compiled.instance.id !== artifact.instance.id || compiled.provenance.instanceConfigurationDigest !== this.configurationDigest) throw new Error("Test Artifact provenance is invalid.");
      rebindBuilderReleaseEnvironment({ previous: artifact, next: compiled, changedPaths: checked.changedPaths, environment: this.dependencies.environment });

      await this.dependencies.artifacts.putArtifact(compiled);
      await state.setIfNotExists(key, { artifactHash });
      return compiled;
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  #builtKey(candidate: ReleaseCandidate) { return `release:artifact:${sha256(candidate)}`; }
  async build(context: ReleaseExecutionContext & { merge: MergeReceipt }) {
    const { state, github, compiler, artifact, host } = this.dependencies;
    const record = await this.#record(context.candidate);
    const key = this.#builtKey(context.candidate);
    let built = await state.get<BuiltRecord>(key);
    if (!built) {
      const temp = await mkdtemp(join(tmpdir(), "companyos-release-"));
      try {
        const source = await github.materialize({ schemaVersion: 1, requestId: context.operationId,
          instanceId: context.candidate.instanceId, bindingId: artifact.builder!.repository.sourceBinding,
          repositoryId: context.candidate.repositoryId, baseCommit: context.merge.mergedCommit, destinationPath: join(temp, "workspace") });
        if (!source.transfer) throw new Error("Hosted release requires a credential-free source bundle.");
        const { artifact: compiled } = await compiler.compileArtifact({ operationId: context.operationId, sourceBundlePath: source.transfer.path,
          workspaceCommit: context.merge.mergedCommit, coreCommit: context.candidate.coreCommit,
          instanceId: context.candidate.instanceId, configurationDigest: this.configurationDigest, recordsBuildInputs: retainedRecordsBuildInputs(artifact) });
        const { artifactHash, ...content } = compiled;
        if (sha256({ ...content, provenance: { ...content.provenance, builtAt: undefined } }) !== artifactHash
          || compiled.provenance.workspaceCommit !== context.merge.mergedCommit || compiled.provenance.coreCommit !== context.candidate.coreCommit
          || compiled.instance.id !== context.candidate.instanceId || compiled.instance.environment !== "production"
          || compiled.provenance.instanceConfigurationDigest !== this.configurationDigest) throw new Error("Compiled artifact provenance is invalid.");

        const environmentOverrides = rebindBuilderReleaseEnvironment({ previous: artifact, next: compiled,
          changedPaths: record.github.changedPaths, environment: this.dependencies.environment });

        built = { receipt: { artifactHash, coreCommit: compiled.provenance.coreCommit, workspaceCommit: compiled.provenance.workspaceCommit,
          instanceId: compiled.instance.id, environment: "production", configurationDigest: this.configurationDigest },
          environmentOverrides,
          encodedArtifact: gzipSync(JSON.stringify(compiled)).toString("base64") };
        await state.setIfNotExists(key, built);
        built = (await state.get<BuiltRecord>(key))!;
      } finally { await rm(temp, { recursive: true, force: true }); }
    }
    if (built.receipt.workspaceCommit !== context.merge.mergedCommit) throw new Error("Stored build does not match the merged Workspace.");
    const retained = JSON.parse(gunzipSync(Buffer.from(built.encodedArtifact, "base64")).toString("utf8")) as CompanyOSArtifact;
    if (retained.artifactHash !== built.receipt.artifactHash) throw new Error("Retained Artifact differs from its release receipt.");
    await this.dependencies.artifacts.putArtifact(retained);
    const verifiedArtifact = await this.dependencies.artifacts.getArtifact(retained.artifactHash);
    if (!verifiedArtifact || verifiedArtifact.artifactHash !== built.receipt.artifactHash) throw new Error("Release Artifact was not durably retained.");
    const staged = await host.stage({ operationId: context.operationId, previous: record.previous, artifact: built.receipt, encodedArtifact: built.encodedArtifact,
      retainedArtifactHash: retained.artifactHash, environmentOverrides: built.environmentOverrides });
    if (!staged) return { state: "pending" as const };
    await state.set(key, { ...built, deploymentId: staged.id });
    return { state: "succeeded" as const, receipt: built.receipt };
  }
  async deploy(context: ReleaseExecutionContext & { artifact: ProductionArtifactReceipt; previousArtifactHash: string }) {
    const built = await this.dependencies.state.get<BuiltRecord>(this.#builtKey(context.candidate));
    if (!built?.deploymentId || sha256(built.receipt) !== sha256(context.artifact)) throw new Error("Release has no completed production build.");
    const receipt = await this.dependencies.host.promote({ deploymentId: built.deploymentId, artifact: context.artifact, previousArtifactHash: context.previousArtifactHash });
    return receipt ? { state: "succeeded" as const, receipt } : { state: "pending" as const };
  }
  async verify(context: ReleaseExecutionContext & { deployment: DeploymentReceipt }) {
    const receipt = await this.currentProduction(context.candidate.instanceId);
    if (receipt.deploymentId !== context.deployment.deploymentId || receipt.artifactHash !== context.deployment.artifactHash) return { state: "pending" as const };
    return { state: "succeeded" as const, receipt };
  }
  async reconcileDeployment(context: ReleaseExecutionContext & { artifact: ProductionArtifactReceipt }) {
    const built = await this.dependencies.state.get<BuiltRecord>(this.#builtKey(context.candidate));
    if (!built?.deploymentId || sha256(built.receipt) !== sha256(context.artifact)) return undefined;
    const current = await this.currentProduction(context.candidate.instanceId);
    return current.deploymentId === built.deploymentId && current.artifactHash === context.artifact.artifactHash
      ? { ...context.artifact, deploymentId: built.deploymentId } : undefined;
  }
}
