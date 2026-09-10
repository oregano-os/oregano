import { jsonSchema, tool, type ToolSet } from "ai";
import { type Author, type Chat, type StateAdapter, type Thread } from "chat";
import type { CompanyOSArtifact, CompiledAgent } from "../../../../companyos-builder/types.ts";
import { sha256 } from "../../../../runtime/canonical.ts";
import {
  BUILDER_BRIEF_SCHEMA, assertBuilderContextPath, groundBuilderBrief, parseBuilderBrief,
  type BuilderContextRead, type GroundedBuilderBrief,
} from "../../../../runtime/builder/brief.ts";
import { builderJobInputForConfirmedProposal } from "../../../../runtime/builder/service.ts";
import { createPostgresBuilderJobStore } from "../../../../state-postgres/builder-job-store.ts";
import type { BuilderJob, BuilderJobStore } from "../../../../state-store/builder-jobs.ts";
import type { RosterMember } from "../../../../state-store/roster.ts";
import {
  builderCancelledActionCard,
  builderQueuedActionCard,
  resolveBuilderActionCard,
} from "./action-cards.ts";
import { runnerTurnPresentation } from "./presentation.ts";
import { builderFeedbackKey, builderProposalFeedbackKey, builderProposalFeedbackConversation } from "./functional-tests.ts";
import { BuilderFunctionalTests, builderTestSessionId, type BuilderTestSession } from "../../../../runtime/builder/functional-tests.ts";
import { assertBuilderTestScope } from "./functional-test-execution.ts";
import type { BuilderCardPresenter } from "./card-presenter.ts";

import { createPostgresBuilderTestStore } from "../../../../state-postgres/builder-test-store.ts";
import { assertBuilderDevelopmentIntent, type BuilderTurnIntent } from "../../../../runtime/builder/turn-intent.ts";
import { builderCurrentRequestKey, builderUserLock, builderOperationLock, builderDecisionKey, rememberBuilderRequest, selectBuilderRequest, type BuilderRequestReference } from "../../../../runtime/builder/experience.ts";

const DAY = 24 * 60 * 60 * 1000;

interface PendingBuilderConfirmation {
  readonly requestId: string;
  readonly requesterPrincipal: string;
  readonly sourceConversationKey: string;
  readonly objective: string;
  readonly brief: GroundedBuilderBrief;
  readonly repositoryId: string;
  readonly baseCommit: string;
  readonly targetBranchName?: string;
}

export interface BuilderChatIntegration {
  proposalTools(args: {
    agent: CompiledAgent;
    thread: Thread;
    requester: string;
    messageId: string;
    intent?: BuilderTurnIntent;
  }): ToolSet;
  presentTurn(
    generatedText: string,
    toolResults: readonly { readonly toolName: string; readonly output: unknown }[],
  ): { readonly historyResponse: string; readonly visibleResponse?: string };
  registerHandlers(bot: Chat): void;
}

export function createBuilderChatIntegration(args: {
  artifact: CompanyOSArtifact;
  state: StateAdapter;
  rosterMember(author: Author): RosterMember | undefined;
  principal(member: RosterMember): string;
  createJobs?: () => BuilderJobStore;
  present?: BuilderCardPresenter;
  createTests?: () => BuilderFunctionalTests;
  refreshResult?: (job: BuilderJob) => Promise<void>;
}): BuilderChatIntegration {
  const createJobs = args.createJobs ?? createPostgresBuilderJobStore;
  const createTests = args.createTests ?? (() => new BuilderFunctionalTests(createPostgresBuilderTestStore(), () => new Date(), args.artifact.builder?.testInactivityDays ?? 7));
  const withLock = async <T>(key: string, action: () => Promise<T>): Promise<T> => {
    const lock = await args.state.acquireLock(key, 300000);
    if (!lock) throw new Error("Another build operation is in progress. Please try again shortly.");
    try { return await action(); } finally { await args.state.releaseLock(lock); }
  };

  return {
    proposalTools({ agent, thread, requester, messageId, intent }) {
      if (agent.id !== "builder") return {} satisfies ToolSet;
      const builder = args.artifact.builder;
      const contextKey = `builder-context:${sha256({ artifact: args.artifact.artifactHash, requester, thread: thread.id })}`;

      const output: ToolSet = {};
      output.builder_instance_capabilities = tool({
        description: "Read currently configured Instance capabilities and designated test resources before choosing a connected test. Missing entries require Instance setup; never invent provider access.",
        inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
        execute: async () => ({ capabilities: args.artifact.bindings.map((binding) => ({ capability: binding.capability, version: binding.contractVersion })),
          testResources: builder?.testResources ?? [], supportedConnectedTests: ["single Agent reply without Tools", "interactive Agent conversation without Tools", "operator workflow without messages, timers or intermediate decisions"],
          testableAgents: args.artifact.agents?.filter((entry) => entry.id !== "builder" && entry.toolSet.tools.length === 0).map((entry) => entry.id) ?? [],
          providerAccess: "Configured bindings; actual provider access is independently verified during the test." }),
      });
      const currentRequest = async () => {
        const reference = await args.state.get<BuilderRequestReference>(builderCurrentRequestKey(args.artifact.instance.id, requester, thread.id));
        // Compatibility for reviews created before current-build indexing existed.
        const legacy = await args.state.get<BuilderTestSession>(builderFeedbackKey(thread.id, requester));
        const id = reference?.jobId ?? legacy?.jobId ?? await args.state.get<string>(builderProposalFeedbackConversation(thread.id, requester));
        const job = id ? await createJobs().get(id) : (await createJobs().listForRequester(args.artifact.instance.id, requester, thread.id))[0];
        return job?.instanceId === args.artifact.instance.id && job.requesterPrincipal === requester && job.sourceConversationKey === thread.id ? job : undefined;
      };
      output.builder_read_test_result = tool({
        description: "Read this conversation's current build, original brief, status, actual test answers and feedback. Use for questions and evaluations too; no Request Changes click is required. Reading never starts development.",
        inputSchema: jsonSchema({ type: "object", properties: { conversation: { type: "string", maxLength: 512 } }, additionalProperties: false }),
        execute: async (input: unknown) => {
          const job = await currentRequest();
          if (!job) return { available: false };
          const session = job.state === "published" && job.brief?.brief.test.strategy === "test-resources" ? await createTests().store.get(builderTestSessionId(job)) : undefined;
          const reference = (input as { conversation?: string })?.conversation;
          const histories = session?.testConversations ?? (session?.conversation && session.testConversation ? { [session.testConversation]: session.conversation } : {});
          if (reference && !Object.hasOwn(histories, reference)) throw new Error("That test conversation does not belong to this build.");
          const history = reference ? histories[reference] : session?.conversation;
          return { available: true, jobId: job.jobId, status: job.state, previousBrief: job.brief?.brief,
            test: session ? { stage: session.stage, candidateCommit: session.candidateCommit,
              result: session.result ? { summary: session.result.summary, completedAt: session.result.completedAt } : undefined,
              conversations: Object.entries(histories).map(([id, conversation]) => ({ id, replies: conversation.turns.length })),
              recentReplies: history?.turns.slice(-8).map(turn => ({ messageId: turn.messageId, prompt: turn.prompt, answer: turn.result.summary, completedAt: turn.result.completedAt })),
              repliesTruncated: (history?.turns.length ?? 0) > 8, testUrl: session.testUrl, feedback: session.feedback } : undefined,
            decision: await args.state.get(builderDecisionKey(job.jobId)) };
        },
      });
      output.builder_list_builds = tool({
        description: "List this authenticated user's recent build requests. Older open builds never block a new request. Use to locate an existing test the user explicitly wants to select or resume.",
        inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
        execute: async () => ({ builds: (await createJobs().listForRequester(args.artifact.instance.id, requester)).map(job => ({ jobId: job.jobId, objective: job.objective, status: job.state, createdAt: job.createdAt })) }),
      });
      if (intent?.kind === "select-test" && intent.messageId === messageId) output.builder_select_test = tool({
        description: "Select or resume the existing build explicitly requested by the human for their next new test-channel conversations. Existing test threads keep their original version. This does not develop anything.",
        inputSchema: jsonSchema({ type: "object", required: ["jobId"], properties: { jobId: { type: "string" } }, additionalProperties: false }),
        execute: async (input: unknown) => {
          const id = (input as { jobId?: string }).jobId, job = id ? await createJobs().get(id) : undefined;
          if (!job) throw new Error("Build not found.");
          return withLock(builderUserLock(args.artifact.instance.id, requester), () => withLock(builderOperationLock(job.jobId), async () => {
            if (job.instanceId !== args.artifact.instance.id || job.requesterPrincipal !== requester || job.state !== "published") throw new Error("Select only your own prepared build.");
            const tests = createTests(); let session = await tests.store.get(builderTestSessionId(job));
            if (!session?.conversation || !["expired", "interactive"].includes(session.stage)) throw new Error("This build has no available interactive test.");
            if (await args.state.get(builderDecisionKey(job.jobId))) throw new Error("This build already has a decision.");
            if (session.stage === "expired" || Date.parse(session.conversation.expiresAt) <= tests.now().getTime()) session = await tests.resume(session.id, requester);
            await selectBuilderRequest(args.state, args.artifact.instance.id, requester, job);
            return { selected: true, jobId: job.jobId, testUrl: session.testUrl, message: "Start a new conversation in the configured test channel. Existing conversations retain their version." };
          }));
        },
      });
      output.builder_list_context = tool({
        description: "Discover scoped Workspace files before discussing a change. Lists workflows, Agents, policies and structures actually available to this Builder. Search by name; read matching files before describing current behavior.",
        inputSchema: jsonSchema({ type: "object", additionalProperties: false, properties: { query: { type: "string", maxLength: 256 } } }),
        execute: async (input: unknown) => {
          const query = typeof (input as { query?: unknown })?.query === "string" ? String((input as { query: string }).query).toLowerCase() : "";
          if (query.length > 256) throw new Error("Builder context query is too long.");
          const paths = Object.keys(agent.materials).filter((path) => path.toLowerCase().includes(query)).sort();
          return { workspaceCommit: args.artifact.provenance.workspaceCommit, files: paths.slice(0, 100), total: paths.length, truncated: paths.length > 100, codingConfigured: !!builder, executionReadiness: "not-checked" };
        },
      });
      output.builder_read_context = tool({
        description: "Read one exact current Workspace definition within this Builder's compiled read scope. Reading records evidence for the build brief. Follow relevant workflow, Agent, Tool and policy references before choosing the change.",
        inputSchema: jsonSchema({ type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string", minLength: 1, maxLength: 512 } } }),
        execute: async (input: unknown) => {
          const path = (input as { path?: unknown })?.path;
          if (typeof path !== "string") throw new Error("Builder context path is required.");
          assertBuilderContextPath(path);
          if (!Object.hasOwn(agent.materials, path)) throw new Error(`'${path}' is outside the Builder read scope. Ask for the relevant definition or a scoped configuration change; do not guess.`);
          const content = agent.materials[path];
          if (content.length > 100000) throw new Error("This definition exceeds the bounded context-read limit; split it into referenced documents before Builder authoring.");
          const receipt: BuilderContextRead = { path, digest: sha256(content) };
          await args.state.set(`${contextKey}:${sha256(path)}`, receipt, DAY);
          return { ...receipt, workspaceCommit: args.artifact.provenance.workspaceCommit, content };
        },
      });
      if (intent && ["new-build", "revision"].includes(intent.kind)) output.builder_propose_change = tool({
          description: [
            "Start the requested isolated coding job from the resolved, source-grounded brief.",
            "Use only after the human's objective and scope are clear and material questions are resolved.",
            "This builds a reviewable proposal; it never accepts the result or deploys production.",
          ].join(" "),
          inputSchema: jsonSchema(JSON.parse(JSON.stringify(BUILDER_BRIEF_SCHEMA))),
          execute: async (input: unknown) => {
            assertBuilderDevelopmentIntent(intent, messageId);
            if (!builder) throw new Error("Builder can clarify this change, but coding requires the Instance repository and execution bindings to be configured.");
            const parsed = parseBuilderBrief(input);
            if (parsed.test.strategy === "simulate" || parsed.test.strategy === "live-trial") {
              throw new Error("Simulation and live trials are not available yet. Recommend automatic checks or a supported test on configured test resources.");
            }
            if (parsed.test.strategy === "test-resources") {
              if (!parsed.test.execution || !parsed.test.targetBindings.length
                || parsed.test.targetBindings.some((id) => !builder.testResources?.some((resource) => resource.id === id))) {
                throw new Error("Before coding, choose a concrete supported Agent or workflow test and existing qualified Instance test resources. Missing capabilities require Instance setup.");
              }
              const selected = builder.testResources!.filter((resource) => parsed.test.targetBindings.includes(resource.id));
              assertBuilderTestScope(args.artifact, selected);
              if (selected.filter((resource) => resource.capability === "communication.message.publish").length !== 1
                || selected.some((resource) => !args.artifact.bindings.some((binding) => binding.capability === resource.capability))) throw new Error("The selected test needs one configured test conversation and available capabilities.");
            }
            const paths = [...new Set([...parsed.contextRefs, ...parsed.targetPaths, ".companyos/governance.yaml", "handbook/roster.md"])];
            const receipts = await Promise.all(paths.map((path) => args.state.get<BuilderContextRead>(`${contextKey}:${sha256(path)}`)));
            const brief = groundBuilderBrief({
              input: parsed, artifactHash: args.artifact.artifactHash,
              workspaceCommit: args.artifact.provenance.workspaceCommit,
              materials: agent.materials,
              sourcePaths: agent.sourcePaths,
              reads: receipts.filter((receipt): receipt is BuilderContextRead => receipt !== null),
            });
            const objective = brief.brief.objective;
            const requestId = `builder-request-${sha256(`${requester}:${thread.id}:${messageId}`).slice(0, 32)}`;
            const job = await withLock(builderUserLock(args.artifact.instance.id, requester), async () => {
              const existing = await createJobs().getByRequestId(requestId);
              if (existing) { await rememberBuilderRequest(args.state, existing); return existing; }
              let parentSessionId: string | undefined;
              let revisedJob: BuilderJob | undefined;
              if (intent?.kind === "revision") {
                const previous = await currentRequest();
                if (!previous) throw new Error("No existing build was identified for this revision.");
                revisedJob = previous;
                await withLock(builderOperationLock(previous.jobId), async () => {
                  const decision = await args.state.get<{ kind: string }>(builderDecisionKey(previous.jobId));
                  if (decision && decision.kind !== "revision") throw new Error("This build already has a decision.");
                  if (previous.brief?.brief.test.strategy === "test-resources") {
                    const tests = createTests();
                    const session = await tests.store.get(builderTestSessionId(previous));
                    if (!session || session.stage === "accepted" || session.stage === "discarded") throw new Error("This build cannot be revised. Start a new build instead.");
                    if (session.stage !== "changes-requested") await tests.requestChanges(session.id, { principal: requester, messageId, text: intent.requestQuote!, receivedAt: new Date().toISOString() });
                    parentSessionId = session.id;
                  } else {
                    const key = builderDecisionKey(previous.jobId), decision = await args.state.get<{ kind: string }>(key);
                    if (decision && decision.kind !== "revision") throw new Error("This build already has a publication or discard decision.");
                    await args.state.set(key, { kind: "revision", actor: requester });
                    await args.state.set(builderProposalFeedbackKey(previous.jobId), { jobId: previous.jobId, feedback: { principal: requester, text: intent.requestQuote } });
                  }
                });
              }
              const created = await createJobs().create(builderJobInputForConfirmedProposal(builder, {
                requestId,
                instanceId: args.artifact.instance.id,
                requesterPrincipal: requester,
                sourceConversationKey: thread.id,
                objective,
                brief,
                repositoryId: builder.repository.repositoryId,
                baseCommit: brief.workspaceCommit,
              }));
              if (parentSessionId) await args.state.setIfNotExists(`builder:test-parent:${created.jobId}`, parentSessionId);
              await rememberBuilderRequest(args.state, created);
              if (revisedJob) await args.refreshResult?.(revisedJob);
              return created;
            });
            if (args.present) await args.present(job, builderQueuedActionCard(job), "queued");
            else await thread.post(builderQueuedActionCard(job));
            return {
              ok: true,
              codingJobSubmitted: true,
              operation: "builder.propose_change",
              requestId,
              jobId: job.jobId,
              state: job.state,
              briefDigest: brief.digest,
            };
          },
        });
      return output;
    },

    presentTurn: runnerTurnPresentation,

    registerHandlers(bot) {
      if (!args.artifact.builder) return;

      bot.onAction(["companyos.builder.confirm", "companyos.builder.cancel"], async (event) => {
        if (!event.thread || !event.value) return;
        const pending = await args.state.get<PendingBuilderConfirmation>(`builder-confirmation:${event.value}`);
        if (!pending) {
          await event.thread.post("This Builder confirmation is expired or was already resolved.");
          return;
        }
        if (event.thread.id !== pending.sourceConversationKey) {
          await event.thread.post("Builder confirmation refused: the action belongs to a different conversation.");
          return;
        }
        const member = args.rosterMember(event.user);
        if (!member) {
          await event.thread.post("Builder confirmation refused: this identity is not an active Company Workspace member.");
          return;
        }
        const confirmingPrincipal = args.principal(member);
        if (confirmingPrincipal !== pending.requesterPrincipal) {
          await event.thread.post("Builder confirmation refused: only the authenticated requester may confirm this exact proposal.");
          return;
        }
        if (event.actionId === "companyos.builder.cancel") {
          await resolveBuilderActionCard(
            event,
            builderCancelledActionCard({
              objective: pending.objective,
              repositoryId: pending.repositoryId,
              baseCommit: pending.baseCommit,
              ...(pending.targetBranchName ? { targetBranchName: pending.targetBranchName } : {}),
            }),
            () => args.state.delete(`builder-confirmation:${event.value}`),
          );
          return;
        }
        const builder = args.artifact.builder;
        if (!builder) {
          await event.thread.post("Builder confirmation refused: this Company Instance has no enabled Builder binding.");
          return;
        }
        if (!pending.brief || pending.brief.artifactHash !== args.artifact.artifactHash) {
          await event.thread.post("This request belongs to an older Workspace context. Re-read the affected process and prepare the current change before coding.");
          return;
        }
        const job = await createJobs().create(
          builderJobInputForConfirmedProposal(builder, {
            requestId: pending.requestId,
            instanceId: args.artifact.instance.id,
            requesterPrincipal: pending.requesterPrincipal,
            sourceConversationKey: pending.sourceConversationKey,
            sourceMessageId: event.messageId,
            objective: pending.objective,
            brief: pending.brief,
            repositoryId: pending.repositoryId,
            baseCommit: pending.baseCommit,
          }),
        );
        await withLock(builderUserLock(job.instanceId, job.requesterPrincipal), () => rememberBuilderRequest(args.state, job));
        await resolveBuilderActionCard(
          event,
          builderQueuedActionCard(job),
          () => args.state.delete(`builder-confirmation:${event.value}`),
        );
      });

      bot.onAction("companyos.builder.stop", async (event) => {
        if (!event.thread || !event.value) return;
        const member = args.rosterMember(event.user);
        if (!member) {
          await event.thread.post("Builder cancellation refused: this identity is not an active Company Workspace member.");
          return;
        }
        const jobs = createJobs();
        const job = await jobs.get(event.value);
        if (!job) {
          await event.thread.post("Builder cancellation refused: the job does not exist.");
          return;
        }
        if (event.thread.id !== job.sourceConversationKey) {
          await event.thread.post("Builder cancellation refused: the job belongs to a different conversation.");
          return;
        }
        if (args.principal(member) !== job.requesterPrincipal) {
          await event.thread.post("Builder cancellation refused: only the authenticated requester may stop this proposal.");
          return;
        }
        const updated = await jobs.requestCancellation(job.jobId);
        await event.thread.post(
          ["published", "failed", "cancelled"].includes(updated.state)
            ? `Builder job ${updated.jobId} is already ${updated.state}.`
            : `Cancellation requested for Builder job ${updated.jobId}.`,
        );
      });
    },
  };
}
