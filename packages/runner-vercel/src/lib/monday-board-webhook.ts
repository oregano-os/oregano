import type { CompanyOSArtifact } from "../../../companyos-builder/types.ts";
import type { CompiledWorkflow } from "../../../companyos-builder/workflow-types.ts";
import type { WorkflowRun, WorkflowTriggerEvent } from "../../../state-store/workflow-engine.ts";
import { parseMondayBoardWebhook, verifyMondayBoardWebhookToken, workflowEventFromMondayBoardEvent, type MondayBoardEvent } from "../../../connectors/monday/board-webhook.ts";
import type { MondayReplayStore } from "../../../connectors/monday/webhook.ts";
import { sha256 } from "../../../runtime/canonical.ts";
import { StateAdapterMondayReplayStore } from "./monday-agent-webhook.ts";
import { createPostgresChatState } from "./postgres-chat-state.ts";
import { workflowHostingEnabled } from "./workflow-configuration.ts";

const MAX_DELIVERY_BYTES = 64 * 1024;
const REPLAY_TTL_MS = 24 * 60 * 60_000;
export const MONDAY_BOARD_WEBHOOK_SECRET_ENV = "MONDAY_BOARD_WEBHOOK_SECRET";

export interface MondayBoardWebhookDependencies {
  artifact: CompanyOSArtifact;
  eventOpenWorkflowIds: readonly string[];
  schedulePrincipal: string;
  secret: string;
  replayStore: MondayReplayStore;
  openEvent(args: { workflowId: string; principal: string; event: WorkflowTriggerEvent; instant: string }): Promise<WorkflowRun>;
  now?: () => number;
}

interface MondayBoardBinding { actorId: string; resourceBindings: Map<string, string> }

/** Exact board-to-resource pairs and the Instance's own provider identity, read from the pinned Artifact. */
function mondayBoardBinding(artifact: CompanyOSArtifact): MondayBoardBinding | undefined {
  const entry = artifact.connectors?.find((connector) => connector.connector === "oregano/monday-work-items");
  const configuration = entry?.configuration as { actor_id?: unknown; resources?: unknown } | undefined;
  if (!configuration || typeof configuration.actor_id !== "string" || !Array.isArray(configuration.resources)) return undefined;
  const resourceBindings = new Map<string, string>();
  for (const raw of configuration.resources) {
    const resource = raw as { id?: unknown; board_id?: unknown };
    if (typeof resource?.id === "string" && typeof resource.board_id === "string") resourceBindings.set(resource.board_id, resource.id);
  }
  return { actorId: configuration.actor_id, resourceBindings };
}

/** Active event workflows whose declared source matches this exact provider event. */
export function selectMondayEventWorkflows(artifact: CompanyOSArtifact, eventOpenWorkflowIds: readonly string[], resourceBinding: string, event: MondayBoardEvent): CompiledWorkflow[] {
  return (artifact.workflows ?? []).filter((workflow) => {
    if (!eventOpenWorkflowIds.includes(workflow.id) || workflow.trigger.kind !== "event") return false;
    const eventPath = workflow.trigger.eventPath, triggerId = workflow.trigger.id;
    const source = workflow.events?.find((candidate) => candidate.path === eventPath)?.declaration;
    if (!source || source.provider !== "monday" || source.activation !== "active" || source.resource_binding !== resourceBinding) return false;
    return source.triggers.some((trigger) => trigger.id === triggerId && trigger.events.includes(event.kind));
  });
}

const notAccepted = (reason: string): Response => Response.json({ ok: true, accepted: false, reason });
const invalidDelivery = (error: unknown): Response => {
  const message = error instanceof Error ? error.message : "unknown Monday board webhook error";
  return Response.json({ ok: false, error: "invalid-delivery", errorDigest: sha256(message).slice(0, 16) }, { status: 400 });
};

export async function handleMondayBoardWebhook(request: Request, dependencies: MondayBoardWebhookDependencies): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  if (!verifyMondayBoardWebhookToken(request.url, dependencies.secret)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_DELIVERY_BYTES) return Response.json({ ok: false, error: "delivery-too-large" }, { status: 413 });
  let parsed: ReturnType<typeof parseMondayBoardWebhook>;
  try { parsed = parseMondayBoardWebhook(rawBody); }
  catch (error) { return invalidDelivery(error); }
  if ("challenge" in parsed) return Response.json({ challenge: parsed.challenge });
  if ("ignored" in parsed) return notAccepted(parsed.ignored);
  const { event } = parsed;
  const binding = mondayBoardBinding(dependencies.artifact);
  const resourceBinding = binding?.resourceBindings.get(event.boardId);
  if (!binding || !resourceBinding) return notAccepted("unbound-board");
  if (event.actorId === binding.actorId) return notAccepted("self-authored");
  const workflows = selectMondayEventWorkflows(dependencies.artifact, dependencies.eventOpenWorkflowIds, resourceBinding, event);
  if (!workflows.length) return notAccepted("no-active-event-workflow");
  const now = (dependencies.now ?? Date.now)();
  const replayKey = `monday:board-event:${dependencies.artifact.instance.id}:${event.eventId}`;
  try {
    const opened: Array<{ workflowId: string; runId: string }> = [];
    for (const workflow of workflows) {
      const run = await dependencies.openEvent({ workflowId: workflow.id, principal: dependencies.schedulePrincipal,
        event: workflowEventFromMondayBoardEvent(event, resourceBinding), instant: event.occurredAt });
      opened.push({ workflowId: workflow.id, runId: run.runId });
    }
    // The engine origin key is the idempotency boundary; the claim only short-circuits later redeliveries.
    const first = await dependencies.replayStore.claim(replayKey, new Date(now + REPLAY_TTL_MS).toISOString());
    return Response.json({ ok: true, accepted: true, redelivered: !first, opened });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ ok: false, error: "event-opening-failed", errorDigest: sha256(message).slice(0, 16) }, { status: 503 });
  }
}

export async function handleConfiguredMondayBoardWebhook(request: Request): Promise<Response> {
  try {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
    const secret = process.env[MONDAY_BOARD_WEBHOOK_SECRET_ENV]?.trim() ?? "";
    // Authenticate before touching the database or the pinned Artifact.
    if (!verifyMondayBoardWebhookToken(request.url, secret)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    if (!workflowHostingEnabled()) return notAccepted("workflow-hosting-disabled");
    const { createWorkflowHost } = await import("./workflow-host.ts");
    const host = await createWorkflowHost();
    return await handleMondayBoardWebhook(request, {
      artifact: host.artifact, eventOpenWorkflowIds: host.configuration.eventOpenWorkflowIds, schedulePrincipal: host.configuration.schedulePrincipal,
      secret, replayStore: new StateAdapterMondayReplayStore(createPostgresChatState()), openEvent: (args) => host.engine.openEvent(args),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown Monday board webhook runtime error";
    return Response.json({ ok: false, error: "webhook-unavailable", errorDigest: sha256(message).slice(0, 16) }, { status: 503 });
  }
}
