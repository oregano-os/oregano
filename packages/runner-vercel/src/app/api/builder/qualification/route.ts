import { type BuilderAcpProfileId } from "../../../../../../runtime/builder/profiles.ts";
import {
  isStagedProductionQualificationRequest,
  qualifyDeployedAcp,
} from "../../../../lib/builder/deployed-acp-qualification.ts";

export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  if (!isStagedProductionQualificationRequest(request)) {
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  let profile: BuilderAcpProfileId;
  try {
    const body = await request.json() as Record<string, unknown>;
    if (
      Object.keys(body).length !== 1
      || (body.profile !== "claude-code" && body.profile !== "codex")
    ) {
      throw new Error("invalid qualification request");
    }
    profile = body.profile;
  } catch {
    return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
  try {
    return Response.json({ ok: true, evidence: await qualifyDeployedAcp(profile) });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message : "Deployed ACP qualification failed.",
    }, { status: 500 });
  }
}
