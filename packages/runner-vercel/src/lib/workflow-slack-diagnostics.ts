import { ignoreUnownedSlackConversation, type SlackChannelOwnership } from "./slack-conversation-ownership.ts";
import { randomUUID } from "node:crypto";
import { inspectWorkflowSlackRequest, slackMessageReference, type WorkflowSlackIngressReason } from "./workflow-action-ingress.ts";

type Stage = "received" | "filtered" | "sdk-dispatch" | "sdk-returned" | "ingress-failed" | "background-failed"
  | "handler-entered" | "handler-finished" | "handler-failed" | "assignment" | "verification-failed"
  | "identity-rejected" | "deduplicated" | "model-started" | "model-finished" | "reply-posted";
type Outcome = WorkflowSlackIngressReason | "unassigned" | "ambiguous" | "routing" | "closed" | "conversation" | "decision";
type Sink = (entry: Record<string, unknown>) => void;

/** Only explicitly selected fields can enter this content-free diagnostic stream. */
export function createWorkflowSlackTrace(options: { enabled?: boolean; messageRef?: string; sink?: Sink } = {}) {
  const enabled = options.enabled ?? process.env.COMPANYOS_SLACK_DIAGNOSTICS === "true";
  const started = performance.now(), traceId = randomUUID();
  let messageRef = /^[a-f0-9]{64}$/.test(options.messageRef ?? "") ? options.messageRef : undefined;
  const emit = (stage: Stage, outcome?: Outcome, status?: number) => {
    if (!enabled) return;
    const entry = { event: "slack.workflow.diagnostic", traceId, stage, elapsedMs: Math.round(performance.now() - started),
      ...(messageRef ? { messageRef } : {}), ...(outcome ? { outcome } : {}),
      ...(status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}) };
    // Observability must not change delivery or turn a saved decision into a failure.
    try { (options.sink ?? ((value) => console.info(JSON.stringify(value))))(entry); } catch { /* Diagnostic sink only. */ }
  };
  return { emit, correlate: (reference: string | undefined) => { if (/^[a-f0-9]{64}$/.test(reference ?? "")) messageRef = reference; } };
}
export type WorkflowSlackTrace = ReturnType<typeof createWorkflowSlackTrace>;

export function workflowSlackMessageTrace(threadId: string, messageId: string) {
  const match = /^slack:([CDG][A-Z0-9]{4,31}):/.exec(threadId);
  return createWorkflowSlackTrace({ messageRef: slackMessageReference(match?.[1], messageId) });
}

/** The injected handler is the existing signature-verifying Chat SDK webhook. */
export async function dispatchWorkflowSlackRequest(request: Request, options: {
  workflowOnly: boolean;
  channelBindings?: readonly SlackChannelOwnership[];
  handler: (request: Request, options: { waitUntil: (task: Promise<unknown>) => void }) => Promise<Response>;
  waitUntil: (task: Promise<unknown>) => void;
  diagnostics?: boolean;
  sink?: Sink;
}): Promise<Response> {
  const trace = createWorkflowSlackTrace({ enabled: options.diagnostics, sink: options.sink });
  trace.emit("received");
  try {
    const inspection = await inspectWorkflowSlackRequest(request, options.workflowOnly);
    trace.correlate(inspection.messageRef);
    if (inspection.kind === "ignored") {
      trace.emit("filtered", inspection.reason);
      return new Response(null, { status: 200 });
    }
    if (options.workflowOnly && inspection.kind === "message"
      && await ignoreUnownedSlackConversation(request, options.channelBindings ?? [])) {
      trace.emit("filtered", "unowned-conversation");
      return new Response(null, { status: 200 });
    }
    trace.emit("sdk-dispatch", inspection.reason);
    const response = await options.handler(request, { waitUntil: (task) => options.waitUntil(task.catch((error) => {
      trace.emit("background-failed"); throw error;
    })) });
    trace.emit("sdk-returned", undefined, response.status);
    return response;
  } catch (error) { trace.emit("ingress-failed"); throw error; }
}
