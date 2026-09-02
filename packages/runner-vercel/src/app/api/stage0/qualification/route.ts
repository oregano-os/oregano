import { createHash } from "node:crypto";
import { getBot, getCompanyOSRuntime } from "../../../../lib/bot.ts";
import { loadArtifact } from "../../../../lib/artifact.ts";
import {
  authorizeStage0,
  decodeStage0Configuration,
  executeStage0,
  parseStage0Request,
  Stage0QualificationError,
} from "../../../../lib/stage0-qualification.ts";

export const runtime = "nodejs";
export const maxDuration = 300;

const errorDigest = (value: unknown): string => createHash("sha256")
  .update(value instanceof Error ? value.message : String(value))
  .digest("hex");

export async function POST(request: Request) {
  if (!authorizeStage0(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > 16_384) return Response.json({ ok: false, error: "request-too-large" }, { status: 413 });
    const input = parseStage0Request(JSON.parse(raw));
    const configuration = decodeStage0Configuration();
    const chat = getBot();
    const result = await executeStage0(input, configuration, {
      artifact: loadArtifact(),
      runtime: getCompanyOSRuntime(),
      chat,
    });
    return Response.json(result, { status: result.ok === false ? 409 : 200 });
  } catch (error) {
    if (error instanceof Stage0QualificationError) {
      console.error(JSON.stringify({ event: "stage0.qualification.rejected", reason: error.code, errorDigest: errorDigest(error) }));
      return Response.json({ ok: false, error: error.code, errorDigest: errorDigest(error) }, { status: error.status });
    }
    console.error(JSON.stringify({ event: "stage0.qualification.failed", errorDigest: errorDigest(error) }));
    return Response.json({ ok: false, error: "stage0-failed", errorDigest: errorDigest(error) }, { status: 503 });
  }
}
