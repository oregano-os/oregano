import { neon } from "@neondatabase/serverless";
import { canonicalJson } from "../runtime/canonical.ts";
import type {
  SessionCorpusRecord,
  SessionCorpusStore,
  SessionLifecycleReceipt,
  SessionRecord,
} from "../knowledge/session-corpus.ts";
import { ensureCompanyKnowledgeSchema } from "./knowledge-migrate.ts";
import { postgresTimestampToIso } from "./postgres-values.ts";

const connection = () => {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is not set — Session Corpus uses the Company Instance StateStore.");
  return neon(value);
};

const iso = postgresTimestampToIso;

export class PostgresSessionCorpusStore implements SessionCorpusStore {
  async putSession(session: SessionRecord): Promise<"inserted" | "unchanged"> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`insert into companyos_knowledge.sessions (
        session_id, principal_id, surface, external_session_id, access_policy_id,
        lifecycle_status, archive_status, started_at, ended_at)
      values (${session.sessionId}, ${session.principalId}, ${session.surface}, ${session.externalSessionId ?? null},
        ${session.accessPolicyId}, ${session.lifecycleStatus}, ${session.archiveStatus}, ${session.startedAt}, ${session.endedAt ?? null})
      on conflict (session_id) do update set session_id = excluded.session_id
      where companyos_knowledge.sessions.principal_id = excluded.principal_id
        and companyos_knowledge.sessions.surface = excluded.surface
        and companyos_knowledge.sessions.external_session_id is not distinct from excluded.external_session_id
        and companyos_knowledge.sessions.access_policy_id = excluded.access_policy_id
        and companyos_knowledge.sessions.started_at = excluded.started_at
      returning (xmax = 0) as inserted`;
    if (rows.length === 0) throw new Error(`Session '${session.sessionId}' already exists with different identity.`);
    return rows[0]?.inserted === true ? "inserted" : "unchanged";
  }

  async putCorpus(corpus: SessionCorpusRecord): Promise<"inserted" | "unchanged"> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`insert into companyos_knowledge.session_corpus (
        corpus_id, session_id, content, content_digest, normalized_format, access_policy_id,
        lifecycle_status, transferred_at, expires_at, archive_receipt_id, deleted_at)
      values (${corpus.corpusId}, ${corpus.sessionId}, ${corpus.content}, ${corpus.contentDigest}, ${corpus.normalizedFormat},
        ${corpus.accessPolicyId}, ${corpus.lifecycleStatus}, ${corpus.transferredAt}, ${corpus.expiresAt},
        ${corpus.archiveReceiptId ?? null}, ${corpus.deletedAt ?? null})
      on conflict (corpus_id) do update set corpus_id = excluded.corpus_id
      where companyos_knowledge.session_corpus.session_id = excluded.session_id
        and companyos_knowledge.session_corpus.content_digest = excluded.content_digest
        and companyos_knowledge.session_corpus.normalized_format = excluded.normalized_format
        and companyos_knowledge.session_corpus.access_policy_id = excluded.access_policy_id
        and companyos_knowledge.session_corpus.transferred_at = excluded.transferred_at
        and companyos_knowledge.session_corpus.expires_at = excluded.expires_at
      returning (xmax = 0) as inserted`;
    if (rows.length === 0) throw new Error(`Session Corpus '${corpus.corpusId}' already exists with different identity.`);
    return rows[0]?.inserted === true ? "inserted" : "unchanged";
  }

  async getCorpus(corpusId: string): Promise<SessionCorpusRecord | undefined> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select * from companyos_knowledge.session_corpus where corpus_id = ${corpusId} limit 1`;
    const row = rows[0];
    if (!row) return undefined;
    return {
      corpusId: String(row.corpus_id), sessionId: String(row.session_id), content: String(row.content),
      contentDigest: String(row.content_digest), normalizedFormat: row.normalized_format as SessionCorpusRecord["normalizedFormat"],
      accessPolicyId: String(row.access_policy_id), lifecycleStatus: row.lifecycle_status as SessionCorpusRecord["lifecycleStatus"],
      transferredAt: iso(row.transferred_at), expiresAt: iso(row.expires_at),
      ...(row.archive_receipt_id ? { archiveReceiptId: String(row.archive_receipt_id) } : {}),
      ...(row.deleted_at ? { deletedAt: iso(row.deleted_at) } : {}),
    };
  }

  async markSessionTransferred(sessionId: string, endedAt: string): Promise<void> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`update companyos_knowledge.sessions
      set lifecycle_status = 'transferred', ended_at = coalesce(ended_at, ${endedAt})
      where session_id = ${sessionId} and lifecycle_status in ('open','transferred') returning session_id`;
    if (rows.length === 0) throw new Error(`Unknown or closed Session '${sessionId}'.`);
  }

  async markArchived(sessionId: string, corpusId: string, receiptId: string): Promise<void> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const results = await sql.transaction([
      sql`update companyos_knowledge.sessions set archive_status = 'archived'
        where session_id = ${sessionId} returning session_id`,
      sql`update companyos_knowledge.session_corpus set archive_receipt_id = ${receiptId}
        where corpus_id = ${corpusId} and session_id = ${sessionId} returning corpus_id`,
    ]);
    if (results[0].length === 0 || results[1].length === 0) throw new Error("Unknown Session archive target.");
  }

  async expireCorpus(now: string): Promise<string[]> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`update companyos_knowledge.session_corpus
      set content = '', lifecycle_status = 'deleted', deleted_at = ${now}
      where lifecycle_status = 'active' and expires_at <= ${now}
      returning corpus_id`;
    return rows.map((row) => String(row.corpus_id)).sort();
  }

  async putReceipt(receipt: SessionLifecycleReceipt): Promise<"inserted" | "unchanged"> {
    await ensureCompanyKnowledgeSchema();
    const serialized = JSON.stringify(receipt);
    const rows = await connection()`insert into companyos_knowledge.session_lifecycle_receipts (
        receipt_id, operation, outcome, session_id, corpus_id, buffer_id, occurred_at, evidence_digest, reason_code, receipt)
      values (${receipt.receiptId}, ${receipt.operation}, ${receipt.outcome}, ${receipt.sessionId}, ${receipt.corpusId ?? null},
        ${receipt.bufferId ?? null}, ${receipt.occurredAt}, ${receipt.evidenceDigest}, ${receipt.reasonCode}, ${serialized})
      on conflict (receipt_id) do update set receipt_id = excluded.receipt_id
      where companyos_knowledge.session_lifecycle_receipts.receipt = excluded.receipt
      returning (xmax = 0) as inserted`;
    if (rows.length === 0) throw new Error(`Session receipt '${receipt.receiptId}' was reused with different content (${canonicalJson(receipt).length} bytes).`);
    return rows[0]?.inserted === true ? "inserted" : "unchanged";
  }
}
