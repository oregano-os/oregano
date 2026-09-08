import { randomUUID } from "node:crypto";
import { Actions, Button, Card, CardText, type Author, type Chat, type StateAdapter } from "chat";
import { sha256 } from "../../../../runtime/canonical.ts";
import { assertReleaseCandidate, type ReleaseCoordinator } from "../../../../runtime/release/coordinator.ts";
import type { ReleaseCandidate } from "../../../../runtime/release/contracts.ts";
import type { ReleaseRun } from "../../../../state-store/release-runs.ts";
import type { BuilderJob } from "../../../../state-store/builder-jobs.ts";
import type { BuilderTerminalNotifier } from "../../../../runtime/builder/notifications.ts";

interface PendingRelease { candidate: ReleaseCandidate; digest: string; }
interface PendingReadiness { job: BuilderJob; }

/**
 * Optional trusted Runner binding. Do not expose this as an LLM Tool. Hosts
 * install it only with a qualified release executor and candidate preparer.
 * The unconfigured maintained Runner continues to publish reviewable drafts.
 */
export function createBuilderReleaseIntegration(args: {
  chat: Pick<Chat, "thread" | "onAction">;
  state: Pick<StateAdapter, "get" | "set">;
  coordinator: Pick<ReleaseCoordinator, "accept" | "rollback">;
  authenticatedPrincipal(author: Author): string | undefined;
  prepareCandidate(job: BuilderJob): Promise<ReleaseCandidate>;
  fallback: BuilderTerminalNotifier;
}) {
  const notifier: BuilderTerminalNotifier = {
    async deliver(job) {
      if (job.state !== "published" || !job.brief || job.brief.brief.deploymentIntent !== "after-acceptance") {
        await args.fallback.deliver(job); return;
      }
      let candidate: ReleaseCandidate;
      try { candidate = await args.prepareCandidate(job); }
      catch {
        // CI and provider readiness can lag behind draft publication. Deliver
        // the actual result now, with a read-only retry rather than losing the
        // terminal notification or pretending the change is ready to accept.
        await args.fallback.deliver(job);
        const token = randomUUID();
        await args.state.set(`builder-release-readiness:${token}`, { job } satisfies PendingReadiness, 24 * 60 * 60 * 1000);
        await args.chat.thread(job.sourceConversationKey).post(Card({ title: "Change built; live adoption pending", children: [
          CardText("The proposal is available. Required checks, production access or the selected test evidence are not yet ready. No live adoption has started."),
          Actions([Button({ id: "companyos.builder.release.refresh", label: "Check readiness", value: token })]),
        ] }));
        return;
      }
      assertReleaseCandidate(candidate);
      const published = (job.evidence as { proposal?: { proposalCommit?: string } } | undefined)?.proposal?.proposalCommit;
      if (candidate.instanceId !== job.instanceId || candidate.repositoryId !== job.repositoryId
        || candidate.baseCommit !== job.baseCommit || candidate.candidateCommit !== published
        || candidate.requester !== job.requesterPrincipal || candidate.sourceConversation !== job.sourceConversationKey) {
        throw new Error("Release preparation did not identify the published Builder result.");
      }
      const digest = sha256(candidate);
      const token = randomUUID();
      await args.state.set(`builder-release-candidate:${token}`, { candidate, digest } satisfies PendingRelease, 24 * 60 * 60 * 1000);
      const card = Card({ title: "Change ready for acceptance", children: [
        CardText(job.brief.brief.proposedBehavior),
        CardText(`Success criteria: ${job.brief.brief.acceptanceCriteria.join("; ")}`),
        CardText(`Production target: ${candidate.instanceId}. Candidate: ${candidate.candidateCommit.slice(0, 12)}.`),
        CardText("Accepting starts the checked merge, production build, deployment and verification if your current company permissions allow it."),
        ...(candidate.migration ? [CardText(`Includes migration ${candidate.migration.id}. Application rollback does not undo data changes.`)] : []),
        Actions([Button({ id: "companyos.builder.release", label: "Accept and make live", style: "primary", value: token })]),
      ] });
      const thread = args.chat.thread(job.sourceConversationKey);
      if (job.sourceMessageId) await thread.adapter.editMessage(thread.id, job.sourceMessageId, card);
      else await thread.post(card);
    },
  };
  const registerHandlers = () => {
    args.chat.onAction("companyos.builder.release.refresh", async (event) => {
      if (!event.thread || !event.value) return;
      const pending = await args.state.get<PendingReadiness>(`builder-release-readiness:${event.value}`);
      if (!pending || !args.authenticatedPrincipal(event.user) || pending.job.sourceConversationKey !== event.thread.id) {
        await event.thread.post("This result is unavailable in this conversation or this identity is not an active company member."); return;
      }
      await notifier.deliver(pending.job);
    });
    args.chat.onAction("companyos.builder.release", async (event) => {
      if (!event.thread || !event.value) return;
      const pending = await args.state.get<PendingRelease>(`builder-release-candidate:${event.value}`);
      const actor = args.authenticatedPrincipal(event.user);
      if (!pending || !actor || pending.candidate.sourceConversation !== event.thread.id) {
        await event.thread.post("This result is unavailable in this conversation or this identity is not an active company member."); return;
      }
      try {
        const run = await args.coordinator.accept(pending.candidate, actor, pending.digest);
        await event.adapter.editMessage(event.threadId, event.messageId, releaseStatusCard(run));
      } catch {
        // Authority/check failures are actionable but provider exceptions may
        // contain credentials. Never echo the raw error to the chat surface.
        await event.thread.post("Live adoption could not start. The required acceptor and deployment authority, exact candidate, protected checks and current production version must still match. Refresh the result or route it to the authorized person.");
      }
    });
  };
  const notify = async (run: ReleaseRun) => {
    await args.chat.thread(run.candidate.sourceConversation).post(releaseStatusCard(run));
  };
  return { notifier, registerHandlers, notify };
}

export function releaseStatusCard(run: ReleaseRun) {
  const description = run.stage === "live" ? "This exact change is live. The production version and readiness checks were verified."
    : run.stage === "rolled-back" ? "The previous application artifact is active and verified. This does not undo data changes or external effects."
    : run.stage === "failed" ? "Live adoption stopped. Review the release evidence; production may already have changed if deployment began."
    : "The accepted change is being released. It is not yet verified live.";
  return Card({ title: run.stage === "live" ? "Change live" : run.stage === "rolled-back" ? "Previous version restored" : "Live adoption", children: [
    CardText(description), CardText(`Target: ${run.candidate.instanceId}. Release: ${run.id}. Status: ${run.stage}.`),
  ] });
}
