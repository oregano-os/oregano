import { builderProgressPresentation } from "../../../../runtime/builder/presentation.ts";
import { renderBuilderCard } from "./result-card.ts";
import { Actions, Button, Card, CardText, type ActionEvent, type CardElement } from "chat";
import type { BuilderJob } from "../../../../state-store/builder-jobs.ts";

type BuilderActionEvent = Pick<ActionEvent, "adapter" | "messageId" | "threadId">;
export type BuilderActionCard = CardElement;
type BuilderConfirmationDetails = Pick<
  BuilderJob,
  "baseCommit" | "jobId" | "objective" | "repositoryId" | "targetBranchName"
>;

export function builderTerminalActionCard(job: BuilderJob): BuilderActionCard {
  if (job.state !== "published" && job.state !== "failed" && job.state !== "cancelled") {
    throw new Error(`Builder job '${job.jobId}' is not terminal.`);
  }
  const outcome = job.state === "published"
    ? "Your build request is ready for review. Review the result before publication."
    : job.state === "cancelled"
      ? "The Builder job was cancelled. No proposal was published."
      : "Development could not finish. No result was published. Ask Builder to review the recorded failure before trying again.";
  const proposalUrl = job.state === "published" ? proposalUrlFromEvidence(job.evidence) : undefined;
  return Card({
    title: job.state === "published"
      ? "Ready for review"
      : job.state === "cancelled"
        ? "Build request cancelled"
        : "Build request stopped",
    children: [
      CardText(job.objective),
      CardText(outcome),
      ...(proposalUrl ? [CardText(`Technical details: ${proposalUrl}`)] : []),
    ],
  }) as CardElement;
}

export function builderQueuedActionCard(job: BuilderConfirmationDetails): BuilderActionCard {
  return renderBuilderCard(builderProgressPresentation(job, "queued"));
}
export function builderProgressCard(job: BuilderJob, phase: "preparing" | "coding" | "checking" | "testing"): CardElement {
  return renderBuilderCard(builderProgressPresentation(job, phase));
}

export function builderCancelledActionCard(
  confirmation: Omit<BuilderConfirmationDetails, "jobId">,
): BuilderActionCard {
  return Card({
    title: "CompanyOS Builder proposal cancelled",
    children: [
      CardText(`Objective: ${confirmation.objective}`),
      CardText(`Repository: ${confirmation.repositoryId}`),
      CardText(`Exact base: ${confirmation.baseCommit}`),
      ...(confirmation.targetBranchName
        ? [CardText(`Proposal target: ${confirmation.targetBranchName}`)]
        : []),
      CardText("No coding agent was started."),
    ],
  }) as CardElement;
}

export async function resolveBuilderActionCard(
  event: BuilderActionEvent,
  card: BuilderActionCard,
  consumeConfirmation: () => Promise<void>,
): Promise<void> {
  await event.adapter.editMessage(event.threadId, event.messageId, card);
  await consumeConfirmation();
}

function proposalUrlFromEvidence(evidence: unknown): string | undefined {
  if (!evidence || typeof evidence !== "object") return undefined;
  const proposal = (evidence as Record<string, unknown>).proposal;
  if (!proposal || typeof proposal !== "object") return undefined;
  const value = (proposal as Record<string, unknown>).proposalUrl;
  return typeof value === "string" && /^https:\/\//.test(value) ? value : undefined;
}
