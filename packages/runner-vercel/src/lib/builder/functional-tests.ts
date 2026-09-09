import { Actions, Button, Card, CardText, type Author, type Chat, type StateAdapter } from "chat";
import type { CompanyOSArtifact } from "../../../../companyos-builder/types.ts";
import type { BuilderJob } from "../../../../state-store/builder-jobs.ts";
import type { BuilderTerminalNotifier } from "../../../../runtime/builder/notifications.ts";
import { BuilderFunctionalTests, prepareBuilderTestSession, type BuilderTestSession, type BuilderTestResult, builderTestSessionId } from "../../../../runtime/builder/functional-tests.ts";
import { sha256 } from "../../../../runtime/canonical.ts";
import { assertBuilderTestSupported } from "./functional-test-execution.ts";
import { createWorkflowSlackScope } from "../workflow-slack.ts";
import type { BuilderCardPresenter } from "./card-presenter.ts";
import { builderProgressCard } from "./action-cards.ts";

export function builderProposalFeedbackKey(jobId: string) { return `builder:proposal-feedback:${jobId}`; }
export function builderProposalDecisionKey(jobId: string) { return `builder:proposal-decision:${jobId}`; }
export function builderProposalFeedbackConversation(conversation: string, principal: string) { return `builder:proposal-feedback-conversation:${sha256([conversation, principal])}`; }

export function builderFeedbackKey(conversation: string, principal: string) { return `builder:test-feedback:${sha256([conversation, principal])}`; }

export function createBuilderFunctionalTestIntegration(args: {
  artifact: CompanyOSArtifact; chat: Chat; state: StateAdapter; tests: BuilderFunctionalTests;
  authenticatedPrincipal(author: Author): string | undefined;
  getJob(jobId: string): Promise<BuilderJob | undefined>;
  present?: BuilderCardPresenter;
  compile(job: BuilderJob): Promise<CompanyOSArtifact>;
  execute(artifact: CompanyOSArtifact, session: BuilderTestSession): Promise<BuilderTestResult>;
  ready: BuilderTerminalNotifier;
  fallback: BuilderTerminalNotifier;
  transport?: { qualify(destination: string): Promise<void>; permalink(threadReference: string): Promise<string> };
}) {
  const transport = args.transport ?? {
    qualify: async (destination: string) => { await createWorkflowSlackScope(() => args.chat)(async (value) => { await value.qualify(args.artifact, destination, args.artifact.roster); }); },
    permalink: (threadReference: string) => createWorkflowSlackScope(() => args.chat)((value) => value.permalink(threadReference)),
  };
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
      const lock = await args.state.acquireLock(`builder:test-delivery:${testId(job)}`, 300000);
      if (!lock) throw new Error("Functional test preparation is already running.");
      try {
        let session = await args.tests.store.get(testId(job));
        if (session && ["interactive", "responding", "expired", "reviewable", "accepted"].includes(session.stage)) { await deliverResult(job, session); return; }
        if (session && ["feedback-pending", "changes-requested", "failed"].includes(session.stage)) {
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
        if (args.present) await args.present(job, builderProgressCard(job, "testing"), "testing");
        const candidate = await args.compile(job);
        assertBuilderTestSupported(candidate, session);
        const selected = session.resources.filter((resource) => resource.capability === "communication.message.publish");
        if (selected.length !== 1) throw new Error("Select one qualified test conversation destination.");
        const destination = selected[0]!.match.destination_binding;
        const destinations = (args.artifact.connectors ?? []).flatMap((connector) => connector.connector === "oregano/slack-communication"
          && Array.isArray(connector.configuration.destinations) ? connector.configuration.destinations : []);
        const binding = destinations.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && entry.id === destination) as { kind?: string; channel_id?: string } | undefined;
        if (binding?.kind !== "channel" || !binding.channel_id) throw new Error("The selected test conversation is not an existing qualified channel.");
        const rootKey = `builder:test-thread:${session.id}`, intentKey = `${rootKey}:intent`;
        let threadReference = await args.state.get<string>(rootKey);
        if (!threadReference) {
          await transport.qualify(destination!);
          if (!await args.state.setIfNotExists(intentKey, { candidate: session.candidateCommit })) throw new Error("A test-thread publication has an unresolved outcome; do not duplicate it.");
          const message = await args.chat.channel(`slack:${binding.channel_id}`).post(Card({ title: "Try your new version", children: [
            CardText(job.brief.brief.proposedBehavior), CardText(session.execution.kind === "agent" && session.execution.interaction === "interactive"
              ? "This thread runs the test version only. Mention the app in your follow-up questions. Finish the test in the original Builder conversation before publication."
              : "This thread contains the agreed test result. Review it in the original Builder conversation before publication."),
          ] }));
          threadReference = message.threadId;
          if (!threadReference.startsWith(`slack:${binding.channel_id}:`)) throw new Error("Test publication returned another conversation.");
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
        if (session.stage !== "feedback-pending") await args.tests.requestFeedback(session.id, actor);
        await args.state.set(`${builderFeedbackKey(event.thread.id, actor)}:pending`, session.id);
        const job = await args.getJob(session.jobId);
        if (job) await args.ready.deliver(job);
        await event.thread.post("Tell Builder what to change in your next message here. Publication is unavailable until the revised result is tested and approved.");
      });
      for (const action of ["finish", "restart"] as const) args.chat.onAction(`companyos.builder.test.${action}`, async (event) => {
        if (!event.thread || !event.value) return;
        const actor = args.authenticatedPrincipal(event.user), session = await args.tests.store.get(event.value);
        if (!session || actor !== session.requester || event.thread.id !== session.sourceConversation) {
          await event.thread.post("This test action belongs to its requester and original Builder conversation."); return;
        }
        try {
          if (action === "finish") await args.tests.finish(session.id, actor);
          else await args.tests.restart(session.id, actor);
          const job = await args.getJob(session.jobId);
          if (!job) throw new Error("Missing build request");
          await args.ready.deliver(job);
          if (action === "restart" && session.testConversation) await args.chat.thread(session.testConversation).post("A fresh test of the same version is ready. Mention the app and ask your first question; the previous test history will not be used.");
        } catch {
          await event.thread.post("This test action is unavailable while a reply is running, after acceptance, or after the session has changed. Finish a reply before continuing, or restart an expired test.");
        }
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
        await args.ready.deliver(job);
        await event.thread.post("Tell Builder what to change in your next message here. The previous publication action is no longer available.");
      });
    },
    async receive(argsIn: { conversation: string; author: Author; messageId: string; text: string; occurredAt: string }): Promise<boolean> {
      const actor = args.authenticatedPrincipal(argsIn.author);
      if (!actor) return false;
      const proposalId = await args.state.get<string>(builderProposalFeedbackConversation(argsIn.conversation, actor));
      if (proposalId) {
        const feedback = await args.state.get<{ pending?: boolean }>(builderProposalFeedbackKey(proposalId));
        if (feedback?.pending) {
          await args.state.set(builderProposalFeedbackKey(proposalId), { jobId: proposalId, pending: false,
            feedback: { principal: actor, messageId: argsIn.messageId, text: argsIn.text, receivedAt: argsIn.occurredAt } });
          return false;
        }
      }
      const feedbackKey = builderFeedbackKey(argsIn.conversation, actor);
      const pending = await args.state.get<string>(`${feedbackKey}:pending`);
      if (pending) {
        const session = await args.tests.store.get(pending);
        if (session?.stage === "feedback-pending" && session.sourceConversation === argsIn.conversation) {
          const revised = await args.tests.requestChanges(session.id, { principal: actor, messageId: argsIn.messageId, text: argsIn.text, receivedAt: argsIn.occurredAt });
          await args.state.set(feedbackKey, revised);
        } else if (session?.stage === "changes-requested" && session.sourceConversation === argsIn.conversation && session.feedback?.messageId === argsIn.messageId) {
          await args.state.set(feedbackKey, session);
        }
        await args.state.delete(`${feedbackKey}:pending`);
        return false;
      }
      const assigned = await args.state.get<string>(`builder:test-conversation:${sha256(argsIn.conversation)}`);
      if (!assigned) return false;
      const thread = args.chat.thread(argsIn.conversation);
      const lock = await args.state.acquireLock(`builder:test-turn:${assigned}`, 120000);
      if (!lock) { await thread.post("A test reply is still being prepared. Please wait before asking another question."); return true; }
      try {
        let session = await args.tests.store.get(assigned);
        if (!session || session.requester !== actor || session.testConversation !== argsIn.conversation || session.instanceId !== args.artifact.instance.id) {
          await thread.post("This test conversation belongs to its original requester."); return true;
        }
        if (session.conversation && ["interactive", "responding"].includes(session.stage) && Date.parse(session.conversation.expiresAt) <= args.tests.now().getTime()) {
          session = await args.tests.expire(session.id);
          const job = await args.getJob(session.jobId); if (job) await args.ready.deliver(job);
        }
        if (session.conversation?.turns.some((turn) => turn.messageId === argsIn.messageId)) return true;
        if (session.stage !== "interactive") {
          await thread.post(session.stage === "responding" ? "The previous test reply is still pending. It will not be started twice."
            : "This test is not open for questions. Review it or restart an interactive test from the original Builder conversation."); return true;
        }
        const job = await args.getJob(session.jobId);
        if (!job || job.requesterPrincipal !== actor || job.sourceConversationKey !== session.sourceConversation) throw new Error("Test request no longer matches");
        const candidate = await args.compile(job);
        assertBuilderTestSupported(candidate, session);
        // Claim the turn durably before invoking a model. A replay cannot spend again.
        session = await args.tests.beginTurn(session.id, actor, argsIn.messageId, argsIn.text);
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
