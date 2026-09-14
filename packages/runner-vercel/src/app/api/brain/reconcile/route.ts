import { protectProductionWorker } from "../../../../lib/production-worker-gate.ts";
import { authorizeCompanyRecordsScheduler } from "../../../../lib/company-records-production.ts";
import { initializeHostedArtifact, loadArtifact } from "../../../../lib/artifact.ts";
import { createRuntimeBrainFreshness } from "../../../../lib/brain.ts";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export const GET = protectProductionWorker(async (request: Request) => {
  if (!authorizeCompanyRecordsScheduler(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    await initializeHostedArtifact();
    const freshness = createRuntimeBrainFreshness(loadArtifact());
    if (!freshness) return Response.json({ ok: true, status: "not_enabled" });
    const result = await freshness.service.tick();
    return Response.json({ ok: result.status !== "retry_scheduled", ...result }, { status: result.status === "retry_scheduled" ? 503 : 200 });
  } catch {
    return Response.json({ ok: false, error: "brain-reconciliation-unavailable" }, { status: 503 });
  }
});
