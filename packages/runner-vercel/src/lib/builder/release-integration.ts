import { builderDecisionKey } from "../../../../runtime/builder/experience.ts";
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
  withBuildLock?<T>(jobId: string, action: () => Promise<T>): Promise<T>;
  getJob?(id: string): Promise<BuilderJob | undefined>;
  isSelected?(job: BuilderJob): Promise<boolean>;
  testChannelUrl?(job: BuilderJob): string | undefined;
  discard?(job: BuilderJob, actor: string): Promise<void>;
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
        const card = builderResultCard(job, { session, testChannelUrl: args.testChannelUrl?.(job), selected: await args.isSelected?.(job), ...options });
        if (args.present) await args.present(job, card, "result");
        else if (job.sourceMessageId) await args.chat.thread(job.sourceConversationKey).adapter.editMessage(job.sourceConversationKey, job.sourceMessageId, card);
        else await args.chat.thread(job.sourceConversationKey).post(card);
      };
      if ((await args.state.get<{ kind: string }>(builderDecisionKey(job.jobId)))?.kind === "discarded") {
        const card = builderResultCard(job, { session, discarded: true });
        if (args.present) await args.present(job, card, "result"); else await args.chat.thread(job.sourceConversationKey).post(card);
        return;
      }
      if ((await args.state.get<{ kind: string }>(builderDecisionKey(job.jobId)))?.kind === "discarding") { await show({ discardPending: true }); return; }
      if (await args.revisionPending?.(job)) { await show({ detail: "Changes were requested. Describe the revision to Builder before a new result can be published." }); return; }
      if (session && !["interactive", "reviewable", "accepted"].includes(session.stage)) { await show({}); return; }
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
    args.chat.onAction("companyos.builder.release.check", async event => {
      const job = event.value ? await args.getJob?.(event.value) : undefined;
      if (!job || !event.thread || job.sourceConversationKey !== event.thread.id || !args.authenticatedPrincipal(event.user)) return;
      await notifier.deliver(job);
      await event.thread.post("Publication was not started or queued. Review the current test and readiness information on the build card, then use Go Live when ready.");
    });
    args.chat.onAction("companyos.builder.discard", async event => {
      const job = event.value ? await args.getJob?.(event.value) : undefined, actor = args.authenticatedPrincipal(event.user);
      if (!job || !event.thread || !actor || actor !== job.requesterPrincipal || event.thread.id !== job.sourceConversationKey || !args.discard) return;
      try {
        const discard = () => args.discard!(job, actor);
        if (args.withBuildLock) await args.withBuildLock(job.jobId, discard); else await discard();
        await notifier.deliver(job);
      } catch { await event.thread.post("Discard could not complete. Publication may already have started, or the repository could not confirm closure. The draft was not reported as discarded."); }
    });
    args.chat.onAction("companyos.builder.test.open", async event => {
      const job = event.value ? await args.getJob?.(event.value) : undefined;
      if (!job || !event.thread || !args.authenticatedPrincipal(event.user) || event.thread.id !== job.sourceConversationKey) return;
      const url = args.testChannelUrl?.(job);
      await event.thread.post(url ? `Open your test channel: ${url}` : "No connected test channel was configured for this build. Ask Builder to explain the selected test.");
    });
    args.chat.onAction("companyos.builder.release", async (event) => {
      if (!event.thread || !event.value) return;
      const pending = await args.state.get<PendingRelease>(`builder-release-candidate:${event.value}`);
      const actor = args.authenticatedPrincipal(event.user);
      if (!pending || !actor || pending.candidate.sourceConversation !== event.thread.id) {
        await event.thread.post("This result is unavailable in this conversation. Ask Builder for the current build card."); return;
      }
      let approvalRecorded = false;
      try {
        const publish = async () => {
          await args.beforeAccept?.(pending.candidate, actor, event.messageId);
          approvalRecorded = true;
          const run = await args.coordinator.accept(pending.candidate, actor, pending.digest);
          if (args.present) await presentRun(run);
          else await event.adapter.editMessage(event.threadId, event.messageId, releaseStatusCard(run));
        };
        if (args.withBuildLock) await args.withBuildLock(pending.candidate.id, publish); else await publish();
      } catch {
        await event.thread.post(approvalRecorded ? "Your approval was recorded, but publication status could not be confirmed. Ask Builder to check the build status before retrying." : "Publication could not start. A test may still be running, the reviewed result may have changed, or required checks or permissions are unavailable. No approval was queued for later publication.");
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
  return Card({ title: run.stage === "live" ? "Live" : run.stage === "rolled-back" ? "Previous version restored" : run.stage === "failed" ? "Publication stopped" : "Publishing", children: [
    CardText(description),
  ] });
}
