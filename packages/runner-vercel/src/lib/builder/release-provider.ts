import { sha256 } from "../../../../runtime/canonical.ts";
import { builderDecisionKey, builderOperationLock, builderSelectionKey, type BuilderRequestReference } from "../../../../runtime/builder/experience.ts";
import { discardBuilder } from "../../../../runtime/builder/discard.ts";
import { checkedBuilderProposal } from "../../../../runtime/builder/functional-tests.ts";
import { discardGitHubProposal } from "../../../../connectors/github-release.ts";
import { createSlackBuilderTestSurface } from "./functional-tests.ts";
import type { Author, Chat, StateAdapter } from "chat";
import { ReleaseCoordinator, authorizeRelease } from "../../../../runtime/release/coordinator.ts";
import { createPostgresReleasePrivateState, createPostgresReleaseRunStore } from "../../../../state-postgres/release-run-store.ts";
import { VercelProductionReleaseHost, type VercelReleaseBinding } from "../../../../connectors/vercel-release.ts";
import { loadArtifact } from "../artifact.ts";
import { getGitHubRepositoryProvider, getTrustedGitExecution } from "./provider-factory.ts";
import { HostedBuilderReleaseAdapter } from "./live-release-adapter.ts";
import { createBuilderReleaseIntegration } from "./release-integration.ts";
import { createBuilderChatNotifier } from "./chat-notifier.ts";
import { createPostgresKnowledgeProvider } from "../../../../state-postgres/knowledge-store.ts";
import { createPostgresWorkflowExecutionStore } from "../../../../state-postgres/workflow-store.ts";
import { createPostgresBuilderTestStore } from "../../../../state-postgres/builder-test-store.ts";
import { BuilderFunctionalTests, builderTestSessionId } from "../../../../runtime/builder/functional-tests.ts";
import { createBuilderFunctionalTestIntegration, builderProposalFeedbackKey, builderProposalDecisionKey } from "./functional-tests.ts";
import { executeBuilderFunctionalTest } from "./functional-test-execution.ts";
import { createBuilderCardPresenter } from "./card-presenter.ts";
import { createPostgresBuilderJobStore } from "../../../../state-postgres/builder-job-store.ts";

export function builderConfigurationDigest(): string | undefined {
  return loadArtifact().provenance.instanceConfigurationDigest;
}
export function createBuilderReleaseRuntime(args: {
  chat: Chat; state: StateAdapter; authenticatedPrincipal(author: Author): string | undefined;
}) {
  const artifact = loadArtifact();
  const bindingValue = process.env.COMPANYOS_BUILDER_RELEASE_BINDING_BASE64;
  if (!bindingValue) return undefined;
  if (!artifact.builder || !artifact.builderReleasePolicy) throw new Error("Instance release binding requires the Workspace Builder and release policy.");
  const binding = JSON.parse(Buffer.from(bindingValue, "base64").toString("utf8")) as VercelReleaseBinding;
  const state = createPostgresReleasePrivateState();
  const present = createBuilderCardPresenter(args.chat, args.state);
  const revisionPending = async (job: { jobId: string }) => !!await args.state.get(builderProposalFeedbackKey(job.jobId))
    || ["revision", "discarding", "discarded"].includes((await args.state.get<{ kind: string }>(builderProposalDecisionKey(job.jobId)))?.kind ?? "");
  const jobs = createPostgresBuilderJobStore();
  const functionalTests = new BuilderFunctionalTests(createPostgresBuilderTestStore(), () => new Date(), artifact.builder.testInactivityDays ?? 7);
  const host = new VercelProductionReleaseHost({ binding, state, token: process.env.COMPANYOS_VERCEL_RELEASE_TOKEN ?? "",
    ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? { healthHeaders: { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET } } : {}) });
  const execution = new HostedBuilderReleaseAdapter({ artifact, state, host, functionalTests, revisionPending,
    knowledge: createPostgresKnowledgeProvider(), environment: process.env,
    artifacts: createPostgresWorkflowExecutionStore({ prepareArtifactSchema: false }),
    github: getGitHubRepositoryProvider(), compiler: getTrustedGitExecution() });
  const coordinator = new ReleaseCoordinator({ store: createPostgresReleaseRunStore(), execution,
    leaseMs: 300000, notify: async (run) => integration.notify(run) });
  const surface = createSlackBuilderTestSurface(artifact, args.chat);
  const integration = createBuilderReleaseIntegration({ ...args, coordinator, present, revisionPending,
    getJob: id => jobs.get(id),
    isSelected: async job => (await args.state.get<BuilderRequestReference>(builderSelectionKey(job.instanceId, job.requesterPrincipal)))?.jobId === job.jobId,
    testChannelUrl: job => { const resource = artifact.builder!.testResources?.find(item => item.capability === "communication.message.publish" && job.brief?.brief.test.targetBindings.includes(item.id)); return resource ? surface.destination(resource.match.destination_binding!).url : undefined; },
    withBuildLock: async (jobId, action) => {
      const lock = await args.state.acquireLock(builderOperationLock(jobId), 300000);
      if (!lock) throw new Error("A test or decision is still running.");
      try { return await action(); } finally { await args.state.releaseLock(lock); }
    },
    discard: (job, actor) => discardBuilder({ job, actor, state: args.state, tests: functionalTests,
      closeProposal: async job => {
        const { proposal } = checkedBuilderProposal(job), url = new URL(proposal.proposalUrl);
        const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
        if (url.origin !== "https://github.com" || match?.[1] !== job.repositoryId) throw new Error("Proposal repository differs.");
        return getGitHubRepositoryProvider().withReleaseClient({ instanceId: job.instanceId, bindingId: artifact.builder!.repository.proposalPublisherBinding, repositoryId: job.repositoryId }, client =>
          discardGitHubProposal(client, { repositoryId: job.repositoryId, number: Number(match[2]), candidateCommit: proposal.proposalCommit, baseCommit: job.baseCommit }));
      } }),
    getTestSession: (job) => functionalTests.store.get(builderTestSessionId(job)),
    prepareCandidate: (job) => execution.prepareCandidate(job), beforeAccept: async (candidate, actor, actionId) => {
      authorizeRelease(candidate, actor, await execution.authorization(candidate.instanceId));
      const job = await jobs.get(candidate.id);
      if (!job || sha256(await execution.prepareCandidate(job)) !== sha256(candidate)) throw new Error("The displayed candidate is no longer ready or current.");
      if (!candidate.functionalTestDigest) {
        const key = builderProposalDecisionKey(candidate.id), decision = { kind: "release", actor, digest: candidate.diffDigest };
        if (!await args.state.setIfNotExists(key, decision)) {
          const existing = await args.state.get<typeof decision>(key);
          if (existing?.kind !== decision.kind || existing.actor !== actor || existing.digest !== decision.digest) throw new Error("This result already has another decision.");
        }
      }
      await execution.acceptFunctionalTest(candidate, actor, actionId);
    },
    fallback: createBuilderChatNotifier(args.chat, present) });
  const tests = createBuilderFunctionalTestIntegration({ ...args, artifact, tests: functionalTests, present, getJob: (id) => jobs.get(id),
    compile: (job) => execution.compileTestArtifact(job),
    execute: (candidate, session) => executeBuilderFunctionalTest({ artifact: candidate, production: artifact, session, store: functionalTests.store, chat: args.chat }),
    ready: integration.notifier, fallback: createBuilderChatNotifier(args.chat, present) });
  return { ...integration, notifier: tests.notifier, receive: tests.receive,
    registerHandlers() { integration.registerHandlers(); tests.registerHandlers(); },
    advance: (workerId: string) => coordinator.advance(artifact.instance.id, workerId) };
}
