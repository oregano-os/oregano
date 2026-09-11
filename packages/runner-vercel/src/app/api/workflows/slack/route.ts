import { loadArtifact } from "../../../../lib/artifact.ts";
import { after } from "next/server";
import { dispatchWorkflowSlackRequest } from "../../../../lib/workflow-slack-diagnostics.ts";

export async function POST(request: Request) {
  return dispatchWorkflowSlackRequest(request, {
    workflowOnly: process.env.COMPANYOS_WORKFLOW_ONLY === "true",
    channelBindings: process.env.COMPANYOS_WORKFLOW_ONLY === "true" ? loadArtifact().agentRouting.bindings : [],
    handler: async (original, options) => {
      // Include initialization failures in diagnostics, before the unchanged SDK verifier.
      const { getBot } = await import("../../../../lib/bot.ts");
      return getBot().webhooks.slack(original, options);
    },
    waitUntil: (task) => after(() => task),
  });
}
