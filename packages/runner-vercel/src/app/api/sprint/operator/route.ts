import { createHash } from "node:crypto";
import {
  authorizeSprintOperator,
  executeSprintOperator,
  parseSprintOperatorRequest,
} from "../../../../lib/sprint-runtime.ts";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const digest = (error: unknown): string => createHash("sha256")
  .update(error instanceof Error ? error.message : String(error))
  .digest("hex");

export async function POST(request: Request) {
  if (!authorizeSprintOperator(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const input = parseSprintOperatorRequest(await request.text());
    return Response.json(await executeSprintOperator(input));
  } catch (error) {
    const errorDigest = digest(error);
    console.error(JSON.stringify({ event: "sprint.operator.failed", errorDigest }));
    return Response.json({ ok: false, error: "sprint-operator-failed", errorDigest }, { status: 409 });
  }
}
