import { sha256 } from "./canonical.ts";

/** Adapter-neutral, finite routing state. Callers supply independently verified
 * identities and revalidate the selected target; this service grants no authority. */
export interface ConversationChoiceStore {
  get<T>(key: string): Promise<T | null>;
  setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean>;
}
export interface ConversationChoiceScope {
  instanceId: string; surface: string; accountId: string; channelId: string; threadId: string; principal: string;
}
export interface ConversationChoiceRequest<T> {
  source: { messageId: string; digest: string };
  choices: T[];
  expiresAt: string;
}
const DAY = 86_400_000;
const key = (scope: ConversationChoiceScope) => `conversation-choice:v1:${sha256(scope)}`;

/** Deliberately bounded selection grammar; arbitrary prose is never classified as consent. */
export function conversationChoiceNumber(text: string): number | undefined {
  const normalized = text.trim().replace(/[.!]$/, "").trim();
  const match = /^(?:(?:it belongs to|this belongs to|my answer belongs to|das gehört zu|es gehört zu)\s+)?(?:(?:question|frage|number|nummer)\s*)?#?(\d{1,2})$/i.exec(normalized);
  return match ? Number(match[1]) : undefined;
}

export class ConversationChoiceService<T> {
  readonly store: ConversationChoiceStore;
  readonly clock: () => string;
  constructor(store: ConversationChoiceStore, clock: () => string = () => new Date().toISOString()) { this.store = store; this.clock = clock; }
  async remember(scope: ConversationChoiceScope, source: ConversationChoiceRequest<T>["source"], choices: readonly T[]): Promise<ConversationChoiceRequest<T>> {
    if (choices.length < 2 || choices.length > 20 || !source.messageId || !source.digest) throw new Error("Invalid conversation choice snapshot");
    const request = { source, choices: structuredClone([...choices]), expiresAt: new Date(Date.parse(this.clock()) + DAY).toISOString() };
    await this.store.setIfNotExists(key(scope), request, 30 * DAY);
    const saved = await this.store.get<ConversationChoiceRequest<T>>(key(scope));
    if (!saved || saved.source.messageId !== source.messageId || saved.source.digest !== source.digest) throw new Error("Conversation choice source changed");
    return saved;
  }
  async presented(scope: ConversationChoiceScope, messageId: string): Promise<void> {
    if (!messageId) throw new Error("Conversation choice has no publication receipt");
    await this.store.setIfNotExists(`${key(scope)}:presented`, { messageId }, 30 * DAY);
  }
  async read(scope: ConversationChoiceScope): Promise<ConversationChoiceRequest<T> | undefined> {
    if (!await this.store.get(`${key(scope)}:presented`)) return undefined;
    return await this.store.get<ConversationChoiceRequest<T>>(key(scope)) ?? undefined;
  }
  async unselected(scope: ConversationChoiceScope): Promise<ConversationChoiceRequest<T> | undefined> {
    const request = await this.read(scope);
    return request && request.expiresAt > this.clock() && !await this.store.get(`${key(scope)}:selection`) ? request : undefined;
  }
  async select(scope: ConversationChoiceScope, verified: { text: string; eventId: string }, validate: (target: T, request: ConversationChoiceRequest<T>) => Promise<boolean>): Promise<
    { kind: "unassigned" } | { kind: "invalid" } | { kind: "expired" } | { kind: "selected" | "already-selected"; target: T; request: ConversationChoiceRequest<T> }
  > {
    const request = await this.read(scope);
    if (!request) return { kind: "unassigned" };
    if (request.expiresAt <= this.clock()) return { kind: "expired" };
    const number = conversationChoiceNumber(verified.text);
    const target = number === undefined ? undefined : request.choices[number - 1];
    if (target === undefined) return { kind: "invalid" };
    if (!await validate(target, request)) return { kind: "expired" };
    const selectedKey = `${key(scope)}:selection`, selection = { index: number! - 1, eventId: verified.eventId };
    await this.store.setIfNotExists(selectedKey, selection, 30 * DAY);
    const saved = await this.store.get<typeof selection>(selectedKey);
    if (!saved || !request.choices[saved.index]) throw new Error("Invalid conversation choice selection");
    return { kind: saved.index === selection.index && saved.eventId === selection.eventId ? "selected" : "already-selected", target: request.choices[saved.index]!, request };
  }
}

interface ChoiceConversation {
  id: string;
  subscribe(): Promise<unknown>;
  post(content: string): Promise<{ id: string }>;
}

/** Use the verified source conversation, not an adapter's unthreaded DM alias. */
export async function publishConversationChoice(args: {
  conversationId: string; inbound: ChoiceConversation; resolve: (id: string) => ChoiceConversation;
  content: string; recordPublication: (messageId: string) => Promise<void>;
}): Promise<void> {
  const conversation = args.inbound.id === args.conversationId ? args.inbound : args.resolve(args.conversationId);
  if (conversation.id !== args.conversationId) throw new Error("Choice presentation resolved another conversation");
  await conversation.subscribe();
  const notice = await conversation.post(args.content);
  await args.recordPublication(notice.id);
}
