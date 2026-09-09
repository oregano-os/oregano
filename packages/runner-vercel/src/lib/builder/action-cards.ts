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
  return Card({
    title: "Build request received",
    children: [
      CardText(job.objective),
      CardText("I’m passing your request to the coding agent. I’ll let you know when development starts."),
      Actions([
        Button({ id: "companyos.builder.stop", label: "Cancel request", style: "danger", value: job.jobId }),
      ]),
    ],
  }) as CardElement;
}

export function builderProgressCard(job: BuilderJob, phase: "preparing" | "coding" | "checking" | "testing"): CardElement {
  const name = job.codingAgent.profileId === "claude-code" ? "Claude Code" : job.codingAgent.profileId === "codex" ? "Codex" : "The coding agent";
  return Card({ title: phase === "coding" ? `${name} is working on your request`
    : phase === "checking" ? "Checking your result" : phase === "testing" ? "Preparing your test" : "Preparing your build request",
    children: [CardText(job.objective), CardText(phase === "coding" ? "Development has started. Next, the result will be checked and the agreed test prepared."
      : phase === "checking" ? "Development has finished. The proposed result is being checked before review."
      : phase === "testing" ? "The checked version is being prepared for the agreed test."
      : "The workspace and coding environment are being prepared. Development has not started yet."),
      ...(phase === "preparing" || phase === "coding" ? [Actions([Button({ id: "companyos.builder.stop", label: "Cancel request", value: job.jobId })])] : []),
    ] });
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
