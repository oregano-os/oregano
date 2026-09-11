import { loadArtifact } from "../../../../lib/artifact.ts";
import { ignoreUnownedSlackConversation } from "../../../../lib/slack-conversation-ownership.ts";
import { ignoreSlackChannelEvent } from "../../../../lib/slack-channel-events.ts";
import { after } from "next/server";
import { getBot } from "../../../../lib/bot.ts";
import { handleConfiguredMondayAgentWebhook } from "../../../../lib/monday-agent-webhook.ts";

async function handleRequest(request: Request, context: { params: Promise<{ platform: string }> }) {
  const { platform } = await context.params;
  if (platform === "monday") return await handleConfiguredMondayAgentWebhook(request);
  if (platform === "slack" && await ignoreSlackChannelEvent(request, process.env.SLACK_CHANNEL_MESSAGE_EVENTS, process.env.SLACK_IGNORED_CHANNEL_IDS, process.env.COMPANYOS_WORKFLOW_ONLY === "true" ? [] : undefined, process.env.SLACK_OWNED_CHANNEL_IDS)) return new Response(null, { status: 200 });
  if (platform === "slack" && process.env.COMPANYOS_WORKFLOW_ONLY === "true"
    && await ignoreUnownedSlackConversation(request, loadArtifact().agentRouting.bindings)) return new Response(null, { status: 200 });
  const bot = getBot();
  type Platform = keyof typeof bot.webhooks;
  const handler = bot.webhooks[platform as Platform];
  if (!handler) return new Response(`Unknown platform: ${platform}`, { status: 404 });
  return handler(request, { waitUntil: (task) => after(() => task) });
}

export const GET = handleRequest;
export const POST = handleRequest;
