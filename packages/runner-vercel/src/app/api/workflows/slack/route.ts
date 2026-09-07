import { after } from "next/server";
import { getBot } from "../../../../lib/bot.ts";
import { isWorkflowActionRequest, isWorkflowThreadRequest } from "../../../../lib/workflow-action-ingress.ts";

export async function POST(request: Request) {
  if (!await isWorkflowActionRequest(request) && !(process.env.COMPANYOS_WORKFLOW_ONLY === "true" && await isWorkflowThreadRequest(request))) return new Response(null, { status: 200 });
  // Filtering is not authentication: the unchanged SDK verifier must validate
  // the original request before invoking the existing workflow action handler.
  return getBot().webhooks.slack(request, { waitUntil: (task) => after(() => task) });
}
