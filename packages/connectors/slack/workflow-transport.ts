import type { JsonValue } from "../../capabilities/contracts.ts";
import type { CompanyOSArtifact } from "../../companyos-builder/types.ts";
import type { WorkflowConversation } from "../../state-store/workflow-engine.ts";
import { findByCanonicalPrincipal, isHumanRosterMember, type RosterMember } from "../../state-store/roster.ts";
import { sha256 } from "../../runtime/canonical.ts";

export type WorkflowSlackChannelKind = "direct-message" | "private-channel" | "public-channel";
export interface WorkflowSlackApi {
  qualifyReplies?(kind: WorkflowSlackChannelKind, principal?: string): Promise<void>;
  call(method: "auth.test" | "users.info" | "conversations.info" | "conversations.replies" | "conversations.history" | "chat.getPermalink", args: Record<string, string>): Promise<Record<string, any>>;
}
export interface WorkflowSlackDestination { id: string; accountId: string; channelId?: string; userId?: string; kind: "channel" | "direct-message" }

export function workflowSlackDestination(artifact: CompanyOSArtifact, destination: string): WorkflowSlackDestination {
  const binding = artifact.bindings.find((binding) => binding.capability === "communication.message.publish");
  const candidates = (artifact.connectors ?? []).filter((entry) => entry.connector === "oregano/slack-communication" && entry.connectorVersion === binding?.connectorVersion && entry.connector === binding?.connector)
    .flatMap((entry) => Array.isArray(entry.configuration.destinations) ? entry.configuration.destinations : [])
    .filter((value: any) => value?.id === destination) as Array<Record<string, JsonValue>>;
  if (candidates.length !== 1) throw new Error("Workflow message requires one exact configured Slack destination");
  const value = candidates[0]!;
  if (typeof value.account_id !== "string" || !/^[A-Z0-9]{5,32}$/.test(value.account_id)) throw new Error("Workflow Slack account identity is invalid");
  if (value.kind === "channel" && typeof value.channel_id === "string" && /^[A-Z0-9]{5,32}$/.test(value.channel_id) && value.user_id === undefined) return { id: destination, accountId: value.account_id, kind: "channel", channelId: value.channel_id };
  if (value.kind === "direct-message" && typeof value.user_id === "string" && /^[A-Z0-9]{5,32}$/.test(value.user_id) && value.channel_id === undefined) return { id: destination, accountId: value.account_id, kind: "direct-message", userId: value.user_id };
  throw new Error("Workflow Slack destination is not an exact channel or person");
}

/** Read-only provider checks; neither roster display names nor declared account IDs prove identity. */
export class WorkflowSlackTransport {
  readonly #api: WorkflowSlackApi;
  constructor(api: WorkflowSlackApi) { this.#api = api; }
  async permalink(threadReference: string): Promise<string> {
    const match = /^slack:([A-Z0-9]{5,32}):(\d+\.\d+)$/.exec(threadReference);
    if (!match) throw new Error("A permalink needs an exact Slack conversation.");
    const response = await this.#api.call("chat.getPermalink", { channel: match[1]!, message_ts: match[2]! });
    if (response.ok !== true || response.channel !== match[1] || typeof response.permalink !== "string") throw new Error("Slack returned no matching test permalink.");
    const url = new URL(response.permalink);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".slack.com") || url.username || url.password
      || !url.pathname.startsWith(`/archives/${match[1]}/`)) throw new Error("Slack returned an invalid test permalink.");
    return url.href;
  }
  async account(): Promise<string> {
    const auth = await this.#api.call("auth.test", {});
    if (auth.ok !== true || typeof auth.team_id !== "string" || !/^[A-Z0-9]{5,32}$/.test(auth.team_id)) throw new Error("Slack token has no verified account");
    return auth.team_id;
  }
  async human(accountId: string, userId: string, roster: RosterMember[]): Promise<string> {
    const principal = `slack:${accountId}:${userId}`, member = findByCanonicalPrincipal(roster, principal);
    if (!member?.id || !isHumanRosterMember(member) || !/^(active|aktiv)$/i.test(member.status)) throw new Error("Slack participant is not one exact current human");
    const response = await this.#api.call("users.info", { user: userId }), user = response.user;
    if (response.ok !== true || user?.id !== userId || user.team_id !== accountId || user.deleted !== false || user.is_bot !== false || user.is_app_user === true) throw new Error("Slack participant's current human identity could not be verified");
    return principal;
  }
  /** Reread the exact provider object; a caller's text/user/account is never approval evidence. */
  async reply(args: { conversation: WorkflowConversation; messageId: string; roster: RosterMember[]; channelReply?: boolean }): Promise<{ principal: string; text: string; eventId: string }> {
    const { conversation: c, messageId } = args;
    if (c.surface !== "slack" || !/^[A-Z0-9]{5,32}$/.test(c.channelId) || !/^\d+\.\d+$/.test(c.threadId)
      || !/^\d+\.\d+$/.test(messageId) || messageId === c.threadId || c.accountId !== await this.account()) throw new Error("Workflow reply identity is invalid");
    if (args.channelReply && (!/^[CDG]/.test(c.channelId) || Number(messageId) <= Number(c.threadId))) throw new Error("Root reply predates its question");
    const response = args.channelReply
      ? await this.#api.call("conversations.history", { channel: c.channelId, oldest: messageId, latest: messageId, inclusive: "true", limit: "15" })
      : await this.#api.call("conversations.replies", { channel: c.channelId, ts: c.threadId, oldest: messageId, latest: messageId, inclusive: "true", limit: "15" });
    const matches = Array.isArray(response.messages) ? response.messages.filter((message: any) => message.ts === messageId) : [];
    if (response.ok !== true || response.has_more === true || response.response_metadata?.next_cursor || matches.length !== 1) throw new Error("The exact workflow reply could not be read completely");
    const message = matches[0];
    if ((args.channelReply ? message.thread_ts && message.thread_ts !== messageId : message.thread_ts !== c.threadId) || message.type !== "message" || message.bot_id || message.app_id || message.subtype || message.edited
      || typeof message.text !== "string" || typeof message.user !== "string") throw new Error("Workflow reply is not an original attributable human message");
    const principal = await this.human(c.accountId, message.user, args.roster);
    if (c.subjectPrincipal && c.subjectPrincipal !== principal) throw new Error("Workflow reply belongs to another private recipient");
    return { principal, text: message.text, eventId: `slack:${c.accountId}:${c.channelId}:${messageId}` };
  }
  private async channelRecipient(artifact: CompanyOSArtifact, destination: string, accountId: string, roster: RosterMember[]): Promise<string | undefined> {
    const recipients = artifact.workflowBindings?.directRecipients.filter((entry) => entry.destinationBinding === destination) ?? [];
    if (!recipients.length) return undefined;
    const ids = [...new Set(recipients.map((entry) => entry.memberId))];
    if (ids.length !== 1) throw new Error("Recipient-bound channel requires one exact member");
    const members = roster.filter((entry) => entry.id === ids[0]);
    if (members.length !== 1) throw new Error("Channel recipient has no exact member identity");
    const principals = members[0]!.principals?.filter((value) => value.startsWith(`slack:${accountId}:`)) ?? [];
    if (principals.length !== 1) throw new Error("Channel recipient has no exact account identity");
    return this.human(accountId, principals[0]!.split(":")[2]!, roster);
  }
  async qualify(artifact: CompanyOSArtifact, destination: string, roster: RosterMember[]): Promise<JsonValue> {
    const binding = workflowSlackDestination(artifact, destination), account = await this.account();
    if (account !== binding.accountId) throw new Error("Slack credential account differs from the pinned destination");
    let principal: string | undefined;
    let kind: WorkflowSlackChannelKind = "direct-message";
    if (binding.kind === "direct-message") {
      principal = await this.human(account, binding.userId!, roster);
      const member = findByCanonicalPrincipal(roster, principal)!;
      const mapped = artifact.workflowBindings?.directRecipients.filter((entry) => entry.destinationBinding === destination) ?? [];
      if (!mapped.length || mapped.some((entry) => entry.memberId !== member.id)) throw new Error("Slack destination does not match its exact Workspace member mapping");
    } else {
      const response = await this.#api.call("conversations.info", { channel: binding.channelId! }), channel = response.channel;
      if (response.ok !== true || channel?.id !== binding.channelId || channel.is_archived !== false || channel.is_im !== false || channel.is_mpim === true) throw new Error("Slack channel binding is unavailable or has the wrong kind");
      principal = await this.channelRecipient(artifact, destination, account, roster);
      if (principal && this.#api.qualifyReplies && typeof channel.is_private !== "boolean") throw new Error("Slack channel visibility could not be verified");
      kind = channel.is_private ? "private-channel" : "public-channel";
    }
    if (principal) await this.#api.qualifyReplies?.(kind, principal);
    return { provider: "slack", artifact_hash: artifact.artifactHash, destination_binding: destination, binding_digest: sha256(binding), account_id: account,
      ...(principal ? { principal } : { channel_id: binding.channelId! }), verified_at: new Date().toISOString() };
  }
  async conversation(artifact: CompanyOSArtifact, destination: string, output: JsonValue, roster: RosterMember[]): Promise<WorkflowConversation> {
    const binding = workflowSlackDestination(artifact, destination);
    const receipt = output as Record<string, JsonValue>, match = typeof receipt?.thread_reference === "string" && /^slack:([A-Z0-9]{5,32}):(\d+\.\d+)$/.exec(receipt.thread_reference);
    if (!match || receipt.destination_binding !== destination || binding.accountId !== await this.account()) throw new Error("Workflow Slack receipt has no exact qualified account/channel/thread identity");
    const channelId = match[1]!;
    if (binding.kind === "channel") {
      if (channelId !== binding.channelId) throw new Error("Workflow root receipt belongs to another channel");
      const principal = await this.channelRecipient(artifact, destination, binding.accountId, roster);
      if (principal) return { surface: "slack", accountId: binding.accountId, channelId, threadId: match[2]!, subjectPrincipal: principal };
      return { surface: "slack", accountId: binding.accountId, channelId, threadId: match[2]! };
    }
    const response = await this.#api.call("conversations.info", { channel: channelId });
    if (response.ok !== true || response.channel?.id !== channelId || response.channel.is_im !== true || response.channel.user !== binding.userId) throw new Error("Workflow direct root does not belong to its exact recipient");
    const principal = await this.human(binding.accountId, binding.userId!, roster);
    return { surface: "slack", accountId: binding.accountId, channelId, threadId: match[2]!, subjectPrincipal: principal };
  }
}
