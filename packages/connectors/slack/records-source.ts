import { createHash } from "node:crypto";
import type { JsonValue } from "../../capabilities/contracts.ts";
import type { CompanyRecordSourceDeclaration } from "../../records/contracts.ts";
import type { CompanyRecordSourceBinding, RecordSourceConnector, RecordSourceInventory } from "../../records/source-connector.ts";
import { SlackWebApiClient, type SlackFetch } from "./client.ts";

export const SLACK_RECORD_SOURCE_CONNECTOR_ID = "oregano/slack-record-source";
export const SLACK_RECORD_SOURCE_CONNECTOR_VERSION = "0.1.1";

type SlackConversationKind = "public-channel" | "private-channel";

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value: JsonValue | undefined, label: string): Record<string, JsonValue> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
};
const string = (value: JsonValue | undefined, label: string): string => {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value.trim();
};
const integer = (value: JsonValue | undefined, label: string, fallback: number, minimum: number, maximum: number): number => {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
};
const boolean = (value: JsonValue | undefined, label: string, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
};
const exactIso = (value: JsonValue | undefined, label: string): string => {
  const result = string(value, label);
  if (Number.isNaN(Date.parse(result)) || new Date(result).toISOString() !== result) throw new Error(`${label} must be an exact ISO timestamp`);
  return result;
};
const slackTimestamp = (iso: string): string => `${Date.parse(iso) / 1000}`;
const timestampIso = (value: string): string => {
  const match = /^(\d{1,16})(?:\.(\d{1,9}))?$/.exec(value);
  if (!match) throw new Error(`Slack message timestamp '${value}' is invalid`);
  const seconds = Number(match[1]);
  if (!Number.isSafeInteger(seconds) || seconds > 253_402_300_799) throw new Error(`Slack message timestamp '${value}' is invalid`);
  // Date stores only milliseconds. Format the whole seconds separately so no
  // provider fractional digit is lost before deadline or ordering decisions.
  return new Date(seconds * 1_000).toISOString().slice(0, -5) + `.${(match[2] ?? "").padEnd(3, "0")}Z`;
};
const timestampNanos = (value: string): bigint => {
  timestampIso(value);
  const [seconds, fraction = ""] = value.split(".");
  return BigInt(seconds!) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
};
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

const configuration = (
  source: CompanyRecordSourceDeclaration,
  binding: CompanyRecordSourceBinding,
  qualification: Record<string, unknown>,
) => {
  if (source.record_type !== "communication-message") throw new Error("Slack Record Source requires record_type 'communication-message'");
  if (binding.source_id !== source.id) throw new Error(`Record binding source '${binding.source_id}' does not match declaration '${source.id}'`);
  if (binding.resource_binding !== source.resource_binding) throw new Error(`Record binding resource '${binding.resource_binding}' does not match declaration '${source.resource_binding}'`);
  const value = object(binding.configuration, "Slack record-source configuration");
  const teamId = string(value.team_id, "Slack team_id");
  const channelId = string(value.channel_id, "Slack channel_id");
  if (!/^[A-Z][A-Z0-9]{4,31}$/.test(teamId)) throw new Error(`Slack team id '${teamId}' is invalid`);
  if (!/^[CG][A-Z0-9]{4,31}$/.test(channelId)) throw new Error(`Slack channel id '${channelId}' is invalid`);
  const conversationKind = string(value.conversation_kind, "Slack conversation_kind") as SlackConversationKind;
  if (!(["public-channel", "private-channel"] as const).includes(conversationKind)) throw new Error("Slack conversation_kind must be public-channel or private-channel");
  const oldestAt = exactIso(value.oldest_at, "Slack oldest_at");
  const latestAt = value.latest_at === undefined ? undefined : exactIso(value.latest_at, "Slack latest_at");
  if (latestAt && latestAt < oldestAt) throw new Error("Slack latest_at must not precede oldest_at");
  const includeThreads = boolean(value.include_threads, "Slack include_threads", true);
  const pageSize = integer(value.page_size, "Slack page_size", 100, 1, 200);
  const maxPages = integer(value.max_pages, "Slack max_pages", 100, 1, 1_000);
  const maxThreadPages = integer(value.max_thread_pages, "Slack max_thread_pages", 20, 1, 1_000);
  const maxMessages = integer(value.max_messages, "Slack max_messages", 50_000, 1, 1_000_000);
  const qualified = qualification as any;
  if (qualified?.kind !== "slack-record-source-qualification" || qualified?.phase !== "complete") {
    throw new Error("Slack Record Source binding requires one complete Slack qualification receipt");
  }
  const discovery = qualified?.evidence?.discovery;
  if (!discovery || discovery.discovery_hash !== binding.qualification.digest) throw new Error("Slack qualification digest does not match the Instance binding");
  if (discovery.authentication_mode !== "bot-token" || discovery.credentials_retained !== false) {
    throw new Error("Slack qualification does not prove bot-token authentication without retained credentials");
  }
  if (discovery.team_id !== teamId) throw new Error(`Slack qualification does not identify team '${teamId}'`);
  if (discovery.channel?.id !== channelId || discovery.channel?.kind !== conversationKind || discovery.channel?.is_member !== true) {
    throw new Error(`Slack qualification does not prove membership in exact ${conversationKind} '${channelId}'`);
  }
  const requiredScopes = conversationKind === "private-channel"
    ? ["groups:history", "groups:read"]
    : ["channels:history", "channels:read"];
  const scopes = new Set(Array.isArray(discovery.scopes) ? discovery.scopes.map(String) : []);
  const missingScope = requiredScopes.find((scope) => !scopes.has(scope));
  if (missingScope) throw new Error(`Slack qualification lacks required scope '${missingScope}'`);
  return { teamId, channelId, conversationKind, oldestAt, latestAt, includeThreads, pageSize, maxPages, maxThreadPages, maxMessages };
};

const normalizeMessage = (args: {
  sourceId: string;
  teamId: string;
  channelId: string;
  message: Record<string, unknown>;
  rootTs?: string;
}): Record<string, JsonValue> => {
  const ts = String(args.message.ts ?? args.message.deleted_ts ?? "");
  if (!ts) throw new Error("Slack message has no stable timestamp identity");
  const threadTs = String(args.message.thread_ts ?? args.rootTs ?? ts);
  const userId = typeof args.message.user === "string" ? args.message.user : undefined;
  const botId = typeof args.message.bot_id === "string" ? args.message.bot_id : undefined;
  if (userId !== undefined && !/^[UW][A-Z0-9]{4,31}$/.test(userId)) throw new Error("Slack message has an invalid user identity");
  if (botId !== undefined && !/^B[A-Z0-9]{4,31}$/.test(botId)) throw new Error("Slack message has an invalid bot identity");
  const subtype = typeof args.message.subtype === "string" ? args.message.subtype : "message";
  const isBot = botId !== undefined || subtype === "bot_message" || typeof args.message.app_id === "string";
  const authorKind = isBot ? "bot" : userId ? "user" : "unknown";
  const authorId = (isBot ? botId ?? userId : userId) ?? "unknown";
  const authorPrincipal = authorKind === "user"
    ? `slack:${args.teamId}:${authorId}`
    : `slack-${authorKind}:${args.teamId}:${authorId}`;
  const edit = args.message.edited === undefined ? undefined : object(json(args.message.edited), "Slack edited metadata");
  const edited = edit ? string(edit.ts, "Slack edited timestamp") : undefined;
  if (edited && timestampNanos(edited) < timestampNanos(ts)) throw new Error("Slack edit timestamp precedes message creation");
  const editorPrincipal = edit && typeof edit.user === "string" && /^[UW][A-Z0-9]{4,31}$/.test(edit.user)
    ? `slack:${args.teamId}:${edit.user}` : null;
  return {
    id: `${args.channelId}:${ts}`,
    source_id: args.sourceId,
    provider: "slack",
    message_id: ts,
    team_id: args.teamId,
    conversation_id: args.channelId,
    thread_id: threadTs,
    is_thread_root: threadTs === ts,
    author_id: authorId,
    author_kind: authorKind,
    author_principal: authorPrincipal,
    editor_principal: editorPrincipal,
    content_author_principal: edited && !isBot ? editorPrincipal ?? `slack-unknown:${args.teamId}:editor` : authorPrincipal,
    text: typeof args.message.text === "string" ? args.message.text : "",
    occurred_at: timestampIso(ts),
    accepted_at: timestampIso(edited ?? ts),
    subtype,
    is_deleted: subtype === "message_deleted" || Boolean(args.message.deleted_ts),
    reply_count: typeof args.message.reply_count === "number" ? args.message.reply_count : 0,
    ...(edited ? { edited_at: timestampIso(edited) } : {}),
    provider_payload: json(args.message),
  };
};

/** Read-only Slack implementation of the provider-neutral Record Source boundary. */
export class SlackRecordSourceConnector implements RecordSourceConnector {
  readonly id = SLACK_RECORD_SOURCE_CONNECTOR_ID;
  readonly version = SLACK_RECORD_SOURCE_CONNECTOR_VERSION;
  readonly resolveSecret: (secretRef: string) => string | Promise<string>;
  readonly fetcher?: SlackFetch;
  readonly now: () => Date;

  constructor(args: { resolveSecret: (secretRef: string) => string | Promise<string>; fetcher?: SlackFetch; now?: () => Date }) {
    this.resolveSecret = args.resolveSecret;
    this.fetcher = args.fetcher;
    this.now = args.now ?? (() => new Date());
  }

  validateBinding(args: { source: CompanyRecordSourceDeclaration; binding: CompanyRecordSourceBinding; qualification: Record<string, unknown> }): void {
    configuration(args.source, args.binding, args.qualification);
  }

  async readCompleteInventory(args: {
    source: CompanyRecordSourceDeclaration;
    binding: CompanyRecordSourceBinding;
    qualification: Record<string, unknown>;
  }): Promise<RecordSourceInventory> {
    const config = configuration(args.source, args.binding, args.qualification);
    const token = await this.resolveSecret(args.binding.secret_ref);
    if (!token) throw new Error(`Record Source Connector secret '${args.binding.secret_ref}' is unavailable`);
    const client = new SlackWebApiClient({ token, ...(this.fetcher ? { fetcher: this.fetcher } : {}) });
    const requestIds: string[] = [];
    const scopes = new Set<string>();
    let historyPages = 0;
    let threadPages = 0;
    const messages = new Map<string, Record<string, JsonValue>>();
    const rememberReceipt = (receipt: { requestId?: string; scopes: string[] }) => {
      if (receipt.requestId) requestIds.push(receipt.requestId);
      for (const scope of receipt.scopes) scopes.add(scope);
    };
    const remember = (message: Record<string, unknown>, rootTs?: string) => {
      const normalized = normalizeMessage({ sourceId: args.source.id, teamId: config.teamId, channelId: config.channelId, message, ...(rootTs ? { rootTs } : {}) });
      const id = String(normalized.id);
      const existing = messages.get(id);
      if (existing && digest(existing) !== digest(normalized)) throw new Error(`Slack returned conflicting versions of message '${id}' in one inventory`);
      messages.set(id, normalized);
      if (messages.size > config.maxMessages) throw new Error(`Slack record inventory exceeded the configured ${config.maxMessages}-message bound`);
    };
    let cursor: string | undefined;
    const roots: Array<Record<string, unknown>> = [];
    do {
      if (historyPages >= config.maxPages) throw new Error(`Slack record inventory exceeded the configured ${config.maxPages}-page bound`);
      const result = await client.history({
        channel: config.channelId,
        oldest: slackTimestamp(config.oldestAt),
        ...(config.latestAt ? { latest: slackTimestamp(config.latestAt) } : {}),
        limit: config.pageSize,
        ...(cursor ? { cursor } : {}),
      });
      rememberReceipt(result);
      historyPages += 1;
      if (result.data.is_limited === true) throw new Error("Slack history is limited by provider retention and cannot support a complete inventory claim");
      for (const message of result.data.messages) {
        roots.push(message);
        remember(message);
      }
      const next = result.data.response_metadata?.next_cursor?.trim() || undefined;
      if (result.data.has_more && !next) throw new Error("Slack history reported more messages without a continuation cursor");
      cursor = next;
    } while (cursor);

    if (config.includeThreads) {
      for (const root of roots) {
        if (!(typeof root.reply_count === "number" && root.reply_count > 0)) continue;
        const rootTs = String(root.ts ?? "");
        if (!rootTs) throw new Error("Slack threaded message has no stable root timestamp");
        const expectedReplies = root.reply_count;
        const observedReplies = new Set<string>();
        let threadCursor: string | undefined;
        let pagesForThread = 0;
        do {
          if (pagesForThread >= config.maxThreadPages) throw new Error(`Slack thread '${rootTs}' exceeded the configured ${config.maxThreadPages}-page bound`);
          const result = await client.replies({
            channel: config.channelId,
            ts: rootTs,
            oldest: slackTimestamp(config.oldestAt),
            ...(config.latestAt ? { latest: slackTimestamp(config.latestAt) } : {}),
            limit: config.pageSize,
            ...(threadCursor ? { cursor: threadCursor } : {}),
          });
          rememberReceipt(result);
          pagesForThread += 1;
          threadPages += 1;
          for (const message of result.data.messages) {
            const replyTs = String(message.ts ?? "");
            // Slack includes the root as the first conversations.replies item.
            // Keep the history representation already frozen above and count
            // only true replies when checking thread completeness.
            if (replyTs === rootTs) continue;
            if (replyTs) observedReplies.add(replyTs);
            remember(message, rootTs);
          }
          const next = result.data.response_metadata?.next_cursor?.trim() || undefined;
          if (result.data.has_more && !next) throw new Error(`Slack thread '${rootTs}' reported more messages without a continuation cursor`);
          threadCursor = next;
        } while (threadCursor);
        // `reply_count` describes the complete live thread, not the selected
        // historical window. It is therefore a valid completeness check only
        // when the inventory has no upper time bound.
        if (!config.latestAt && observedReplies.size < expectedReplies) {
          throw new Error(`Slack thread '${rootTs}' returned ${observedReplies.size} of ${expectedReplies} declared replies and cannot support a complete inventory claim`);
        }
      }
    }
    const objects = [...messages.values()].sort((left, right) => String(left.message_id).localeCompare(String(right.message_id)));
    const inventoryDigest = digest(objects);
    return {
      complete: true,
      observed_at: this.now().toISOString(),
      objects,
      watermark: `slack:${inventoryDigest}`,
      receipt: {
        connector: this.id,
        connector_version: this.version,
        authentication_mode: "bot-token",
        resource_binding: args.binding.resource_binding,
        team_id: config.teamId,
        conversation_id: config.channelId,
        conversation_kind: config.conversationKind,
        oldest_at: config.oldestAt,
        ...(config.latestAt ? { latest_at: config.latestAt } : {}),
        include_threads: config.includeThreads,
        history_pages: historyPages,
        thread_pages: threadPages,
        request_ids: [...new Set(requestIds)].sort(),
        scopes: [...scopes].sort(),
        objects: objects.length,
        inventory_digest: inventoryDigest,
        complete: true,
        limited_history: false,
        credentials_retained: false,
      },
    };
  }
}
