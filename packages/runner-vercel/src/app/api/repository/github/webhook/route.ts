import { getGitHubRepositoryProvider } from "../../../../../lib/builder/provider-factory.ts";

export async function POST(request: Request): Promise<Response> {
  const webhookSecret = process.env.COMPANYOS_GITHUB_WEBHOOK_SECRET;
  if (!webhookSecret) return Response.json({ ok: false, error: "webhook-not-configured" }, { status: 503 });
  try {
    const rawBody = await request.text();
    const changed = await getGitHubRepositoryProvider().reconcileInstallationEvent({
      deliveryId: requiredHeader(request, "x-github-delivery"),
      event: requiredHeader(request, "x-github-event"),
      rawBody,
      signature: requiredHeader(request, "x-hub-signature-256"),
      webhookSecret,
    });
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
