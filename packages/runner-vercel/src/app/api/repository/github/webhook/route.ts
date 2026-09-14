import { getGitHubRepositoryProvider } from "../../../../../lib/builder/provider-factory.ts";
import { initializeHostedArtifact, loadArtifact } from "../../../../../lib/artifact.ts";
import { createRuntimeBrainFreshness } from "../../../../../lib/brain.ts";

export async function POST(request: Request): Promise<Response> {
  const webhookSecret = process.env.COMPANYOS_GITHUB_WEBHOOK_SECRET;
  if (!webhookSecret) return Response.json({ ok: false, error: "webhook-not-configured" }, { status: 503 });
  try {
    const rawBody = await request.text();
    const event = {
      deliveryId: requiredHeader(request, "x-github-delivery"),
      event: requiredHeader(request, "x-github-event"),
      rawBody,
      signature: requiredHeader(request, "x-hub-signature-256"),
      webhookSecret,
    };
    const provider = getGitHubRepositoryProvider();
    const changed = await provider.reconcileInstallationEvent(event);
    if (event.event === "push") {
      await initializeHostedArtifact();
      const freshness = createRuntimeBrainFreshness(loadArtifact());
      if (freshness?.pushEvents) {
        const push = await provider.brainPush(freshness.binding, event);
        if (push) return Response.json({ ok: true, changed, brain_sync_scheduled: await freshness.service.notify(push.delivery_id) });
      }
    }
    return Response.json({ ok: true, changed });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 2_000) : "Webhook reconciliation failed.",
    }, { status: 400 });
  }
}

function requiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name);
  if (!value) throw new Error(`Missing required GitHub header '${name}'.`);
  return value;
}
