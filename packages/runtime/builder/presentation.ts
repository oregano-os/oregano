import type { BuilderJob } from "../../state-store/builder-jobs.ts";
import type { BuilderTestSession } from "./functional-tests.ts";

export interface BuilderCardModel {
  title: string;
  paragraphs: string[];
  actions: { id: string; label: string; value: string; style?: "primary" | "danger"; url?: string }[];
}
export function briefSummary(text: string): string {
  const clean = text.replace(/\\n/g, "\n").replace(/\s+/g, " ").trim();
  return clean.length <= 360 ? clean : `${clean.slice(0, 357)}…`;
}

export function builderResultPresentation(job: BuilderJob, options: {
  session?: BuilderTestSession; liveToken?: string; retryToken?: string; detail?: string;
  testChannelUrl?: string; discarded?: boolean; selected?: boolean; discardPending?: boolean;
} = {}): BuilderCardModel {
  const { session } = options;
  if (options.discarded || session?.stage === "discarded") return { title: "Discarded", paragraphs: ["This draft and its tests are closed. It was not published."], actions: [] };
  if (options.discardPending) return { title: "Discard pending", paragraphs: ["Tests and publication are blocked while repository closure is being confirmed. Retry Discard Build to check and complete the same closure."], actions: [{ id: "companyos.builder.discard", label: "Discard Build", value: job.jobId }] };
  if (session?.stage === "accepted") return { title: "Publishing", paragraphs: ["Your approval was recorded. The approved version is being built and checked for production."], actions: [] };
  const revising = session && ["feedback-pending", "changes-requested"].includes(session.stage);
  const paused = session?.stage === "expired";
  const text = session?.execution.kind === "agent"
    ? session.conversation
      ? "Start a new conversation in your test channel to try this version. Each new thread starts with fresh history. The test cannot use business tools or change business records."
      : `The new version answered “${session.execution.prompt}” once. Review its actual answer; this was not an interactive test.`
    : session ? "The workflow ran on its designated test resources. Review its actual result and any changes to those resources."
      : "Technical checks passed. No connected user test was selected.";
  return {
    title: revising ? "Changes requested" : paused ? "Test paused" : session?.stage === "failed" ? "Test needs attention" : "Ready to test",
    paragraphs: [briefSummary(job.brief?.brief.proposedBehavior ?? job.objective), text,
      ...(options.selected === false && session?.conversation ? ["New test threads currently use another build. Ask Builder to select this build when you want to test it in new threads. The linked results below still belong to this version."] : []),
      ...(paused ? ["Your build is saved. Ask Builder to resume it when you are ready."] : []),
      ...(revising ? ["Describe the revision here. Questions will be answered without starting development."] : []),
      ...(session?.testUrl ? [`Test results: ${session.testUrl}`] : []),
      ...(options.detail ? [options.detail] : []),
      "Go Live approves and publishes this exact version when its required checks and your permissions are valid."],
    actions: [
      { id: options.liveToken ? "companyos.builder.release" : "companyos.builder.release.check", label: "Go Live", style: "primary", value: options.liveToken ?? job.jobId },
      { id: "companyos.builder.discard", label: "Discard Build", value: job.jobId },
      { id: "companyos.builder.test.open", label: "Open Test Channel", value: job.jobId, ...(options.testChannelUrl ? { url: options.testChannelUrl } : {}) },
      { id: session ? "companyos.builder.test.changes" : "companyos.builder.request-changes", label: "Request Changes", value: session?.id ?? job.jobId },
    ],
  };
}

export function builderProgressPresentation(job: Pick<BuilderJob, "jobId" | "objective">, phase: "queued" | "preparing" | "coding" | "checking" | "testing"): BuilderCardModel {
  const titles = { queued: "Build request received", preparing: "Preparing your build", coding: "Coding agent is working", checking: "Checking your build", testing: "Preparing your test" };
  const details = { queued: "I’m sending your request to the coding agent. I’ll confirm when it starts.", preparing: "The workspace and coding environment are being prepared. Development has not started yet.", coding: "Development has started. Afterwards, I’ll check the change and prepare your test version.", checking: "The coding agent has finished. I’m checking the change before preparing your test version.", testing: "The checked version is being prepared for your test." };
  return { title: titles[phase], paragraphs: [briefSummary(job.objective), details[phase]], actions: ["queued", "preparing", "coding"].includes(phase) ? [{ id: "companyos.builder.stop", label: "Cancel build", value: job.jobId }] : [] };
}
