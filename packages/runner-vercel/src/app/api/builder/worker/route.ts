import { getBuilderService } from "../../../../lib/builder/provider-factory.ts";
import { getBot } from "../../../../lib/bot.ts";
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
    let notification: "not-required" | "posted" | "failed" = "not-required";
    if (result.jobId && ["published", "failed", "cancelled"].includes(result.state)) {
      const job = await createPostgresBuilderJobStore().get(result.jobId);
      if (job) {
        try {
          const message = result.state === "published"
            ? `Builder proposal ${job.jobId} passed the independent checks and is ready for human review: ${result.proposalUrl}`
            : result.state === "cancelled"
              ? `Builder proposal ${job.jobId} was cancelled. No proposal was published.`
              : `Builder proposal ${job.jobId} failed closed. No proposal was published. Reason: ${result.error ?? job.terminalReason ?? "unknown"}`;
          await getBot().thread(job.sourceConversationKey).post(message);
          notification = "posted";
        } catch {
          notification = "failed";
        }
      }
    }
    return Response.json({ ok: true, result, notification });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 2_000) : "Builder worker failed.",
    }, { status: 500 });
  }
}

export const POST = GET;
