import { Actions, Button, Card, CardText, type Author, type Chat, type StateAdapter } from "chat";
import type { CompanyOSArtifact } from "../../../../companyos-builder/types.ts";
import type { BuilderJob } from "../../../../state-store/builder-jobs.ts";
import type { BuilderTerminalNotifier } from "../../../../runtime/builder/notifications.ts";
import { BuilderFunctionalTests, prepareBuilderTestSession, type BuilderTestSession, type BuilderTestResult } from "../../../../runtime/builder/functional-tests.ts";
import { sha256 } from "../../../../runtime/canonical.ts";
import { assertBuilderTestSupported } from "./functional-test-execution.ts";
import { createWorkflowSlackScope } from "../workflow-slack.ts";

export function builderFeedbackKey(conversation: string, principal: string) { return `builder:test-feedback:${sha256([conversation, principal])}`; }

export function createBuilderFunctionalTestIntegration(args: {
  artifact: CompanyOSArtifact; chat: Chat; state: StateAdapter; tests: BuilderFunctionalTests;
  authenticatedPrincipal(author: Author): string | undefined;
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
  const testId = (job: BuilderJob) => `builder-test-${sha256([job.instanceId, job.jobId]).slice(0, 40)}`;
  const reviewCard = (session: BuilderTestSession) => Card({ title: "Functional test ready for your review", children: [
    CardText(`Test result: ${session.testUrl ?? session.testConversation}. Candidate: ${session.candidateCommit.slice(0, 12)}.`),
    CardText("Review the actual changed result in the test conversation and designated resources. Tell Builder what to adjust, or accept the exact result with the merge-and-live action."),
    Actions([Button({ id: "companyos.builder.test.changes", label: "Request changes", value: session.id })]),
  ] });
  const deliverResult = async (job: BuilderJob, session: BuilderTestSession) => {
    await args.chat.thread(job.sourceConversationKey).post(reviewCard(session));
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
        if (session?.stage === "reviewable" || session?.stage === "accepted") { await deliverResult(job, session); return; }
        if (session && ["feedback-pending", "changes-requested", "failed"].includes(session.stage)) {
          await args.chat.thread(job.sourceConversationKey).post(session.stage === "failed"
            ? "The functional test stopped. Its retained evidence must be reviewed before a fresh test; merge and live adoption are unavailable."
            : "Changes were requested for this candidate. Builder must build and test a new result before merge and live adoption.");
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
          const message = await args.chat.channel(`slack:${binding.channel_id}`).post(Card({ title: "Workspace candidate test", children: [
            CardText(job.brief.brief.proposedBehavior), CardText(`Unmerged candidate: ${session.candidateCommit.slice(0, 12)}. This is a test result awaiting human review.`),
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
        if (!session || !["reviewable", "feedback-pending"].includes(session.stage) || actor !== session.requester || event.thread.id !== session.sourceConversation) {
          await event.thread.post("This test is unavailable, already accepted, or belongs to another requester or conversation."); return;
        }
        if (session.stage === "reviewable") await args.tests.requestFeedback(session.id, actor);
        await args.state.set(`${builderFeedbackKey(event.thread.id, actor)}:pending`, session.id);
        await event.thread.post("Tell Builder what to change in your next message here. That feedback will invalidate this result's live action and start a new review cycle.");
      });
    },
    async receive(argsIn: { conversation: string; author: Author; messageId: string; text: string; occurredAt: string }): Promise<boolean> {
      const actor = args.authenticatedPrincipal(argsIn.author);
      if (!actor) return false;
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
      await args.chat.thread(argsIn.conversation).post("This conversation contains the exact candidate test result. Use Request changes in the original Builder conversation to revise it, or review and accept that result there.");
      return true;
    },
  };
}
