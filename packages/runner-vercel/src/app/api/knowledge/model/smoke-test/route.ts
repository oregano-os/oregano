import { createHash } from "node:crypto";
import { authorizeScheduledKnowledgeRequest } from "../../../../../lib/knowledge-source-runtime.ts";
import { VercelKnowledgeModelExecutor } from "../../../../../lib/knowledge-model-runtime.ts";

export const runtime = "nodejs";
export const maxDuration = 60;

const errorDigest = (value: unknown) => createHash("sha256").update(value instanceof Error ? value.message : String(value)).digest("hex");

export async function POST(request: Request) {
  if (!authorizeScheduledKnowledgeRequest(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    return Response.json(await new VercelKnowledgeModelExecutor().smokeTest(), { status: 200 });
  } catch (error) {
    return Response.json({ ok: false, error: "smoke-test-failed", errorDigest: errorDigest(error) }, { status: 503 });
  }
}
