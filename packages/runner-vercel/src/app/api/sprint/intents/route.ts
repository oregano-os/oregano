import { createHash } from "node:crypto";
import { authorizeSprintScheduler, runSprintIntentWorker } from "../../../../lib/sprint-runtime.ts";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const digest = (error: unknown): string => createHash("sha256")
  .update(error instanceof Error ? error.message : String(error))
  .digest("hex");

export async function GET(request: Request) {
  if (!authorizeSprintScheduler(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const result = await runSprintIntentWorker();
    return Response.json(result, { status: result.ok ? 200 : 503 });
  } catch (error) {
    const errorDigest = digest(error);
    console.error(JSON.stringify({ event: "sprint.intent-worker.failed", errorDigest }));
    return Response.json({ ok: false, error: "sprint-intent-worker-failed", errorDigest }, { status: 503 });
  }
}
