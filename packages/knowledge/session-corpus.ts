import { canonicalJson, sha256 } from "../runtime/canonical.ts";

export const SESSION_STOP_BUFFER_MAX_BYTES = 1_048_576;
export const SESSION_STOP_BUFFER_RETENTION_DAYS = 7;
export const SESSION_CORPUS_RETENTION_DAYS = 30;

export interface SessionStopBuffer {
  bufferId: string;
  sessionId: string;
  principalId: string;
  surface: string;
  externalSessionId?: string;
  content: string;
  normalizedFormat: "text/plain" | "text/markdown" | "application/json";
  accessPolicyId: string;
  createdAt: string;
}

export interface SessionRecord {
  sessionId: string;
  principalId: string;
  surface: string;
  externalSessionId?: string;
  accessPolicyId: string;
  lifecycleStatus: "open" | "transferred" | "closed" | "deleted";
  archiveStatus: "not-requested" | "requested" | "archived" | "failed";
  startedAt: string;
  endedAt?: string;
  archiveReceiptId?: string;
}

export interface SessionCorpusRecord {
  corpusId: string;
  sessionId: string;
  content: string;
  contentDigest: string;
  normalizedFormat: SessionStopBuffer["normalizedFormat"];
  accessPolicyId: string;
  lifecycleStatus: "active" | "expired" | "deleted" | "legal-hold";
  transferredAt: string;
  expiresAt: string;
  archiveReceiptId?: string;
  deletedAt?: string;
}

export interface SessionLifecycleReceipt {
  receiptId: string;
  operation: "transfer" | "buffer-cleanup" | "corpus-cleanup" | "archive" | "recovery";
  outcome: "succeeded" | "failed" | "skipped";
  sessionId: string;
  corpusId?: string;
  bufferId?: string;
  occurredAt: string;
  evidenceDigest: string;
  reasonCode: string;
}

export interface SessionCorpusStore {
  putSession(session: SessionRecord): Promise<"inserted" | "unchanged">;
  putCorpus(corpus: SessionCorpusRecord): Promise<"inserted" | "unchanged">;
  getCorpus(corpusId: string): Promise<SessionCorpusRecord | undefined>;
  markSessionTransferred(sessionId: string, endedAt: string): Promise<void>;
  markArchived(sessionId: string, corpusId: string, receiptId: string): Promise<void>;
  expireCorpus(now: string): Promise<string[]>;
  putReceipt(receipt: SessionLifecycleReceipt): Promise<"inserted" | "unchanged">;
}

export interface SessionStopBufferStore {
  remove(bufferId: string): Promise<boolean>;
  list(): Promise<Array<Omit<SessionStopBuffer, "content">>>;
}

const iso = (value: string, label: string): string => {
  if (Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(value).toISOString();
};

const required = (value: string, label: string): string => {
  const result = value.trim();
  if (!result || result.length > 1_000 || result.includes("\0")) throw new Error(`${label} must be a bounded non-empty value.`);
  return result;
};

const receipt = (input: Omit<SessionLifecycleReceipt, "receiptId" | "evidenceDigest"> & { evidence: unknown }): SessionLifecycleReceipt => {
  const evidenceDigest = sha256(input.evidence);
  const value = {
    operation: input.operation,
    outcome: input.outcome,
    sessionId: input.sessionId,
    ...(input.corpusId ? { corpusId: input.corpusId } : {}),
    ...(input.bufferId ? { bufferId: input.bufferId } : {}),
    occurredAt: input.occurredAt,
    evidenceDigest,
    reasonCode: input.reasonCode,
  };
  return { ...value, receiptId: sha256(value) };
};

export async function transferSessionStopBuffer(input: {
  buffer: SessionStopBuffer;
  corpusStore: SessionCorpusStore;
  stopBufferStore: Pick<SessionStopBufferStore, "remove">;
  transferredAt?: string;
}): Promise<{ session: SessionRecord; corpus: SessionCorpusRecord; receipt: SessionLifecycleReceipt; write: "inserted" | "unchanged" }> {
  const transferredAt = iso(input.transferredAt ?? new Date().toISOString(), "Session transfer timestamp");
  const createdAt = iso(input.buffer.createdAt, "Session stop buffer createdAt");
  const content = input.buffer.content.replace(/\r\n?/g, "\n");
  if (!content.trim()) throw new Error("Session stop buffer content is empty.");
  if (Buffer.byteLength(content) > SESSION_STOP_BUFFER_MAX_BYTES) throw new Error("Session stop buffer exceeds the bounded transfer size.");
  const sessionId = required(input.buffer.sessionId, "Session ID");
  const bufferId = required(input.buffer.bufferId, "Session stop buffer ID");
  const contentDigest = sha256(content);
  const corpusId = sha256({ sessionId, contentDigest, normalizedFormat: input.buffer.normalizedFormat });
  const session: SessionRecord = {
    sessionId,
    principalId: required(input.buffer.principalId, "Session principal ID"),
    surface: required(input.buffer.surface, "Session surface"),
    ...(input.buffer.externalSessionId ? { externalSessionId: required(input.buffer.externalSessionId, "External session ID") } : {}),
    accessPolicyId: required(input.buffer.accessPolicyId, "Session access policy ID"),
    lifecycleStatus: "open",
    archiveStatus: "not-requested",
    startedAt: createdAt,
  };
  const corpus: SessionCorpusRecord = {
    corpusId,
    sessionId,
    content,
    contentDigest,
    normalizedFormat: input.buffer.normalizedFormat,
    accessPolicyId: session.accessPolicyId,
    lifecycleStatus: "active",
    transferredAt,
    expiresAt: new Date(Date.parse(transferredAt) + SESSION_CORPUS_RETENTION_DAYS * 86_400_000).toISOString(),
  };
  await input.corpusStore.putSession(session);
  const write = await input.corpusStore.putCorpus(corpus);
  await input.corpusStore.markSessionTransferred(sessionId, transferredAt);
  const resultReceipt = receipt({
    operation: "transfer",
    outcome: "succeeded",
    sessionId,
    corpusId,
    bufferId,
    occurredAt: transferredAt,
    reasonCode: write === "inserted" ? "session-corpus-transferred" : "session-corpus-idempotent",
    evidence: { bufferId, corpusId, contentDigest, byteSize: Buffer.byteLength(content), accessPolicyId: corpus.accessPolicyId },
  });
  await input.corpusStore.putReceipt(resultReceipt);
  const removed = await input.stopBufferStore.remove(bufferId);
  if (!removed && write === "inserted") throw new Error("Session Corpus transfer succeeded but the current stop buffer could not be removed; retry recovery.");
  return { session: { ...session, lifecycleStatus: "transferred", endedAt: transferredAt }, corpus, receipt: resultReceipt, write };
}

export async function cleanupOrphanSessionBuffers(input: {
  stopBufferStore: SessionStopBufferStore;
  corpusStore: SessionCorpusStore;
  now?: string;
}): Promise<{ removed: number; receipts: SessionLifecycleReceipt[] }> {
  const now = iso(input.now ?? new Date().toISOString(), "Session buffer cleanup timestamp");
  const threshold = Date.parse(now) - SESSION_STOP_BUFFER_RETENTION_DAYS * 86_400_000;
  const receipts: SessionLifecycleReceipt[] = [];
  for (const buffer of await input.stopBufferStore.list()) {
    if (Date.parse(iso(buffer.createdAt, "Session stop buffer createdAt")) > threshold) continue;
    if (!await input.stopBufferStore.remove(buffer.bufferId)) continue;
    const item = receipt({ operation: "buffer-cleanup", outcome: "succeeded", sessionId: buffer.sessionId, bufferId: buffer.bufferId, occurredAt: now, reasonCode: "orphan-stop-buffer-expired", evidence: { bufferId: buffer.bufferId, createdAt: buffer.createdAt, policy: "seven-days" } });
    await input.corpusStore.putReceipt(item);
    receipts.push(item);
  }
  return { removed: receipts.length, receipts };
}

export async function cleanupExpiredSessionCorpus(input: { corpusStore: SessionCorpusStore; now?: string }): Promise<{ expired: number; receipt: SessionLifecycleReceipt }> {
  const now = iso(input.now ?? new Date().toISOString(), "Session Corpus cleanup timestamp");
  const corpusIds = await input.corpusStore.expireCorpus(now);
  const resultReceipt = receipt({ operation: "corpus-cleanup", outcome: "succeeded", sessionId: "session-corpus", occurredAt: now, reasonCode: "temporary-session-corpus-expired", evidence: { corpusIds: [...corpusIds].sort(), policy: "thirty-days" } });
  await input.corpusStore.putReceipt(resultReceipt);
  return { expired: corpusIds.length, receipt: resultReceipt };
}

export class InMemorySessionCorpusStore implements SessionCorpusStore, SessionStopBufferStore {
  readonly sessions = new Map<string, SessionRecord>();
  readonly corpus = new Map<string, SessionCorpusRecord>();
  readonly receipts = new Map<string, SessionLifecycleReceipt>();
  readonly buffers = new Map<string, SessionStopBuffer>();

  stageBuffer(buffer: SessionStopBuffer): void { this.buffers.set(buffer.bufferId, structuredClone(buffer)); }

  async remove(bufferId: string): Promise<boolean> { return this.buffers.delete(bufferId); }

  async list(): Promise<Array<Omit<SessionStopBuffer, "content">>> {
    return [...this.buffers.values()].map(({ content: _content, ...metadata }) => structuredClone(metadata));
  }

  async putSession(session: SessionRecord): Promise<"inserted" | "unchanged"> {
    const existing = this.sessions.get(session.sessionId);
    if (existing) {
      const stable = ({ lifecycleStatus: _lifecycle, archiveStatus: _archive, endedAt: _ended, archiveReceiptId: _receipt, ...value }: SessionRecord) => value;
      if (canonicalJson(stable(existing)) !== canonicalJson(stable(session))) throw new Error(`Session '${session.sessionId}' already exists with different identity.`);
      return "unchanged";
    }
    this.sessions.set(session.sessionId, structuredClone(session));
    return "inserted";
  }

  async putCorpus(corpus: SessionCorpusRecord): Promise<"inserted" | "unchanged"> {
    const existing = this.corpus.get(corpus.corpusId);
    if (existing) {
      const stable = ({ lifecycleStatus: _lifecycle, deletedAt: _deleted, archiveReceiptId: _receipt, content: existingContent, ...value }: SessionCorpusRecord) => ({ ...value, content: existingContent || corpus.content });
      if (canonicalJson(stable(existing)) !== canonicalJson(stable(corpus))) throw new Error(`Session Corpus '${corpus.corpusId}' already exists with different content.`);
      return "unchanged";
    }
    this.corpus.set(corpus.corpusId, structuredClone(corpus));
    return "inserted";
  }

  async getCorpus(corpusId: string): Promise<SessionCorpusRecord | undefined> { const value = this.corpus.get(corpusId); return value ? structuredClone(value) : undefined; }

  async markSessionTransferred(sessionId: string, endedAt: string): Promise<void> {
    const session = this.sessions.get(sessionId); if (!session) throw new Error(`Unknown Session '${sessionId}'.`);
    session.lifecycleStatus = "transferred"; session.endedAt = endedAt;
  }

  async markArchived(sessionId: string, corpusId: string, receiptId: string): Promise<void> {
    const session = this.sessions.get(sessionId); const corpus = this.corpus.get(corpusId);
    if (!session || !corpus) throw new Error("Unknown Session archive target.");
    session.archiveStatus = "archived"; session.archiveReceiptId = receiptId; corpus.archiveReceiptId = receiptId;
  }

  async expireCorpus(now: string): Promise<string[]> {
    const expired: string[] = [];
    for (const value of this.corpus.values()) {
      if (value.lifecycleStatus !== "active" || Date.parse(value.expiresAt) > Date.parse(now)) continue;
      value.content = ""; value.lifecycleStatus = "deleted"; value.deletedAt = now; expired.push(value.corpusId);
    }
    return expired.sort();
  }

  async putReceipt(value: SessionLifecycleReceipt): Promise<"inserted" | "unchanged"> {
    const existing = this.receipts.get(value.receiptId);
    if (existing) { if (canonicalJson(existing) !== canonicalJson(value)) throw new Error(`Session receipt '${value.receiptId}' was reused.`); return "unchanged"; }
    this.receipts.set(value.receiptId, structuredClone(value)); return "inserted";
  }
}
