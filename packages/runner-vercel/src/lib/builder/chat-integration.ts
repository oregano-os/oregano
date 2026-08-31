import { randomUUID } from "node:crypto";
import { jsonSchema, tool, type ToolSet } from "ai";
import { Actions, Button, Card, CardText, type Author, type Chat, type StateAdapter, type Thread } from "chat";
import type { CompanyOSArtifact, CompiledAgent } from "../../../../companyos-builder/types.ts";
import { sha256 } from "../../../../runtime/canonical.ts";
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
      if (!builder) throw new Error("Builder Agent is compiled without an enabled Instance Builder binding.");

      const output: ToolSet = {};
      output.builder_propose_change = tool({
          description: [
            "Prepare the controlled builder.propose_change confirmation.",
            "Use only after the human's objective and scope are clear.",
            "This posts a confirmation card and does not start a coding agent.",
          ].join(" "),
          inputSchema: jsonSchema({
            type: "object",
            additionalProperties: false,
            required: ["objective"],
            properties: {
              objective: {
                type: "string",
                minLength: 1,
                maxLength: 20_000,
                description: "The exact Company Workspace change objective shown to the human.",
              },
            },
          }),
          execute: async (input: unknown) => {
            const objective = typeof input === "object" && input !== null
              ? (input as { objective?: unknown }).objective
              : undefined;
            if (typeof objective !== "string" || objective.trim() === "") {
              throw new Error("builder.propose_change requires a non-empty objective.");
            }
            const requestId = `builder-request-${sha256(`${messageId}:${objective}`).slice(0, 32)}`;
            const token = randomUUID();
            const pending: PendingBuilderConfirmation = {
              requestId,
              requesterPrincipal: requester,
              sourceConversationKey: thread.id,
              objective: objective.trim(),
              repositoryId: builder.repository.repositoryId,
              baseCommit: args.artifact.provenance.workspaceCommit,
              ...(builder.repository.targetBranchName
                ? { targetBranchName: builder.repository.targetBranchName }
                : {}),
            };
            await args.state.set(`builder-confirmation:${token}`, pending, DAY);
            await thread.post(Card({
              title: "Confirm CompanyOS Builder proposal",
              children: [
                CardText(`Objective: ${pending.objective}`),
                CardText(`Repository: ${pending.repositoryId}`),
                CardText(`Exact base: ${pending.baseCommit}`),
                ...(pending.targetBranchName ? [CardText(`Proposal target: ${pending.targetBranchName}`)] : []),
                CardText("Claude Code or Codex starts only after confirmation. It can propose a checked pull request but cannot merge or deploy."),
                Actions([
                  Button({ id: "companyos.builder.confirm", label: "Start proposal", style: "primary", value: token }),
                  Button({ id: "companyos.builder.cancel", label: "Cancel", style: "danger", value: token }),
                ]),
              ],
            }));
            return {
              ok: true,
              pendingConfirmation: true,
              operation: "builder.propose_change",
              requestId,
              baseCommit: pending.baseCommit,
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
        const job = await createJobs().create(
          builderJobInputForConfirmedProposal(builder, {
            requestId: pending.requestId,
            instanceId: args.artifact.instance.id,
            requesterPrincipal: pending.requesterPrincipal,
            sourceConversationKey: pending.sourceConversationKey,
            sourceMessageId: event.messageId,
            objective: pending.objective,
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
