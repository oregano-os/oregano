import type { SlackAdapter } from "@chat-adapter/slack";
import { getConnectorMetadata } from "@vercel/connect";
import { requireWorkflowSlackReplyEvents } from "./workflow-slack-events.ts";
import { connectSlackAdapter } from "@vercel/connect/chat";
import type { Chat } from "chat";
import type { Connector, JsonValue } from "../../../capabilities/contracts.ts";
import type { CompanyOSArtifact } from "../../../companyos-builder/types.ts";
import { WorkflowSlackTransport, type WorkflowSlackApi } from "../../../connectors/slack/workflow-transport.ts";
import type { RosterMember } from "../../../state-store/roster.ts";

export type WorkflowSlackScope = <T>(operation: (transport: WorkflowSlackTransport) => Promise<T>) => Promise<T>;

/** One resolved credential scopes qualification AND provider dispatch, including token rotation. */
export function createWorkflowSlackScope(chat: () => Chat): WorkflowSlackScope {
  return async (operation) => {
    const connector = process.env.SLACK_CONNECTOR;
    if (!connector) throw new Error("SLACK_CONNECTOR is required for workflow transport");
    const source = connectSlackAdapter(connector).botToken;
    const token = typeof source === "function" ? await source() : source;
    if (!token) throw new Error("Workflow Slack credential is unavailable");
    const adapter = chat().getAdapter("slack") as SlackAdapter;
    return adapter.withBotToken(token, async () => {
      const api: WorkflowSlackApi = {
        call: (method, args) => adapter.webClient.apiCall(method, args),
        qualifyReplies: async (kind) => requireWorkflowSlackReplyEvents(await getConnectorMetadata(connector), kind),
      };
      const transport = new WorkflowSlackTransport(api), account = await transport.account();
      return adapter.withBotToken(token, () => operation(transport), { installationId: account });
    });
  };
}

export function workflowMessageDestination(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof (input as Record<string, unknown>).destination_binding !== "string") throw new Error("Workflow message input has no destination binding");
  return (input as Record<string, string>).destination_binding!;
}

export async function qualifyWorkflowMessageInputs(args: { scope: WorkflowSlackScope; artifact: CompanyOSArtifact; inputs: readonly JsonValue[]; roster: () => Promise<RosterMember[]> }): Promise<JsonValue> {
  return args.scope(async (transport) => {
    const roster = await args.roster(), proofs: JsonValue[] = [];
    for (const destination of new Set(args.inputs.map(workflowMessageDestination))) proofs.push(await transport.qualify(args.artifact, destination, roster));
    return { destinations: proofs };
  });
}

export function qualifyWorkflowSlackConnector(args: { connector: Connector; artifact: CompanyOSArtifact; scope: WorkflowSlackScope; roster: () => Promise<RosterMember[]> }): Connector {
  const { connector } = args;
  if (connector.id !== "oregano/slack-communication") return connector;
  return { id: connector.id, version: connector.version, capabilities: connector.capabilities,
    invoke: (capability, input, context) => args.scope(async (transport) => {
      const proof = await transport.qualify(args.artifact, workflowMessageDestination(input), await args.roster());
      const result = await connector.invoke(capability, input, context);
      return { ...result, evidence: { ...result.evidence, destination_qualification: proof } };
    }),
  };
}
