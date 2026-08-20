import { after } from "next/server";
import { getBot } from "../../../../lib/bot.ts";

async function handleRequest(request: Request, context: { params: Promise<{ platform: string }> }) {
  const { platform } = await context.params;
  const bot = getBot();
  type Platform = keyof typeof bot.webhooks;
  const handler = bot.webhooks[platform as Platform];
  if (!handler) return new Response(`Unknown platform: ${platform}`, { status: 404 });
  return handler(request, { waitUntil: (task) => after(() => task) });
}

export const GET = handleRequest;
export const POST = handleRequest;
