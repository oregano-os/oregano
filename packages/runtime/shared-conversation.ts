import { ConversationParticipation, type ConversationMessage, type ConversationContextEntry, type Participation } from "./conversation-participation.ts";
import { sha256 } from "./canonical.ts";

/** Adapters supply verified identity and addresses. Model output never supplies a scope. */
export interface ConversationScope {
  instanceId: string; principal: string; surface: string; accountId: string; channelId: string;
}
export interface ConversationAddress { surface: string; accountId: string; channelId: string; threadId: string }
export interface ConversationInput {
  eventId: string; messageId: string; text: string; address: ConversationAddress; message?: ConversationMessage;
}
export interface WorkContext {
  id: string; kind: "workflow" | "builder" | "draft"; agentId: string; title: string;
  status: string; version: string; address: ConversationAddress; summary: string;
  terminal: boolean; context?: unknown;
}
export interface WorkSearch { query?: string; includeClosed?: boolean; after?: string; limit: number }
export interface ConversationWorkSource {
  search(scope: ConversationScope, input: WorkSearch): Promise<{ items: WorkContext[]; next?: string }>;
  read(scope: ConversationScope, id: string): Promise<WorkContext | undefined>;
  current(scope: ConversationScope, address: ConversationAddress): Promise<WorkContext | undefined>;
  /** Optional bounded transcript from an adapter-verified conversation address. */
  history?(scope: ConversationScope, address: ConversationAddress, agentId: string): Promise<{ role: "user" | "assistant"; content: string }[]>;
}
export interface ConversationDraft extends WorkContext { kind: "draft"; purpose: string; expiresAt: string; linkedWorkId?: string }
export interface PendingConcern {
  source: ConversationInput; candidates: string[]; question: string; expiresAt: string;
}
export interface ConversationAttention {
  revision: number; importedSources?: string[]; focus: string[]; drafts: ConversationDraft[]; pending: PendingConcern[];
  recent: ConversationContextEntry[];
}
export interface ConcernRoute {
  /** Omit for one concern: Core forwards the original message. Required only for split excerpts. */
  text?: string; workId?: string; draftId?: string; agentId?: string; purpose?: string; title?: string;
  newDiscussion?: boolean; closeDraft?: boolean;
}
export interface ConversationPlan {
  participation?: Participation;
  reply: string; routes: ConcernRoute[]; clarify?: { question: string; candidates: string[] };
  usePendingMessageId?: string;
}
export interface CheckedConcern {
  text: string; source: ConversationInput; work?: WorkContext; agentId: string;
  delegation?: { ruleId: string; expiresAt: string }; needsAcknowledgement: boolean;
}
export interface ConversationReceipt {
  digest: string; plan: ConversationPlan; concerns: CheckedConcern[]; recordedAt: string;
}
export interface ConversationAttentionStore {
  read(scope: ConversationScope): Promise<ConversationAttention | undefined>;
  receipt(scope: ConversationScope, eventId: string): Promise<ConversationReceipt | undefined>;
  /** Atomic compare-and-swap plus immutable event receipt. False means another turn won. */
  commit(scope: ConversationScope, revision: number, next: ConversationAttention, eventId: string, receipt: ConversationReceipt): Promise<boolean>;
}
export const EMPTY_ATTENTION = (): ConversationAttention => ({ revision: 0, focus: [], drafts: [], pending: [], recent: [] });
export const conversationScopeKey = (scope: ConversationScope) => `conversation-attention:${sha256(scope)}`;
export const conversationReceiptKey = (scope: ConversationScope, eventId: string) => `conversation-route:${sha256({ scope, eventId })}`;
// Adding transport participation facts must not invalidate receipts from before adoption.
const inputDigest = (input: ConversationInput) => { const { message: _facts, ...original } = input; return sha256(original); };
const sameAddress = (a: ConversationAddress, b: ConversationAddress) => a.surface === b.surface && a.accountId === b.accountId && a.channelId === b.channelId && a.threadId === b.threadId;
const compactWork = (work: WorkContext) => ({ id: work.id, kind: work.kind, agentId: work.agentId, title: work.title.slice(0, 250),
  status: work.status, version: work.version, address: work.address, summary: work.summary.slice(0, 1500), terminal: work.terminal });

/** One small working context; the source stores retain execution status and authority. */
export class SharedConversationTurn {
  readonly scope: ConversationScope;
  readonly input: ConversationInput;
  readonly attention: ConversationAttention;
  readonly participation?: ConversationParticipation;
  readonly #args: {
    scope: ConversationScope; input: ConversationInput; store: ConversationAttentionStore; source: ConversationWorkSource;
    coordinatorId: string; now: string;
    authorize: (agentId: string, purpose: string) => Promise<{ ruleId: string; expiresAt: string }>;
  };
  readonly #seen = new Map<string, WorkContext>();
  #reads = 0;
  readonly #pendingRead = new Set<string>();
  private constructor(args: {
    scope: ConversationScope; input: ConversationInput; store: ConversationAttentionStore; source: ConversationWorkSource;
    coordinatorId: string; now: string;
    authorize: (agentId: string, purpose: string) => Promise<{ ruleId: string; expiresAt: string }>;
  }, attention: ConversationAttention) {
    this.#args = args; this.scope = args.scope; this.input = args.input; this.attention = attention;
    if (args.input.message) this.participation = new ConversationParticipation(args.input.message);
  }
  static async open(args: {
    verifiedPending?: PendingConcern;
    scope: ConversationScope; input: ConversationInput; store: ConversationAttentionStore; source: ConversationWorkSource;
    coordinatorId: string; now: string;
    authorize: (agentId: string, purpose: string) => Promise<{ ruleId: string; expiresAt: string }>;
  }): Promise<SharedConversationTurn> {
    if (!args.input.text.trim() || args.input.text.length > 16000 || !args.input.eventId || !Number.isFinite(Date.parse(args.now))) throw new Error("Invalid conversation input");
    const a = args.input.address, s = args.scope;
    if (args.input.message && (args.input.message.id !== args.input.messageId || args.input.message.senderId !== s.principal
      || args.input.message.text !== args.input.text)) throw new Error("Participation identity does not match the verified conversation input");
    if (a.surface !== s.surface || a.accountId !== s.accountId || a.channelId !== s.channelId) throw new Error("Conversation input crosses authenticated scope");
    const attention = await args.store.read(s) ?? EMPTY_ATTENTION();
    attention.pending = attention.pending.filter(p => p.expiresAt > args.now);
    const seed = args.verifiedPending;
    if (seed && seed.expiresAt > args.now && seed.source.text.length <= 16000
      && !(attention.importedSources ?? []).includes(seed.source.eventId) && attention.pending.length < 4) {
      attention.pending.push(structuredClone(seed));
      attention.importedSources = [...(attention.importedSources ?? []), seed.source.eventId].slice(-16);
    }
    attention.drafts = attention.drafts.slice(-8).map(d => d.expiresAt <= args.now && !d.linkedWorkId
      ? { ...d, status: "dormant", terminal: true } : d);
    return new SharedConversationTurn(args, attention);
  }
  async replay(): Promise<ConversationReceipt | undefined> {
    const receipt = await this.#args.store.receipt(this.scope, this.input.eventId);
    if (receipt && receipt.digest !== inputDigest(this.input)) throw new Error("Conversation event was reused with different content");
    return receipt;
  }
  async initialContext() {
    const localDrafts = this.attention.drafts.filter(d => sameAddress(d.address, this.input.address));
    const current = await this.#args.source.current(this.scope, this.input.address)
      ?? (localDrafts.length === 1 ? await this.#read(localDrafts[0]!.id) : undefined);
    if (current) this.#seen.set(current.id, structuredClone(current));
    const pending = this.attention.pending.filter(p => p.source.address.threadId === this.input.address.threadId);
    for (const id of [...new Set([...localDrafts.map(d => d.id), ...pending.flatMap(p => p.candidates), ...this.attention.focus])].slice(0, 6)) {
      const work = await this.#read(id); if (work) { this.#seen.set(id, structuredClone(work)); this.#seen.set(work.id, structuredClone(work)); }
    }
    return { current: current && compactWork(current), focus: [...this.#seen.values()].map(compactWork),
      pending: pending.map(p => ({ messageId: p.source.messageId, text: p.source.text.slice(0, 4000), truncated: p.source.text.length > 4000, question: p.question, candidates: p.candidates })),
      conversation: boundedConversationHistory(await this.#args.source.history?.(this.scope, this.input.address, current?.agentId ?? this.#args.coordinatorId) ?? [], 12000),
      recent: this.attention.recent.slice(-8), limits: { searchPage: 6, reads: 8, concerns: 3 } };
  }
  async search(input: WorkSearch) {
    if (++this.#reads > 8) throw new Error("Conversation context read budget reached");
    if (input.query && input.query.length > 200) throw new Error("Search query exceeds limit");
    const page = await this.#args.source.search(this.scope, { ...input, limit: 6 });
    const drafts = input.after ? [] : this.attention.drafts.filter(d => !d.linkedWorkId && (input.includeClosed || !d.terminal)
      && (!input.query || `${d.title} ${d.summary}`.toLowerCase().includes(input.query.toLowerCase()))).slice(0, 4);
    const items = [...drafts, ...page.items.slice(0, 6)];
    for (const work of items) this.#seen.set(work.id, structuredClone(work));
    return { items: items.map(compactWork), next: page.next };
  }
  async read(id: string) {
    if (++this.#reads > 8) throw new Error("Conversation context read budget reached");
    const work = await this.#read(id);
    if (!work) return { unavailable: true };
    this.#seen.set(id, structuredClone(work)); this.#seen.set(work.id, structuredClone(work));
    const conversation = boundedConversationHistory(await this.#args.source.history?.(this.scope, work.address, work.agentId) ?? [], 6000);
    const serialized = JSON.stringify({ conversation, details: work.context ?? work.summary });
    return { ...compactWork(work), context: serialized.slice(0, 10000), truncated: serialized.length > 10000 };
  }
  async readPending(messageId: string) {
    if (++this.#reads > 8) throw new Error("Conversation context read budget reached");
    const pending = this.attention.pending.find(p => p.source.messageId === messageId && p.source.address.threadId === this.input.address.threadId);
    if (!pending) throw new Error("Pending answer is unavailable in this conversation");
    this.#pendingRead.add(messageId);
    return { messageId, text: pending.source.text, candidates: pending.candidates };
  }
  async #read(id: string) {
    const draft = this.attention.drafts.find(d => d.id === id);
    if (draft?.linkedWorkId) return this.#args.source.read(this.scope, draft.linkedWorkId);
    return draft ?? await this.#args.source.read(this.scope, id);
  }
  async commit(plan: ConversationPlan): Promise<ConversationReceipt> {
    const replay = await this.replay(); if (replay) return replay;
    if (!Array.isArray(plan.routes) || plan.routes.length > 3 || typeof plan.reply !== "string" || plan.reply.length > 4000) throw new Error("Invalid conversation plan");
    if (plan.clarify && plan.routes.length) throw new Error("Clarification cannot dispatch work");
    if (plan.participation !== "context-only" && !plan.clarify && !plan.routes.length && !plan.reply.trim()) throw new Error("A conversation plan must answer, clarify or route");
    if (plan.participation !== undefined && !["respond", "context-only"].includes(plan.participation)) throw new Error("Invalid participation choice");
    if (this.participation?.ambient && !plan.participation) throw new Error("Choose participation for a shared message before routing work");
    if (plan.participation === "context-only" && (plan.reply || plan.routes.length || plan.clarify || plan.usePendingMessageId)) throw new Error("A context-only plan cannot reply, clarify or route work");
    if (plan.participation) this.participation?.choose(plan.participation);
    const workIds = plan.routes.flatMap(r => r.workId ? [r.workId] : []);
    if (new Set(workIds).size !== workIds.length) throw new Error("Combine excerpts for the same work into one concern");
    const pending = plan.usePendingMessageId ? this.attention.pending.find(p => p.source.messageId === plan.usePendingMessageId
      && p.source.address.threadId === this.input.address.threadId) : undefined;
    if (plan.usePendingMessageId && !pending) throw new Error("Pending source is unavailable in this conversation");
    if (pending && pending.source.text.length > 4000 && !this.#pendingRead.has(pending.source.messageId)) throw new Error("Read the complete pending answer before routing a truncated preview");
    const source = pending?.source ?? this.input;
    const next = structuredClone(this.attention);
    const concerns: CheckedConcern[] = [];
    for (const [index, route] of plan.routes.entries()) {
      if (plan.routes.length > 1 && route.text === undefined) throw new Error("Split concerns require exact source excerpts");
      // Single-target routing never trusts a model-authored copy, even if a
      // model using the older schema still supplies one.
      const text = plan.routes.length === 1 ? source.text : route.text!;
      if (!text.trim() || (plan.routes.length > 1 && !source.text.includes(text))) throw new Error("A routed answer must be an exact excerpt of the verified source");
      if (route.workId && (route.newDiscussion || route.agentId)) throw new Error("Existing work cannot change owner through routing");
      let work: WorkContext | undefined, delegation: CheckedConcern["delegation"];
      if (route.workId) {
        const observed = this.#seen.get(route.workId);
        work = await this.#read(route.workId);
        if (!observed || !work || work.version !== observed.version) throw new Error("Selected work is stale or was not read in this turn");
        if (pending && !pending.candidates.includes(route.workId)) throw new Error("Selected work is outside the pending clarification");
      }
      if (route.draftId) {
        const draft = next.drafts.find(d => d.id === route.draftId);
        if (!work || work.kind === "draft" || !draft || draft.agentId !== work.agentId || draft.linkedWorkId && draft.linkedWorkId !== work.id)
          throw new Error("Only a matching accessible discussion can link to existing work");
        draft.linkedWorkId = work.id; draft.status = "linked"; draft.version = String(Number(draft.version) + 1);
      }
      const agentId = work?.agentId ?? route.agentId ?? this.#args.coordinatorId;
      if ((!work || work.kind === "draft") && agentId !== this.#args.coordinatorId) {
        delegation = await this.#args.authorize(agentId, route.purpose ?? (work as ConversationDraft | undefined)?.purpose ?? "");
      }
      if (!work && route.newDiscussion) {
        if (!route.title?.trim() || route.title.length > 250) throw new Error("A discussion requires a bounded title");
        if (next.drafts.filter(d => !d.terminal && !d.linkedWorkId).length >= 8) throw new Error("Close or resume an existing draft before opening another discussion");
        const id = `draft:${sha256({ scope: this.scope, eventId: source.eventId, index }).slice(0, 32)}`;
        work = { id, kind: "draft", agentId, title: route.title, status: "open", version: "1", address: source.address,
          summary: text.slice(0, 1500), terminal: false, purpose: route.purpose ?? "", expiresAt: new Date(Date.parse(this.#args.now) + 7 * 86400000).toISOString() } as ConversationDraft;
        const activeDrafts = next.drafts.filter(d => !d.terminal && !d.linkedWorkId);
        const oldDrafts = next.drafts.filter(d => d.terminal || d.linkedWorkId);
        const oldSlots = Math.max(0, 7 - activeDrafts.length);
        next.drafts = [...(oldSlots ? oldDrafts.slice(-oldSlots) : []), ...activeDrafts, work as ConversationDraft];
      }
      if (route.closeDraft) {
        const draft = next.drafts.find(d => d.id === work?.id);
        if (!draft) throw new Error("Only conversational drafts can be closed by this control");
        draft.terminal = true; draft.status = "closed"; draft.version = String(Number(draft.version) + 1); work = draft;
      } else if (work?.kind === "draft" && !work.terminal) {
        const draft = next.drafts.find(d => d.id === work!.id)!;
        draft.expiresAt = new Date(Date.parse(this.#args.now) + 7 * 86400000).toISOString();
      }
      concerns.push({ text, source, work: work && { ...work, context: undefined }, agentId, delegation, needsAcknowledgement: !!work && (!!pending || !sameAddress(work.address, this.input.address)) });
    }
    if (plan.clarify) {
      const { candidates, question } = plan.clarify;
      if (!question.trim() || question.length > 2000 || candidates.length < 2 || candidates.length > 6
        || new Set(candidates).size !== candidates.length || candidates.some(id => !this.#seen.has(id))) throw new Error("Invalid clarification candidates");
      next.pending = next.pending.filter(p => p.source.messageId !== source.messageId);
      if (next.pending.length >= 4) throw new Error("Resolve an outstanding clarification before opening another");
      next.pending.push({ source, candidates, question, expiresAt: new Date(Date.parse(this.#args.now) + 86400000).toISOString() });
    } else if (pending) next.pending = next.pending.filter(p => p.source.messageId !== pending.source.messageId);
    next.focus = [...new Set(concerns.filter(c => c.work && !c.work.terminal).map(c => c.work!.id))].slice(0, 3);
    if (!concerns.length) next.focus = this.attention.focus;
    next.recent = [...next.recent, { role: "user" as const, content: this.input.text.slice(0, 2000),
      principal: this.scope.principal, sender_name: this.input.message?.senderName, sent_at: this.input.message?.sentAt ?? this.#args.now, message_id: this.input.messageId },
      ...(plan.participation === "context-only" ? [] : [{ role: "assistant" as const, content: (plan.clarify?.question ?? plan.reply).slice(0, 2000),
        sent_at: this.#args.now, in_reply_to: this.input.messageId }])].slice(-8);
    next.revision++;
    const receipt: ConversationReceipt = { digest: inputDigest(this.input), plan, concerns, recordedAt: this.#args.now };
    if (!await this.#args.store.commit(this.scope, this.attention.revision, next, this.input.eventId, receipt)) {
      const duplicate = await this.replay(); if (duplicate) return duplicate;
      throw new Error("Conversation changed while interpreting this message; retry with fresh context");
    }
    return receipt;
  }
}

/** Link a confirmed existing job to a discussion. Never create a second execution status. */
export async function linkConversationDraft(args: { scope: ConversationScope; store: ConversationAttentionStore; source: ConversationWorkSource;
  workId: string; address: ConversationAddress; eventId: string; now: string }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const attention = await args.store.read(args.scope);
    if (!attention) return;
    const work = await args.source.read(args.scope, args.workId);
    if (!work) throw new Error("Linked work is not available to this recipient");
    const draft = attention.drafts.find(d => !d.terminal && d.agentId === work.agentId && sameAddress(d.address, args.address));
    if (!draft || draft.linkedWorkId === work.id) return;
    if (draft.linkedWorkId) throw new Error("Discussion already refers to another execution");
    const next = structuredClone(attention), linked = next.drafts.find(d => d.id === draft.id)!;
    linked.linkedWorkId = work.id; linked.status = "linked"; linked.version = String(Number(linked.version) + 1); next.revision++;
    next.focus = next.focus.map(id => id === draft.id ? work.id : id);
    const receipt: ConversationReceipt = { digest: sha256({ draftId: draft.id, workId: work.id }), concerns: [], plan: { reply: "", routes: [] }, recordedAt: args.now };
    if (await args.store.commit(args.scope, attention.revision, next, args.eventId, receipt)) return;
  }
  throw new Error("Discussion changed while linking confirmed work");
}

/** Keep the selected conversation within a character budget without summarizing unrelated history. */
export function boundedConversationHistory<T extends { content: string }>(history: readonly T[], limit = 32000): T[] {
  let remaining = limit;
  const result: T[] = [];
  for (const entry of [...history].reverse()) {
    if (remaining <= 0 || result.length >= 12) break;
    const marker = "[Earlier text omitted]\n";
    const content = entry.content.length > remaining
      ? remaining > marker.length ? marker + entry.content.slice(-(remaining - marker.length)) : entry.content.slice(-remaining)
      : entry.content;
    result.unshift({ ...entry, content }); remaining -= content.length;
  }
  return result;
}
