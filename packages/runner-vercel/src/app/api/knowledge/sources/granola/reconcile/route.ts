import { createHash } from "node:crypto";
import { authorizeScheduledKnowledgeRequest, classifyKnowledgeSourceRuntimeError, describeKnowledgeSourceRuntimeError, GranolaKnowledgeSourceRuntime } from "../../../../../../lib/knowledge-source-runtime.ts";

export const runtime = "nodejs";
export const maxDuration = 300;

const errorDigest = (value: unknown) => createHash("sha256").update(value instanceof Error ? value.message : String(value)).digest("hex");

async function handle(request: Request) {
  if (!authorizeScheduledKnowledgeRequest(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const result = await new GranolaKnowledgeSourceRuntime().reconcile();
    if (result.status === "busy") return Response.json(result, { status: 200 });
    const outcomes = result.results.reduce<Record<string, number>>((counts, entry) => {
      counts[entry.outcome] = (counts[entry.outcome] ?? 0) + 1;
      return counts;
    }, {});
    return Response.json({
      ok: result.ok,
      status: result.status,
      sourceId: result.sourceId,
      streamId: result.streamId,
      complete: result.complete,
      watermarkAdvanced: result.watermarkAdvanced,
      received: result.received,
      unchanged: result.unchanged,
      pages: result.pages,
      outcomes,
      receiptCount: result.receiptIds.length,
      ...(result.completedWatermark ? { completedWatermark: result.completedWatermark } : {}),
    }, { status: 200 });
  } catch (error) {
    return Response.json({ ok: false, error: "reconciliation-failed", reasonCode: classifyKnowledgeSourceRuntimeError(error), diagnostic: describeKnowledgeSourceRuntimeError(error), errorDigest: errorDigest(error) }, { status: 503 });
  }
}

export const GET = handle;
export const POST = handle;
