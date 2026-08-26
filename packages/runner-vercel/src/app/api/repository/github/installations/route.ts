import { getGitHubRepositoryProvider } from "../../../../../lib/builder/provider-factory.ts";

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.COMPANYOS_REPOSITORY_ONBOARDING_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const body = await request.json() as Record<string, unknown>;
    const binding = await getGitHubRepositoryProvider().verifyInstallation({
      bindingId: requiredString(body.binding_id, "binding_id"),
      instanceId: requiredString(body.instance_id, "instance_id"),
      installationId: requiredString(body.installation_id, "installation_id"),
      repositoryId: requiredString(body.repository_id, "repository_id"),
      providerRepositoryId: requiredString(body.provider_repository_id, "provider_repository_id"),
      onboardingPrincipal: requiredString(body.onboarding_principal, "onboarding_principal"),
    });
    return Response.json({
      ok: true,
      binding: {
        bindingId: binding.bindingId,
        instanceId: binding.instanceId,
        providerId: binding.providerId,
        repositoryId: binding.repositoryId,
        status: binding.status,
        verifiedAt: binding.verifiedAt,
      },
    });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 2_000) : "Installation verification failed.",
    }, { status: 400 });
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 512) {
    throw new Error(`${name} is required and must be bounded.`);
  }
  return value;
}
