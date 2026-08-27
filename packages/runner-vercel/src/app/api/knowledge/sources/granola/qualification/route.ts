import { createHash } from "node:crypto";
import { authorizeScheduledKnowledgeRequest, GranolaKnowledgeSourceRuntime } from "../../../../../../lib/knowledge-source-runtime.ts";

export const runtime = "nodejs";
export const maxDuration = 60;

const errorDigest = (value: unknown) => createHash("sha256").update(value instanceof Error ? value.message : String(value)).digest("hex");

export async function POST(request: Request) {
  if (!authorizeScheduledKnowledgeRequest(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const result = await new GranolaKnowledgeSourceRuntime().qualify();
    return Response.json(result, { status: result.ok ? 200 : 503 });
  } catch (error) {
    return Response.json({ ok: false, error: "qualification-failed", errorDigest: errorDigest(error) }, { status: 503 });
  }
}
