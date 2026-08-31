import { getBuilderService } from "../../../../lib/builder/provider-factory.ts";
import { getBot } from "../../../../lib/bot.ts";
import { createBuilderChatNotifier } from "../../../../lib/builder/chat-notifier.ts";
import { handleBuilderWorkerRequest } from "../../../../lib/builder/worker-endpoint.ts";
import { loadArtifact } from "../../../../lib/artifact.ts";
import { deliverNextBuilderNotification } from "../../../../../../runtime/builder/notifications.ts";
import { createPostgresBuilderJobStore } from "../../../../../../state-postgres/builder-job-store.ts";

export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  return handleBuilderWorkerRequest(request, {
    cronSecret: process.env.CRON_SECRET,
    loadArtifact,
    createWorkerId: () => [
      "vercel",
      process.env.VERCEL_ENV ?? "unknown",
      process.env.VERCEL_REGION ?? "unknown",
      crypto.randomUUID(),
    ].join(":"),
    advanceOne: (workerId) => getBuilderService().advanceOne(workerId),
    deliverNotification: (workerId) => deliverNextBuilderNotification({
      jobs: createPostgresBuilderJobStore(),
      notifier: createBuilderChatNotifier(getBot()),
      workerId,
    }),
  });
}

export const POST = GET;
