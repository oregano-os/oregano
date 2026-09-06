import { sha256 } from "../../../runtime/canonical.ts";
import { loadArtifact } from "./artifact.ts";
import { authenticateWorkflowOperator, authenticateWorkflowScheduler, decodeWorkflowHostingConfiguration, workflowHostingEnabled } from "./workflow-configuration.ts";
import type { WorkflowWorkerKind } from "../../../runtime/workflow-engine/workers.ts";
import type { WorkflowRun } from "../../../state-store/workflow-engine.ts";

export type WorkflowOperatorRequest =
  | { action: "open"; workflowId: string; requestId: string; fields: Record<string, string> }
  | { action: "schedule"; workflowId: string; instant: string; fields: Record<string, string> }
  | { action: "read" | "resume" | "cancel"; runId: string }
  | { action: "list"; afterRunId?: string }
  | { action: "receive-reply"; threadId: string; messageId: string };

export function parseWorkflowOperatorRequest(value: unknown): WorkflowOperatorRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workflow operator request must be an object");
  const input = value as Record<string, unknown>;
  const exact = (allowed: string[]) => { if (Object.keys(input).some((key) => !["action", ...allowed].includes(key))) throw new Error("Unsupported workflow operator request field"); };
  const text = (key: string, pattern = /^[^\u0000-\u001f]{1,255}$/) => { if (typeof input[key] !== "string" || !pattern.test(input[key])) throw new Error(`Invalid workflow operator ${key}`); return input[key] as string; };
  if (input.action === "open" || input.action === "schedule") {
    exact(["workflowId", "fields", input.action === "open" ? "requestId" : "instant"]);
    const fields = input.fields;
    if (!fields || typeof fields !== "object" || Array.isArray(fields) || Object.keys(fields).length > 100
      || Object.entries(fields).some(([key, value]) => !/^[a-z][a-z0-9_]{0,62}$/.test(key) || typeof value !== "string" || !/^[^\u0000-\u001f]{1,255}$/.test(value))) throw new Error("Workflow opening fields must be a bounded string map");
    const common = { workflowId: text("workflowId", /^[a-z][a-z0-9-]{1,62}$/), fields: { ...fields } as Record<string, string> };
    return input.action === "open" ? { action: "open", ...common, requestId: text("requestId") } : { action: "schedule", ...common, instant: text("instant") };
  }
  if (input.action === "read" || input.action === "resume" || input.action === "cancel") { exact(["runId"]); return { action: input.action, runId: text("runId", /^workflow:[a-f0-9]{64}$/) }; }
  if (input.action === "list") { exact(["afterRunId"]); return { action: "list", ...(input.afterRunId === undefined ? {} : { afterRunId: text("afterRunId", /^workflow:[a-f0-9]{64}$/) }) }; }
  if (input.action === "receive-reply") { exact(["threadId", "messageId"]); return { action: "receive-reply", threadId: text("threadId", /^slack:[A-Z0-9]{5,32}:\d+\.\d+$/), messageId: text("messageId", /^\d+\.\d+$/) }; }
  throw new Error("Unsupported workflow operator action");
}

async function boundedRequest(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Workflow operator request body is required");
  let bytes = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 32_768) { await reader.cancel(); throw new Error("Workflow operator request exceeds 32 KiB"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const summary = (run: WorkflowRun) => ({ runId: run.runId, workflowId: run.workflowId, artifactHash: run.artifactHash, manifestHash: run.manifestHash,
  status: run.state.status, stepId: run.state.cursor, revision: run.revision, updatedAt: run.updatedAt,
  ...(run.state.wait ? { wait: run.state.wait } : {}), ...(run.state.blocked ? { blocked: run.state.blocked } : {}) });
const failure = (event: string, error: unknown) => {
  const errorDigest = sha256(error instanceof Error ? error.message : String(error));
  console.error(JSON.stringify({ event, errorDigest }));
  return Response.json({ ok: false, error: event, errorDigest }, { status: 503 });
};

export async function handleWorkflowWorker(request: Request, kind: WorkflowWorkerKind | "records"): Promise<Response> {
  if (!authenticateWorkflowScheduler(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    if (!workflowHostingEnabled()) return Response.json({ ok: true, enabled: false });
    const { createWorkflowHost } = await import("./workflow-host.ts");
    const host = await createWorkflowHost();
    const result = await (kind === "records" ? host.records.run() : host.workers.run(kind));
    return Response.json(result, { status: result.ok ? 200 : 503 });
  } catch (error) { return failure(`workflow.${kind}-worker.failed`, error); }
}

export async function handleWorkflowOperator(request: Request): Promise<Response> {
  try {
    if (!workflowHostingEnabled()) return Response.json({ ok: false, error: "workflow-disabled" }, { status: 409 });
    const artifact = loadArtifact(), configuration = decodeWorkflowHostingConfiguration(artifact);
    const principal = authenticateWorkflowOperator(request, configuration);
    if (!principal) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    let action: WorkflowOperatorRequest;
    try { action = parseWorkflowOperatorRequest(await boundedRequest(request)); }
    catch (error) { return Response.json({ ok: false, error: error instanceof Error ? error.message : "Invalid request" }, { status: 400 }); }
    const { createWorkflowHost } = await import("./workflow-host.ts");
    const host = await createWorkflowHost();
    if (action.action === "open") return Response.json({ ok: true, run: summary(await host.engine.openOperator({ ...action, principal })) });
    if (action.action === "schedule") return Response.json({ ok: true, run: summary(await host.engine.openScheduled({ ...action, principal })) });
    if (action.action === "read") {
      const run = await host.store.read(artifact.instance.id, action.runId);
      return Response.json({ ok: !!run, run: run ? summary(run) : null }, { status: run ? 200 : 404 });
    }
    if (action.action === "list") {
      const runs = await host.store.list({ instanceId: artifact.instance.id, limit: 200, ...(action.afterRunId ? { afterRunId: action.afterRunId } : {}) });
      return Response.json({ ok: true, runs: runs.map(summary), ...(runs.length === 200 ? { afterRunId: runs.at(-1)!.runId } : {}) });
    }
    if (action.action === "cancel") return Response.json({ ok: true, cancelled: await host.engine.cancel(action.runId, principal) });
    if (action.action === "resume") return Response.json({ ok: true, run: summary(await host.engine.resume(action.runId, principal)) });
    if (action.action === "receive-reply") {
      const result = await host.conversations.receive(action);
      // This endpoint can recover actual decisions through the existing app.
      // It neither runs a conversational model nor posts ungoverned messages.
      return Response.json({ ok: true, kind: result.kind, ...(result.kind === "decision" ? { runId: result.runId, decision: result.decision } : {}) });
    }
    throw new Error("Unsupported workflow operator request");
  } catch (error) { return failure("workflow.operator.failed", error); }
}
