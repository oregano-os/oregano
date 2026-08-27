import { createHash } from "node:crypto";
import { authorizeScheduledKnowledgeRequest } from "../../../../../lib/knowledge-source-runtime.ts";
import { VercelKnowledgeModelExecutor } from "../../../../../lib/knowledge-model-runtime.ts";

export const runtime = "nodejs";
export const maxDuration = 300;

const errorDigest = (value: unknown) => createHash("sha256").update(value instanceof Error ? value.message : String(value)).digest("hex");

export async function POST(request: Request) {
  if (!authorizeScheduledKnowledgeRequest(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const maximumFixtures = Number(new URL(request.url).searchParams.get("maximumFixtures") ?? undefined);
    const result = await new VercelKnowledgeModelExecutor().qualifyFixtures({ ...(Number.isFinite(maximumFixtures) ? { maximumFixtures } : {}) });
    return Response.json(result, { status: result.ok ? 200 : 503 });
  } catch (error) {
    return Response.json({ ok: false, error: "model-qualification-failed", errorDigest: errorDigest(error) }, { status: 503 });
  }
}
