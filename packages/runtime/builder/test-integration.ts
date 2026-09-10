import type { CompanyOSArtifact } from "../../companyos-builder/types.ts";
import type { BuilderJob } from "../../state-store/builder-jobs.ts";
import type { BuilderTerminalNotifier } from "./notifications.ts";
import { BuilderFunctionalTests, prepareBuilderTestSession, type BuilderTestSession, type BuilderTestResult, builderTestSessionId } from "./functional-tests.ts";
import { sha256 } from "../canonical.ts";
import { builderProgressPresentation, briefSummary, type BuilderCardModel } from "./presentation.ts";
import { builderConversationKey, builderCurrentRequestKey, builderDecisionKey, builderOperationLock, builderSelectionKey, type BuilderExperienceStore, type BuilderRequestReference, type BuilderTestSurface } from "./experience.ts";

export interface BuilderTestThread {
  id: string;
  post(content: string | BuilderCardModel): Promise<{ id: string; threadId: string; metadata: { dateSent: Date } }>;
  subscribe(): Promise<void>;
}
export interface BuilderTestChat<Author> {
  thread(id: string): BuilderTestThread;
  channel(id: string): Pick<BuilderTestThread, "post">;
  onAction(id: string, handler: (event: { thread?: BuilderTestThread; value?: string; user: Author }) => Promise<void>): void;
}
export interface BuilderTestControl<Lock> extends BuilderExperienceStore {
  acquireLock(key: string, ttl: number): Promise<Lock | null>;
  releaseLock(lock: Lock): Promise<void>;
  setIfNotExists<T>(key: string, value: T, ttl?: number): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export function builderProposalFeedbackKey(jobId: string) { return `builder:proposal-feedback:${jobId}`; }
export function builderProposalDecisionKey(jobId: string) { return `builder:proposal-decision:${jobId}`; }
export function builderProposalFeedbackConversation(conversation: string, principal: string) { return `builder:proposal-feedback-conversation:${sha256([conversation, principal])}`; }

export function builderFeedbackKey(conversation: string, principal: string) { return `builder:test-feedback:${sha256([conversation, principal])}`; }

export function createBuilderFunctionalTestIntegration<Author, Lock>(args: {
  artifact: CompanyOSArtifact; chat: BuilderTestChat<Author>; state: BuilderTestControl<Lock>; tests: BuilderFunctionalTests;
  authenticatedPrincipal(author: Author): string | undefined;
  getJob(jobId: string): Promise<BuilderJob | undefined>;
  present?: (job: BuilderJob, card: BuilderCardModel, phase: "testing") => Promise<void>;
  assertSupported(artifact: CompanyOSArtifact, session: BuilderTestSession): void;
  compile(job: BuilderJob): Promise<CompanyOSArtifact>;
  execute(artifact: CompanyOSArtifact, session: BuilderTestSession): Promise<BuilderTestResult>;
  ready: BuilderTerminalNotifier;
  fallback: BuilderTerminalNotifier;
  transport: BuilderTestSurface;
}) {
  const transport = args.transport;
  const testId = builderTestSessionId;
  const deliverResult = async (job: BuilderJob, _session: BuilderTestSession) => {
    // The release presenter composes test evidence and actions into one result.
    await args.ready.deliver(job);
  };
  const notifier: BuilderTerminalNotifier = {
    async deliver(job) {
      if (job.state !== "published" || job.brief?.brief.test.strategy !== "test-resources") {
        await args.ready.deliver(job); return;
      }
      const lock = await args.state.acquireLock(builderOperationLock(job.jobId), 300000);
      if (!lock) throw new Error("Functional test preparation is already running.");
      try {
        if (await args.state.get(builderDecisionKey(job.jobId))) { await args.ready.deliver(job); return; }
        let session = await args.tests.store.get(testId(job));
        if (session && ["interactive", "responding", "expired", "reviewable", "accepted"].includes(session.stage)) { await deliverResult(job, session); return; }
        if (session && ["feedback-pending", "changes-requested", "failed", "discarded"].includes(session.stage)) {
          await args.ready.deliver(job);
          return;
        }
        if (!job.brief.brief.test.execution) {
          await args.fallback.deliver(job);
          await args.chat.thread(job.sourceConversationKey).post("The draft needs a concrete Agent or workflow test. Resolve that test in the build brief before creating a new candidate.");
          return;
        }
        const prepared = prepareBuilderTestSession({ job, coreCommit: args.artifact.provenance.coreCommit,
          resources: args.artifact.builder?.testResources ?? [], execution: job.brief.brief.test.execution });
        const parentId = await args.state.get<string>(`builder:test-parent:${job.jobId}`);
        if (parentId) {
          const parent = await args.tests.store.get(parentId);
          if (!parent?.feedback || parent.stage !== "changes-requested" || parent.requester !== prepared.requester
            || parent.sourceConversation !== prepared.sourceConversation) throw new Error("The previous test has no matching human revision request.");
          prepared.previousTestSessionId = parentId;
        }
        session = await args.tests.store.create(prepared);
        if (args.present) await args.present(job, builderProgressPresentation(job, "testing"), "testing");
        const candidate = await args.compile(job);
        args.assertSupported(candidate, session);
        const selected = session.resources.filter((resource) => resource.capability === "communication.message.publish");
        if (selected.length !== 1) throw new Error("Select one qualified test conversation destination.");
        const destination = selected[0]!.match.destination_binding;
        const binding = transport.destination(destination!);
        const rootKey = `builder:test-thread:${session.id}`, intentKey = `${rootKey}:intent`;
        let threadReference = await args.state.get<string>(rootKey);
        if (!threadReference) {
          await transport.qualify(destination!);
          if (!await args.state.setIfNotExists(intentKey, { candidate: session.candidateCommit })) throw new Error("A test-thread publication has an unresolved outcome; do not duplicate it.");
          const message = await args.chat.channel(binding.channel).post({ title: "Test version · Not live", paragraphs: [briefSummary(job.objective),
            "This conversation uses your test version. Start a new conversation in this test channel for fresh history."], actions: [] });
          threadReference = message.threadId;
          if (!transport.contains(destination!, threadReference)) throw new Error("Test publication returned another destination.");
          await args.state.set(rootKey, threadReference);
          await args.state.set(`builder:test-conversation:${sha256(threadReference)}`, session.id);
          await args.chat.thread(threadReference).subscribe();
        }
        if (session.stage === "prepared") session = await args.tests.begin(session.id, candidate.artifactHash, threadReference, await transport.permalink(threadReference));
        if (session.stage !== "running" || session.artifactHash !== candidate.artifactHash || session.testConversation !== threadReference) throw new Error("Test execution identity changed.");
        // A retained dispatch claim prevents retrying model/provider work after a
        // process loss. Workflow effects have their own durable claims as well.
        if (!await args.state.setIfNotExists(`builder:test-execution:${session.id}`, { artifactHash: candidate.artifactHash })) throw new Error("Test execution has an unresolved outcome; inspect retained evidence before retrying.");
        const result = await args.execute(candidate, session);
        const posted = await args.chat.thread(threadReference).post(result.summary);
        const evidence = JSON.parse(JSON.stringify({ execution: result.evidence,
          delivery: { messageId: posted.id, threadReference: posted.threadId, deliveredAt: posted.metadata.dateSent.toISOString() } }));
        session = await args.tests.recordResult(session.id, { ...result, evidence });
        await deliverResult(job, session);
      } catch (error) {
        const session = await args.tests.store.get(testId(job));
        if (session && ["prepared", "running"].includes(session.stage)) await args.tests.fail(session.id, error);
        throw error;
      } finally { await args.state.releaseLock(lock); }
    },
  };
  return {
    notifier,
    registerHandlers() {
      args.chat.onAction("companyos.builder.test.changes", async (event) => {
        if (!event.thread || !event.value) return;
        const session = await args.tests.store.get(event.value), actor = args.authenticatedPrincipal(event.user);
        if (!session || !["reviewable", "interactive", "feedback-pending"].includes(session.stage) || actor !== session.requester || event.thread.id !== session.sourceConversation) {
          await event.thread.post("This test is unavailable, already accepted, or belongs to another requester or conversation."); return;
        }
        const lock = await args.state.acquireLock(builderOperationLock(session.jobId), 300000);
        if (!lock) { await event.thread.post("A test or decision is still running. Please try again shortly."); return; }
        try {
          if (await args.state.get(builderDecisionKey(session.jobId))) { await event.thread.post("This build already has a decision."); return; }
          if (session.stage !== "feedback-pending") await args.tests.requestFeedback(session.id, actor);
          await args.state.set(`${builderFeedbackKey(event.thread.id, actor)}:pending`, session.id);
        } finally { await args.state.releaseLock(lock); }
        const job = await args.getJob(session.jobId);
        if (job) {
          await args.state.set(builderCurrentRequestKey(job.instanceId, actor, job.sourceConversationKey), { jobId: job.jobId, objective: job.objective, createdAt: job.createdAt, sourceConversation: job.sourceConversationKey } satisfies BuilderRequestReference);
          await args.ready.deliver(job);
        }
        await event.thread.post("Tell Builder what to change in your next message here. Publication is unavailable until the revised result is tested and approved.");
      });
      for (const action of ["finish", "restart"] as const) args.chat.onAction(`companyos.builder.test.${action}`, async event => {
        if (event.thread) await event.thread.post("Start a new conversation in your test channel for a fresh test. Go Live on the build card approves publication; no Finish test step is needed.");
      });
      args.chat.onAction("companyos.builder.request-changes", async (event) => {
        if (!event.thread || !event.value) return;
        const job = await args.getJob(event.value), actor = args.authenticatedPrincipal(event.user);
        if (!job || actor !== job.requesterPrincipal || event.thread.id !== job.sourceConversationKey) return;
        if (!await args.state.setIfNotExists(builderProposalDecisionKey(job.jobId), { kind: "revision", actor })) {
          const decision = await args.state.get<{ kind: string }>(builderProposalDecisionKey(job.jobId));
          if (decision?.kind !== "revision") { await event.thread.post("Publication was already approved for this result. Start a new build request for a further change."); return; }
        }
        // Automatic-check proposals have no functional session. Record feedback separately.
        await args.state.set(builderProposalFeedbackKey(job.jobId), { jobId: job.jobId, pending: true });
        await args.state.set(builderProposalFeedbackConversation(event.thread.id, actor), job.jobId);
        await args.state.set(builderCurrentRequestKey(job.instanceId, actor, job.sourceConversationKey), { jobId: job.jobId, objective: job.objective, createdAt: job.createdAt, sourceConversation: job.sourceConversationKey } satisfies BuilderRequestReference);
        await args.ready.deliver(job);
        await event.thread.post("Tell Builder what to change in your next message here. The previous publication action is no longer available.");
      });
    },
    async receive(argsIn: { conversation: string; author: Author; messageId: string; text: string; occurredAt: string }): Promise<boolean> {
      const actor = args.authenticatedPrincipal(argsIn.author);
      if (!actor) return false;
      let assigned = await args.state.get<string>(`builder:test-conversation:${sha256(argsIn.conversation)}`);
      if (!assigned) {
        const resources = args.artifact.builder?.testResources?.filter(resource => resource.capability === "communication.message.publish") ?? [];
        const destination = resources.find(resource => transport.contains(resource.match.destination_binding!, argsIn.conversation));
        if (!destination) return false;
        const thread = args.chat.thread(argsIn.conversation);
        if (!transport.isRoot(argsIn.conversation, argsIn.messageId)) {
          await thread.post("This conversation is not bound to a test version. Start a new conversation in this test channel."); return true;
        }
        const selection = await args.state.get<BuilderRequestReference>(builderSelectionKey(args.artifact.instance.id, actor));
        if (!selection) { await thread.post("You don’t have an active test version. Ask Builder to prepare one or select an existing build."); return true; }
        const job = await args.getJob(selection.jobId);
        if (!job || job.instanceId !== args.artifact.instance.id || job.requesterPrincipal !== actor) throw new Error("Test selection identity changed.");
        if (job.state !== "published") { await thread.post(job.state === "failed" || job.state === "cancelled" ? "This build did not complete. Ask Builder to review it." : "Your new test version is still being prepared. Existing conversations keep their previous version."); return true; }
        const session = await args.tests.store.get(testId(job));
        if (!session || !session.conversation) { await thread.post("This build has no interactive test ready. Review its result with Builder."); return true; }
        if (!session.resources.some(resource => resource.match.destination_binding === destination.match.destination_binding)) {
          await thread.post("Your selected test belongs to another configured test destination."); return true;
        }
        if (await args.state.get(builderDecisionKey(job.jobId)) || session.stage !== "interactive") {
          await thread.post("This test is paused or closed. Ask Builder to resume an available build, or select another test."); return true;
        }
        assigned = session.id;
        await args.state.setIfNotExists(builderConversationKey(argsIn.conversation), assigned);
        if (await args.state.get(builderConversationKey(argsIn.conversation)) !== assigned) throw new Error("Conversation was already assigned to another build.");
        await thread.subscribe();
        await thread.post({ title: "Test version · Not live", paragraphs: [briefSummary(job.objective), "This conversation stays on this version. Start another conversation for fresh history."], actions: [] });
      }
      const thread = args.chat.thread(argsIn.conversation);
      const lock = await args.state.acquireLock(builderOperationLock((await args.tests.store.get(assigned))?.jobId ?? assigned), 300000);
      if (!lock) { await thread.post("A test reply is still being prepared. Please wait before asking another question."); return true; }
      try {
        let session = await args.tests.store.get(assigned);
        if (!session || session.requester !== actor || session.instanceId !== args.artifact.instance.id) {
          await thread.post("This test conversation belongs to its original requester."); return true;
        }
        if (await args.state.get(builderDecisionKey(session.jobId))) {
          await thread.post("This build has a pending or completed decision. Its test is closed."); return true;
        }
        if (session.conversation && ["interactive", "responding"].includes(session.stage) && Date.parse(session.conversation.expiresAt) <= args.tests.now().getTime()) {
          session = await args.tests.expire(session.id);
          const job = await args.getJob(session.jobId); if (job) await args.ready.deliver(job);
        }
        if ((session.testConversations?.[argsIn.conversation] ?? (argsIn.conversation === session.testConversation ? session.conversation : undefined))?.turns.some(turn => turn.messageId === argsIn.messageId)) return true;
        if (session.stage !== "interactive") {
          await thread.post(session.stage === "responding" ? "The previous test reply is still pending. It will not be started twice."
            : "This test is paused or closed. Ask Builder to resume an available build, or select another test."); return true;
        }
        const job = await args.getJob(session.jobId);
        if (!job || job.requesterPrincipal !== actor || job.sourceConversationKey !== session.sourceConversation) throw new Error("Test request no longer matches");
        const candidate = await args.compile(job);
        args.assertSupported(candidate, session);
        // Claim the turn durably before invoking a model. A replay cannot spend again.
        session = await args.tests.beginTurn(session.id, actor, argsIn.messageId, argsIn.text, argsIn.conversation);
        try {
          const result = await args.execute(candidate, session);
          const delivered = await thread.post(result.summary);
          session = await args.tests.recordTurn(session.id, argsIn.messageId, { ...result,
            evidence: JSON.parse(JSON.stringify({ execution: result.evidence,
              delivery: { messageId: delivered.id, threadReference: delivered.threadId } })) });
          await args.ready.deliver(job);
        } catch (error) {
          const current = await args.tests.store.get(session.id);
          if (current?.stage === "responding") await args.tests.fail(session.id, error);
          await args.ready.deliver(job);
          await thread.post("The test reply could not be completed or delivered. Its recorded result needs review; no publication has started.");
        }
      } catch {
        await thread.post("This test question could not be started. Check that the session is active and the question is within its limits; no live change was made.");
      } finally { await args.state.releaseLock(lock); }
      return true;
    },
  };
}
