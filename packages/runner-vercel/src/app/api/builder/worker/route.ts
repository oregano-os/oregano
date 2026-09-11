import { protectProductionWorker } from "../../../../lib/production-worker-gate.ts";
import { getBuilderService } from "../../../../lib/builder/provider-factory.ts";
import { getBuilderTerminalNotifier, advanceBuilderRelease, reportBuilderProgress } from "../../../../lib/bot.ts";
import { handleBuilderWorkerRequest } from "../../../../lib/builder/worker-endpoint.ts";
import { loadArtifact } from "../../../../lib/artifact.ts";
import { deliverNextBuilderNotification } from "../../../../../../runtime/builder/notifications.ts";
import { createPostgresBuilderJobStore } from "../../../../../../state-postgres/builder-job-store.ts";

export const maxDuration = 300;

async function handleScheduledRequest(request: Request): Promise<Response> {
  return handleBuilderWorkerRequest(request, {
    cronSecret: process.env.CRON_SECRET,
    loadArtifact,
    createWorkerId: () => [
      "vercel",
      process.env.VERCEL_ENV ?? "unknown",
      process.env.VERCEL_REGION ?? "unknown",
      crypto.randomUUID(),
    ].join(":"),
    advanceOne: (workerId) => getBuilderService().advanceOne(workerId, reportBuilderProgress),
    advanceRelease: advanceBuilderRelease,
    deliverNotification: (workerId) => deliverNextBuilderNotification({
      jobs: createPostgresBuilderJobStore(),
      notifier: getBuilderTerminalNotifier(),
      workerId,
    }),
  });
}

export const GET = protectProductionWorker(handleScheduledRequest);
export const POST = GET;
