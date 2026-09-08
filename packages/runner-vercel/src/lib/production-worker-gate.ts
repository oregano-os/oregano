type Environment = Readonly<Record<string, string | undefined>>;

/** Production-target deployments can receive cron calls before domain promotion. */
export function protectProductionWorker(
  handler: (request: Request) => Promise<Response>,
  dependencies: { environment?: Environment; fetch?: typeof fetch } = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    const environment = dependencies.environment ?? process.env;
    if (environment.VERCEL_ENV !== "production") return handler(request);
    try {
      const deploymentId = environment.VERCEL_DEPLOYMENT_ID;
      if (!deploymentId) throw new Error("Production deployment identity is unavailable.");
      const bindingValue = environment.COMPANYOS_BUILDER_RELEASE_BINDING_BASE64;
      if (bindingValue && bindingValue.length > 100000) throw new Error("Invalid production binding.");
      const binding = bindingValue ? JSON.parse(Buffer.from(bindingValue, "base64").toString("utf8")) : undefined;
      const origin = binding?.productionUrl ?? (environment.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${environment.VERCEL_PROJECT_PRODUCTION_URL}` : undefined);
      if (!origin) throw new Error("Production URL is unavailable.");
      const url = new URL(origin);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
        || !["", "/"].includes(url.pathname)) throw new Error("Invalid production URL.");
      const response = await (dependencies.fetch ?? fetch)(new URL("/api/health", url), {
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("Production health is unavailable.");
      const health = await response.json();
      if (health.ok !== true || typeof health.deploymentId !== "string") throw new Error("Production identity is unverified.");
      if (health.deploymentId !== deploymentId) {
        return Response.json({ ok: false, error: "deployment-not-live" }, { status: 409 });
      }
    } catch {
      return Response.json({ ok: false, error: "production-identity-unavailable" }, { status: 503 });
    }
    return handler(request);
  };
}
