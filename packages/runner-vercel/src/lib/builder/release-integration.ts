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
  const assertJobCandidate = (job: BuilderJob, candidate: ReleaseCandidate) => {
    assertReleaseCandidate(candidate);
    const published = (job.evidence as { proposal?: { proposalCommit?: string } } | undefined)?.proposal?.proposalCommit;
    if (candidate.id !== job.jobId || candidate.instanceId !== job.instanceId || candidate.repositoryId !== job.repositoryId
      || candidate.baseCommit !== job.baseCommit || candidate.candidateCommit !== published
      || candidate.requester !== job.requesterPrincipal || candidate.sourceConversation !== job.sourceConversationKey) {
      throw new Error("Release preparation did not identify the published Builder result.");
    }
  };
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
      assertJobCandidate(job, candidate);
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
      const actor = args.authenticatedPrincipal(event.user)!;
      let approvalRecorded = false;
      try {
        const publish = async () => {
          if (job.brief?.brief.deploymentIntent !== "after-acceptance") throw new Error("This build is draft-only.");
          const receiptKey = `builder-release-accepted:${job.jobId}`;
          const accepted = await args.state.get<PendingRelease>(receiptKey);
          // A retry reconciles the same accepted version, never a newly selected build.
          const candidate = accepted?.candidate ?? await args.prepareCandidate(job);
          assertJobCandidate(job, candidate);
          const digest = sha256(candidate);
          if (accepted && accepted.digest !== digest) throw new Error("The accepted candidate changed.");
          if (!accepted) await args.beforeAccept?.(candidate, actor, event.messageId);
          approvalRecorded = true;
          const run = await args.coordinator.accept(candidate, actor, digest);
          await args.state.set(receiptKey, { candidate, digest } satisfies PendingRelease);
          await presentRun(run);
        };
        if (args.withBuildLock) await args.withBuildLock(job.jobId, publish); else await publish();
      } catch (error) {
        await event.thread.post(`${approvalRecorded ? "Your approval was recorded, but publication could not be confirmed." : "Publication could not start."} ${releaseBlockerMessage(error)}`);
      }
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
      } catch (error) {
        await event.thread.post(`${approvalRecorded ? "Your approval was recorded, but publication could not be confirmed." : "Publication could not start."} ${releaseBlockerMessage(error)}`);
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

/** Translate known control failures; never render arbitrary provider errors or secrets. */
export function releaseBlockerMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown-release-error";
  const known: Record<string, string> = {
    "Release requires an authenticated active human.": "Your account is not an active human member authorized for publication.",
    "This human is not the required acceptor for this change.": "The Workspace policy requires a different authorized person to approve this change.",
    "This human has no production release authority for the Instance.": "Your account does not have publication rights for this Instance.",
    "Release policy or membership changed; review the candidate under the current policy.": "The publication policy or company membership changed. Builder must refresh the current authorization.",
    "Production changed since this candidate was prepared.": "Another version became live. Builder must update this build against the current Workspace.",
    "This build is draft-only.": "This build was prepared as a draft only. Ask Builder to enable publication for this build.",
    "Changes were requested for this candidate.": "This version has an outstanding change request. Complete or withdraw that request before publishing.",
    "This candidate has a pending revision.": "This version has an outstanding change request. Complete or withdraw that request before publishing.",
    "The exact candidate has no current functional-test evidence.": "The selected technical test has no current completed result. No separate review confirmation is required.",
    "The exact merge strategy and all candidate checks must pass before acceptance.": "The repository checks or the checked target branch are not ready. Builder must refresh their status before publication can proceed.",
    "Only the exact independently checked current Workspace proposal can be released.": "This build no longer matches the current Workspace or lacks its completed technical checks. Builder must update the build first.",
    "Release preparation did not identify the published Builder result.": "The prepared version does not match this build. Nothing else was selected for publication.",
    "The displayed candidate is no longer ready or current.": "The build or its technical evidence changed during publication. Builder must refresh the exact result.",
    "The displayed test result is stale.": "The test result changed during publication. Builder must refresh the exact result.",
    "A test or decision is still running.": "A test or another decision is currently running for this build. Publication has not been queued.",
    "The deployment lost required Builder runtime configuration.": "The deployment is missing required Builder settings. The Instance configuration must be repaired.",
  };
  return known[message] ?? `A technical release operation failed. Diagnostic reference: ${sha256(message).slice(0, 12)}. Builder must inspect this failure; reviewing the test again will not resolve it.`;
}
