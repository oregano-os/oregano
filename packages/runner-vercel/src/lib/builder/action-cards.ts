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
    ? "The checked draft proposal is ready for human review. Nothing was merged or deployed."
    : job.state === "cancelled"
      ? "The Builder job was cancelled. No proposal was published."
      : `The Builder job failed closed. No proposal was published. Reason: ${job.terminalReason ?? "unknown"}`;
  const proposalUrl = job.state === "published" ? proposalUrlFromEvidence(job.evidence) : undefined;
  return Card({
    title: job.state === "published"
      ? "CompanyOS Builder proposal ready for review"
      : job.state === "cancelled"
        ? "CompanyOS Builder proposal cancelled"
        : "CompanyOS Builder proposal failed closed",
    children: [
      CardText(`Job: ${job.jobId}`),
      CardText(`Objective: ${job.objective}`),
      CardText(`Repository: ${job.repositoryId}`),
      CardText(`Exact base: ${job.baseCommit}`),
      ...(job.targetBranchName ? [CardText(`Proposal target: ${job.targetBranchName}`)] : []),
      CardText(outcome),
      ...(proposalUrl ? [CardText(`Draft proposal: ${proposalUrl}`)] : []),
    ],
  }) as CardElement;
}

export function builderQueuedActionCard(job: BuilderConfirmationDetails): BuilderActionCard {
  return Card({
    title: "CompanyOS Builder proposal queued",
    children: [
      CardText(`Job: ${job.jobId}`),
      CardText(`Objective: ${job.objective}`),
      CardText(`Repository: ${job.repositoryId}`),
      CardText(`Exact base: ${job.baseCommit}`),
      ...(job.targetBranchName ? [CardText(`Proposal target: ${job.targetBranchName}`)] : []),
      CardText("The coding worker runs asynchronously; merge and deployment remain human decisions."),
      Actions([
        Button({ id: "companyos.builder.stop", label: "Request cancellation", style: "danger", value: job.jobId }),
      ]),
    ],
  }) as CardElement;
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
