import { Actions, Button, Card, CardText, type CardElement } from "chat";
import type { BuilderJob } from "../../../../state-store/builder-jobs.ts";
import type { BuilderTestSession } from "../../../../runtime/builder/functional-tests.ts";

export function builderResultCard(job: BuilderJob, options: {
  session?: BuilderTestSession; liveToken?: string; retryToken?: string; detail?: string;
} = {}): CardElement {
  const { session } = options;
  const active = session?.stage === "interactive" || session?.stage === "responding";
  const reviewable = session?.stage === "reviewable";
  const revising = session?.stage === "feedback-pending" || session?.stage === "changes-requested";
  const testDescription = session?.execution.kind === "agent"
    ? session.conversation
      ? active ? "Try the new version in the test conversation. Ask follow-up questions there, then finish the test here. It cannot use Tools or change business records."
        : "This test uses the new version without Tools or changes to business records. Its saved replies are available in the test conversation."
      : `The new version answered this question once: “${session.execution.prompt}”. Review its wording and accuracy; this was not a multi-turn or Tool test.`
    : session ? "The workflow ran on its designated test resources. Review the actual result and any changes to those resources."
      : "Technical checks completed. No connected user test was run.";
  const buttons = [
    ...(session && ["interactive", "reviewable"].includes(session.stage)
      ? [Button({ id: "companyos.builder.test.changes", label: "Request changes", value: session.id })]
      : !session ? [Button({ id: "companyos.builder.request-changes", label: "Request changes", value: job.jobId })] : []),
    ...(active && session?.result && session.stage === "interactive" ? [Button({ id: "companyos.builder.test.finish", label: "Finish test", value: session.id })] : []),
    ...(session?.conversation && ["interactive", "reviewable", "expired"].includes(session.stage)
      ? [Button({ id: "companyos.builder.test.restart", label: "Restart test", value: session.id })] : []),
    ...(options.liveToken ? [Button({ id: "companyos.builder.release", label: "Go live", style: "primary", value: options.liveToken })] : []),
    ...(options.retryToken ? [Button({ id: "companyos.builder.release.refresh", label: "Check readiness", value: options.retryToken })] : []),
  ];
  return Card({ title: revising ? "Changes requested" : active ? "Ready to try" : session && !reviewable && session.stage !== "accepted" ? "Test needs attention" : "Ready for review",
    children: [CardText(job.brief?.brief.proposedBehavior ?? job.objective),
      CardText(testDescription), ...(session?.testUrl ? [CardText(`Test conversation: ${session.testUrl}`)] : []),
      ...(session?.stage === "expired" ? [CardText("This test session expired. Restart it to continue testing this version.")] : []),
      ...(session?.stage === "failed" ? [CardText("The test stopped before completion. Its recorded failure needs review before a new test.")] : []),
      ...(revising ? [CardText(session?.stage === "feedback-pending" ? "Tell Builder what to change in your next message here. Testing and publication are paused for this result." : "Your feedback is recorded. Builder can use it to prepare the revised result.")] : []),
      ...(options.detail ? [CardText(options.detail)] : []),
      ...(options.liveToken ? [CardText("Go live approves this exact reviewed result and starts publication. You will be told when the deployed version is verified live.")] : []),
      ...(buttons.length ? [Actions(buttons)] : []),
    ] });
}
