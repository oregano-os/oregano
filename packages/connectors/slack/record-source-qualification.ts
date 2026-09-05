import { createHash } from "node:crypto";
import { SlackWebApiClient, type SlackFetch } from "./client.ts";

export interface SlackRecordSourceQualification {
  readonly kind: "slack-record-source-qualification";
  readonly phase: "complete";
  readonly evidence: {
    readonly discovery: {
      readonly discovery_hash: string;
      readonly observed_at: string;
      readonly authentication_mode: "bot-token";
      readonly credentials_retained: false;
      readonly team_id: string;
      readonly bot_user_id: string;
      readonly channel: {
        readonly id: string;
        readonly kind: "public-channel" | "private-channel";
        readonly is_member: true;
      };
      readonly scopes: readonly string[];
      readonly request_ids: readonly string[];
    };
  };
}

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Produce content-free qualification evidence. The token is supplied by an
 * Instance SecretRef and is never returned or retained in the receipt.
 */
export async function qualifySlackRecordSource(args: {
  token: string;
  teamId: string;
  channelId: string;
  now?: () => Date;
  fetcher?: SlackFetch;
}): Promise<SlackRecordSourceQualification> {
  const client = new SlackWebApiClient({ token: args.token, ...(args.fetcher ? { fetcher: args.fetcher } : {}) });
  const [identity, conversation] = await Promise.all([
    client.authTest(),
    client.conversationInfo(args.channelId),
  ]);
  if (identity.data.team_id !== args.teamId) throw new Error(`Slack qualification authenticated team '${identity.data.team_id}', not '${args.teamId}'`);
  const channel = conversation.data.channel;
  if (String(channel.id ?? "") !== args.channelId) throw new Error(`Slack qualification did not return exact channel '${args.channelId}'`);
  const kind: "private-channel" | "public-channel" = channel.is_private === true ? "private-channel" : "public-channel";
  if (channel.is_member !== true) throw new Error(`Slack bot is not a member of channel '${args.channelId}'`);
  const scopes = [...new Set([...identity.scopes, ...conversation.scopes])].sort();
  const required = kind === "private-channel"
    ? ["groups:history", "groups:read"]
    : ["channels:history", "channels:read"];
  const missing = required.filter((scope) => !scopes.includes(scope));
  if (missing.length > 0) throw new Error(`Slack qualification lacks required scope(s): ${missing.join(", ")}`);
  const facts = {
    observed_at: (args.now ?? (() => new Date()))().toISOString(),
    authentication_mode: "bot-token" as const,
    credentials_retained: false as const,
    team_id: identity.data.team_id,
    bot_user_id: identity.data.user_id,
    channel: { id: args.channelId, kind, is_member: true as const },
    scopes,
    request_ids: [identity.requestId, conversation.requestId].filter((value): value is string => Boolean(value)).sort(),
  };
  return {
    kind: "slack-record-source-qualification",
    phase: "complete",
    evidence: { discovery: { discovery_hash: digest(facts), ...facts } },
  };
}
