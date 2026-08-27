import { getBuilderService } from "../../../../lib/builder/provider-factory.ts";
import { getBot } from "../../../../lib/bot.ts";
import { createBuilderChatNotifier } from "../../../../lib/builder/chat-notifier.ts";
import { deliverNextBuilderNotification } from "../../../../../../runtime/builder/notifications.ts";
import { createPostgresBuilderJobStore } from "../../../../../../state-postgres/builder-job-store.ts";

export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const workerId = [
      "vercel",
      process.env.VERCEL_ENV ?? "unknown",
      process.env.VERCEL_REGION ?? "unknown",
      crypto.randomUUID(),
    ].join(":");
    const result = await getBuilderService().advanceOne(workerId);
    const notification = await deliverNextBuilderNotification({
      jobs: createPostgresBuilderJobStore(),
      notifier: createBuilderChatNotifier(getBot()),
      workerId: `${workerId}:notification`,
    });
    return Response.json({ ok: true, result, notification });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 2_000) : "Builder worker failed.",
    }, { status: 500 });
  }
}

export const POST = GET;
