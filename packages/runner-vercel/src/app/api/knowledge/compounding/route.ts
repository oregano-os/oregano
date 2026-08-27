import { createHash } from "node:crypto";
import { CompanyKnowledgeCompoundingRuntime } from "../../../../lib/knowledge-model-runtime.ts";
import { authorizeScheduledKnowledgeRequest, classifyKnowledgeSourceRuntimeError, describeKnowledgeSourceRuntimeError } from "../../../../lib/knowledge-source-runtime.ts";

export const runtime = "nodejs";
export const maxDuration = 300;

const errorDigest = (value: unknown) => createHash("sha256").update(value instanceof Error ? value.message : String(value)).digest("hex");

async function handle(request: Request) {
  if (!authorizeScheduledKnowledgeRequest(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    return Response.json(await new CompanyKnowledgeCompoundingRuntime().process(), { status: 200 });
  } catch (error) {
    return Response.json({ ok: false, error: "compounding-failed", reasonCode: classifyKnowledgeSourceRuntimeError(error), diagnostic: describeKnowledgeSourceRuntimeError(error), errorDigest: errorDigest(error) }, { status: 503 });
  }
}

export const GET = handle;
export const POST = handle;
