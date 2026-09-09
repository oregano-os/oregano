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
    || (await args.state.get<{ kind: string }>(builderProposalDecisionKey(job.jobId)))?.kind === "revision";
  const jobs = createPostgresBuilderJobStore();
  const functionalTests = new BuilderFunctionalTests(createPostgresBuilderTestStore());
  const host = new VercelProductionReleaseHost({ binding, state, token: process.env.COMPANYOS_VERCEL_RELEASE_TOKEN ?? "",
    ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? { healthHeaders: { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET } } : {}) });
  const execution = new HostedBuilderReleaseAdapter({ artifact, state, host, functionalTests, revisionPending,
    knowledge: createPostgresKnowledgeProvider(), environment: process.env,
    artifacts: createPostgresWorkflowExecutionStore({ prepareArtifactSchema: false }),
    github: getGitHubRepositoryProvider(), compiler: getTrustedGitExecution() });
  const coordinator = new ReleaseCoordinator({ store: createPostgresReleaseRunStore(), execution,
    leaseMs: 300000, notify: async (run) => integration.notify(run) });
  const integration = createBuilderReleaseIntegration({ ...args, coordinator, present, revisionPending,
    getTestSession: (job) => functionalTests.store.get(builderTestSessionId(job)),
    prepareCandidate: (job) => execution.prepareCandidate(job), beforeAccept: async (candidate, actor, actionId) => {
      authorizeRelease(candidate, actor, await execution.authorization(candidate.instanceId));
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
