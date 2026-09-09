import { Card, CardText, type Author, type Chat, type StateAdapter } from "chat";
import { sha256 } from "../../../../runtime/canonical.ts";
import { assertReleaseCandidate, type ReleaseCoordinator } from "../../../../runtime/release/coordinator.ts";
import type { ReleaseCandidate } from "../../../../runtime/release/contracts.ts";
import type { ReleaseRun } from "../../../../state-store/release-runs.ts";
import type { BuilderJob } from "../../../../state-store/builder-jobs.ts";
import type { BuilderTerminalNotifier } from "../../../../runtime/builder/notifications.ts";

import type { BuilderTestSession } from "../../../../runtime/builder/functional-tests.ts";
import type { BuilderCardPresenter } from "./card-presenter.ts";
import { builderResultCard } from "./result-card.ts";

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
  beforeAccept?(candidate: ReleaseCandidate, actor: string, actionId: string): Promise<void>;
  fallback: BuilderTerminalNotifier;
  getTestSession?(job: BuilderJob): Promise<BuilderTestSession | undefined>;
  present?: BuilderCardPresenter;
  revisionPending?(job: BuilderJob): Promise<boolean>;
}) {
  const notifier: BuilderTerminalNotifier = {
    async deliver(job) {
      if (job.state !== "published" || !job.brief) { await args.fallback.deliver(job); return; }
      const session = await args.getTestSession?.(job);
      const show = async (options: Parameters<typeof builderResultCard>[1]) => {
        if (session && (await args.getTestSession?.(job))?.revision !== session.revision) return;
        const card = builderResultCard(job, { session, ...options });
        if (args.present) await args.present(job, card, "result");
        else if (job.sourceMessageId) await args.chat.thread(job.sourceConversationKey).adapter.editMessage(job.sourceConversationKey, job.sourceMessageId, card);
        else await args.chat.thread(job.sourceConversationKey).post(card);
      };
      if (await args.revisionPending?.(job)) { await show({ detail: "Changes were requested. Describe the revision to Builder before a new result can be published." }); return; }
      if (session && !["reviewable", "accepted"].includes(session.stage)) { await show({}); return; }
      if (job.brief.brief.deploymentIntent !== "after-acceptance") {
        await show({ detail: "This request was prepared as a draft only. Publication has not been requested." }); return;
      }
      let candidate: ReleaseCandidate;
      try { candidate = await args.prepareCandidate(job); }
      catch {
        const token = sha256([job.jobId, job.brief.digest, "readiness"]);
        await args.state.set(`builder-release-readiness:${token}`, { job } satisfies PendingReadiness, 24 * 60 * 60 * 1000);
        await show({ retryToken: token, detail: "The result is available. Required checks or publication access are not ready yet. No publication has started." });
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
      const token = digest;
      await args.state.set(`builder-release-candidate:${token}`, { candidate, digest } satisfies PendingRelease, 24 * 60 * 60 * 1000);
      await show({ liveToken: token });
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
        await args.beforeAccept?.(pending.candidate, actor, event.messageId);
        const run = await args.coordinator.accept(pending.candidate, actor, pending.digest);
        if (args.present) await presentRun(run);
        else await event.adapter.editMessage(event.threadId, event.messageId, releaseStatusCard(run));
      } catch {
        // Authority/check failures are actionable but provider exceptions may
        // contain credentials. Never echo the raw error to the chat surface.
        await event.thread.post("Live adoption could not start. The required acceptor and deployment authority, exact candidate, required checks and current production version must still match. Refresh the result or route it to the authorized person.");
      }
    });
  };
  const presentRun = async (run: ReleaseRun) => {
    if (args.present) await args.present({ jobId: run.candidate.id, instanceId: run.candidate.instanceId, sourceConversationKey: run.candidate.sourceConversation },
      releaseStatusCard(run), run.stage === "live" || run.stage === "rolled-back" ? "live" : "releasing");
    else await args.chat.thread(run.candidate.sourceConversation).post(releaseStatusCard(run));
  };
  const notify = presentRun;
  return { notifier, registerHandlers, notify };
}

export function releaseStatusCard(run: ReleaseRun) {
  const description = run.stage === "live" ? "This exact change is live. The production version and readiness checks were verified."
    : run.stage === "rolled-back" ? "The previous application artifact is active and verified. This does not undo data changes or external effects."
    : run.stage === "failed" ? "Live adoption stopped. Review the release evidence; production may already have changed if deployment began."
    : "Your approved result is being published. You will be told when it is verified live.";
  return Card({ title: run.stage === "live" ? "Your result is live" : run.stage === "rolled-back" ? "Previous version restored" : run.stage === "failed" ? "Publication stopped" : "Publishing your result", children: [
    CardText(description),
  ] });
}
