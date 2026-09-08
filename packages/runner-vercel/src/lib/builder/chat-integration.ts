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
import type { BuilderJobStore } from "../../../../state-store/builder-jobs.ts";
import type { RosterMember } from "../../../../state-store/roster.ts";
import {
  builderCancelledActionCard,
  builderQueuedActionCard,
  resolveBuilderActionCard,
} from "./action-cards.ts";
import { runnerTurnPresentation } from "./presentation.ts";

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
}): BuilderChatIntegration {
  const createJobs = args.createJobs ?? createPostgresBuilderJobStore;

  return {
    proposalTools({ agent, thread, requester, messageId }) {
      if (agent.id !== "builder") return {} satisfies ToolSet;
      const builder = args.artifact.builder;
      const contextKey = `builder-context:${sha256({ artifact: args.artifact.artifactHash, requester, thread: thread.id })}`;

      const output: ToolSet = {};
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
      output.builder_propose_change = tool({
          description: [
            "Start the requested isolated coding job from the resolved, source-grounded brief.",
            "Use only after the human's objective and scope are clear and material questions are resolved.",
            "This builds a reviewable proposal; it never accepts the result or deploys production.",
          ].join(" "),
          inputSchema: jsonSchema(JSON.parse(JSON.stringify(BUILDER_BRIEF_SCHEMA))),
          execute: async (input: unknown) => {
            if (!builder) throw new Error("Builder can clarify this change, but coding requires the Instance repository and execution bindings to be configured.");
            const parsed = parseBuilderBrief(input);
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
            const requestId = `builder-request-${sha256(`${requester}:${thread.id}:${messageId}:${brief.digest}`).slice(0, 32)}`;
            const job = await createJobs().create(builderJobInputForConfirmedProposal(builder, {
              requestId,
              instanceId: args.artifact.instance.id,
              requesterPrincipal: requester,
              sourceConversationKey: thread.id,
              objective,
              brief,
              repositoryId: builder.repository.repositoryId,
              baseCommit: brief.workspaceCommit,
            }));
            await thread.post(builderQueuedActionCard(job));
            return {
              ok: true,
              codingJobStarted: true,
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
