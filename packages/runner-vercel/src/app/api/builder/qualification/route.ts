import { type BuilderAcpProfileId } from "../../../../../../runtime/builder/profiles.ts";
import {
  isStagedProductionQualificationRequest,
  qualifyDeployedAcp,
} from "../../../../lib/builder/deployed-acp-qualification.ts";
import { qualifyDeployedAcpCrashRecovery } from "../../../../lib/builder/deployed-acp-crash-qualification.ts";
import { qualifyDeployedTrustedGit } from "../../../../lib/builder/deployed-trusted-git-qualification.ts";

export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  if (!isStagedProductionQualificationRequest(request)) {
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  try {
    const body = await request.json() as Record<string, unknown>;
    if (Object.keys(body).length !== 1) throw new Error("invalid qualification request");
    if (body.gate === "trusted-git") {
      return Response.json({ ok: true, evidence: await qualifyDeployedTrustedGit() });
    }
    if (body.gate === "acp-crash-recovery") {
      return Response.json({ ok: true, evidence: await qualifyDeployedAcpCrashRecovery() });
    }
    if (body.profile === "claude-code" || body.profile === "codex") {
      return Response.json({ ok: true, evidence: await qualifyDeployedAcp(body.profile as BuilderAcpProfileId) });
    }
    throw new Error("invalid qualification request");
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && error.message === "invalid qualification request")) {
      return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
    }
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message : "Deployed Builder qualification failed.",
    }, { status: 500 });
  }
}
