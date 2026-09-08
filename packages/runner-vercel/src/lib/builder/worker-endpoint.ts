export interface BuilderWorkerEndpointDependencies {
  readonly cronSecret?: string;
  loadArtifact(): { readonly builder?: unknown };
  advanceOne(workerId: string): Promise<unknown>;
  advanceRelease?(workerId: string): Promise<unknown>;
  deliverNotification(workerId: string): Promise<unknown>;
  createWorkerId(): string;
}

export async function handleBuilderWorkerRequest(
  request: Request,
  dependencies: BuilderWorkerEndpointDependencies,
): Promise<Response> {
  if (!dependencies.cronSecret
    || request.headers.get("authorization") !== `Bearer ${dependencies.cronSecret}`) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    if (!dependencies.loadArtifact().builder) {
      return Response.json({
        ok: true,
        enabled: false,
        result: { state: "idle", reason: "builder-disabled" },
        notification: { state: "idle", reason: "builder-disabled" },
      });
    }

    const workerId = dependencies.createWorkerId();
    const release = await dependencies.advanceRelease?.(`${workerId}:release`);
    const result = await dependencies.advanceOne(workerId);
    const notification = await dependencies.deliverNotification(`${workerId}:notification`);
    return Response.json({ ok: true, enabled: true, result, notification, ...(release === undefined ? {} : { release }) });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 2_000) : "Builder worker failed.",
    }, { status: 500 });
  }
}
