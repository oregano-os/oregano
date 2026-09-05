import type { CompiledSprintRuntime } from "../companyos-builder/types.ts";
import type { ExecuteToolRequest } from "./companyos-runtime.ts";
import { renderSprintReplayReport } from "./sprint-intent-renderer.ts";
import type { SprintReplayReport } from "./sprint-replay.ts";

export interface SprintReplayPublicationRuntime {
  execute(request: ExecuteToolRequest): Promise<unknown>;
}

export interface SprintReplayPublicationReceipt {
  replay_id: string;
  output_digest: string;
  content_digest: string;
  slack: {
    destination_binding: string;
    message_id: string;
    thread_reference: string;
    published_at: string;
  };
  monday: {
    resource_binding: string;
    work_item_id: string;
    comment_id: string;
    provider_version: string;
    created_at: string;
  };
}

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value) throw new Error(`${label} is missing`);
  return value;
};

const toolOutput = (value: unknown, label: string): Record<string, unknown> => object(object(value, label).output, `${label} output`);

export function assertSprintReplayPublicationDigest(report: SprintReplayReport, expectedOutputDigest: string): void {
  if (!/^[a-f0-9]{64}$/.test(expectedOutputDigest) || report.output_digest !== expectedOutputDigest) {
    throw new Error("Sprint Replay output changed after review; run proof-only replay again before publication");
  }
}

/**
 * Publish an already frozen historical replay only to the exact compiled test
 * bindings. CompanyOSRuntime supplies idempotency, receipts, and System of
 * Proof evidence for both provider effects.
 */
export async function publishSprintReplayReport(args: {
  compiled: CompiledSprintRuntime;
  report: SprintReplayReport;
  runtime: SprintReplayPublicationRuntime;
}): Promise<SprintReplayPublicationReceipt> {
  const publication = args.compiled.replay?.testPublication;
  const template = args.compiled.templates.replayReport;
  if (!publication?.testOnly || !template) throw new Error("Sprint Replay test publication is not compiled");
  const rendered = renderSprintReplayReport({ report: args.report, template });
  if (rendered.content.length > 10_000) {
    throw new Error("Sprint Replay report exceeds the Monday comment limit");
  }
  const runId = `sprint-replay-test-publication:${args.compiled.definitionId}:${args.report.output_digest}`;
  const slack = toolOutput(await args.runtime.execute({
    runId,
    stepId: "publish-slack-test-report",
    agentId: publication.publisherAgentId,
    grantId: "oregano:communications/publish",
    subjectPrincipal: args.compiled.servicePrincipal,
    input: {
      destination_binding: publication.communicationBinding,
      content: rendered.content,
      format: "provider-markdown",
    },
  }), "Slack test publication");
  if (slack.destination_binding !== publication.communicationBinding) {
    throw new Error("Slack test publication receipt does not match the compiled binding");
  }
  const monday = toolOutput(await args.runtime.execute({
    runId,
    stepId: "publish-monday-test-report",
    agentId: publication.publisherAgentId,
    grantId: "oregano:work-items/comment",
    subjectPrincipal: args.compiled.servicePrincipal,
    input: {
      resource_binding: publication.workItemBinding,
      work_item_id: publication.workItemId,
      body: rendered.content,
    },
  }), "Monday test publication");
  if (monday.work_item_id !== publication.workItemId) {
    throw new Error("Monday test publication receipt does not match the compiled work item");
  }
  return {
    replay_id: args.report.replay_id,
    output_digest: args.report.output_digest,
    content_digest: rendered.contentDigest,
    slack: {
      destination_binding: publication.communicationBinding,
      message_id: text(slack.message_id, "Slack message id"),
      thread_reference: text(slack.thread_reference, "Slack thread reference"),
      published_at: text(slack.published_at, "Slack published time"),
    },
    monday: {
      resource_binding: publication.workItemBinding,
      work_item_id: publication.workItemId,
      comment_id: text(monday.comment_id, "Monday comment id"),
      provider_version: text(monday.provider_version, "Monday provider version"),
      created_at: text(monday.created_at, "Monday comment creation time"),
    },
  };
}
