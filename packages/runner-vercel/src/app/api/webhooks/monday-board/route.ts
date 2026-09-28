import { handleConfiguredMondayBoardWebhook } from "../../../../lib/monday-board-webhook.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = handleConfiguredMondayBoardWebhook;
export const GET = handleConfiguredMondayBoardWebhook;
