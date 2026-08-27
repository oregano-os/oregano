import { neon } from "@neondatabase/serverless";
import type { CompoundingReceipt, CompoundingStateStore } from "../knowledge/compounding.ts";
import type {
  ClaimGradingResultWrite,
  ClaimGradingWorkItem,
  ClaimPairProposalWrite,
  CompoundingClaim,
  CompoundingEvidenceBlock,
  KnowledgeCompoundingWorkStore,
  WorkingSynthesisWrite,
} from "../knowledge/productive-compounding.ts";
import { canonicalJson, sha256 } from "../runtime/canonical.ts";
import { ensureCompanyKnowledgeSchema } from "./knowledge-migrate.ts";
import { postgresTimestampToIso } from "./postgres-values.ts";

const connection = () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — Knowledge compounding uses the Company Instance database.");
  return neon(url);
};

const lock = (lockKey: string): { phase: string; scope: "source" | "mixed" | "global"; scopeId: string } => {
  const match = /^compounding:(source|mixed|global):(.+)$/.exec(lockKey);
  if (!match) throw new Error("Knowledge compounding lock key is invalid.");
  const scope = match[1] as "source" | "mixed" | "global";
  const scopeId = String(match[2]);
  return { phase: scope === "source" ? "source-lane" : scopeId, scope, scopeId };
};

const iso = postgresTimestampToIso;
const json = <T>(value: unknown): T => value as T;

export class PostgresCompoundingStateStore implements CompoundingStateStore {
  async acquire(lockKey: string, owner: string, until: string): Promise<boolean> {
    await ensureCompanyKnowledgeSchema();
    const identity = lock(lockKey);
    const acquiredAt = new Date().toISOString();
    if (Date.parse(until) <= Date.parse(acquiredAt)) throw new Error("Knowledge compounding lease must end after acquisition.");
    const sql = connection();
    const rows = await sql`insert into companyos_knowledge.compounding_leases
        (phase, scope, scope_id, lease_owner, acquired_at, lease_until)
      values (${identity.phase}, ${identity.scope}, ${identity.scopeId}, ${owner}, ${acquiredAt}, ${until})
      on conflict (phase, scope, scope_id) do update set
        lease_owner = excluded.lease_owner,
        acquired_at = excluded.acquired_at,
        lease_until = excluded.lease_until
      where companyos_knowledge.compounding_leases.lease_until <= ${acquiredAt}
        or companyos_knowledge.compounding_leases.lease_owner = ${owner}
      returning lease_owner`;
    return rows.length === 1;
  }

  async release(lockKey: string, owner: string): Promise<void> {
    await ensureCompanyKnowledgeSchema();
    const identity = lock(lockKey);
    const sql = connection();
    await sql`delete from companyos_knowledge.compounding_leases
      where phase = ${identity.phase} and scope = ${identity.scope} and scope_id = ${identity.scopeId}
        and lease_owner = ${owner}`;
  }

  async getReceipt(idempotencyKey: string): Promise<CompoundingReceipt | undefined> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const rows = await sql`select receipt from companyos_knowledge.compounding_receipts
      where idempotency_key = ${idempotencyKey} limit 1`;
    return rows[0] ? structuredClone(json<CompoundingReceipt>(rows[0].receipt)) : undefined;
  }

  async putReceipt(idempotencyKey: string, receipt: CompoundingReceipt): Promise<void> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const encoded = canonicalJson(receipt);
    const rows = await sql`insert into companyos_knowledge.compounding_receipts
        (idempotency_key, receipt_id, cycle_id, phase, scope, scope_id, processed, complete,
          continuation, evidence_digest, started_at, completed_at, receipt)
      values (${idempotencyKey}, ${receipt.receiptId}, ${receipt.cycleId}, ${receipt.phase}, ${receipt.scope},
        ${receipt.scopeId}, ${receipt.processed}, ${receipt.complete}, ${receipt.continuation ?? null},
        ${receipt.evidenceDigest}, ${receipt.startedAt}, ${receipt.completedAt}, ${encoded}::jsonb)
      on conflict (idempotency_key) do update set
        receipt_id = excluded.receipt_id,
        processed = excluded.processed,
        complete = excluded.complete,
        continuation = excluded.continuation,
        evidence_digest = excluded.evidence_digest,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        receipt = excluded.receipt,
        recorded_at = now()
      where companyos_knowledge.compounding_receipts.receipt = excluded.receipt
        or (
          companyos_knowledge.compounding_receipts.complete = false
          and companyos_knowledge.compounding_receipts.cycle_id = excluded.cycle_id
          and companyos_knowledge.compounding_receipts.phase = excluded.phase
          and companyos_knowledge.compounding_receipts.scope = excluded.scope
          and companyos_knowledge.compounding_receipts.scope_id = excluded.scope_id
        )
      returning receipt_id`;
    if (rows.length !== 1) throw new Error(`Compounding idempotency key '${idempotencyKey}' was reused.`);
  }
}

const mapClaim = (row: Record<string, unknown>): CompoundingClaim => ({
  claimId: String(row.claim_id),
  claimText: String(row.claim_text),
  memoryClass: row.memory_class as CompoundingClaim["memoryClass"],
  claimKind: String(row.claim_kind),
  status: String(row.status),
  observedAt: iso(row.observed_at),
  accessPolicyId: String(row.access_policy_id),
  subjectIds: [...new Set(json<unknown[]>(row.subject_ids ?? []).map((value) => {
    const identity = String(value);
    return identity.startsWith("page:") ? identity : `page:${identity}`;
  }))].sort(),
});

export class PostgresKnowledgeCompoundingWorkStore implements KnowledgeCompoundingWorkStore {
  async listClaims(input: { accessPolicyIds: string[]; limit: number }): Promise<CompoundingClaim[]> {
    await ensureCompanyKnowledgeSchema();
    if (input.accessPolicyIds.length === 0) return [];
    const sql = connection();
    const rows = await sql`select c.claim_id, c.claim_text, c.memory_class, c.claim_kind, c.status,
        c.observed_at, c.access_policy_id,
        coalesce(jsonb_agg(distinct ce.page_id) filter (where ce.page_id is not null), '[]'::jsonb) as subject_ids
      from companyos_knowledge.claims c
      left join companyos_knowledge.claim_evidence ce on ce.claim_id = c.claim_id
      where c.access_policy_id = any(${input.accessPolicyIds}::text[])
        and c.status in ('proposed','active','contested','resolved','superseded')
        and (c.model_provenance is null or exists (
          select 1 from companyos_knowledge.extraction_runs r
          where r.run_id = c.model_provenance->>'extractionRunId' and r.status = 'succeeded'))
      group by c.claim_id
      order by c.claim_id
      limit ${Math.max(1, Math.min(input.limit, 2_000))}`;
    return rows.map((row) => mapClaim(row as Record<string, unknown>)).filter((claim) => claim.subjectIds.length > 0);
  }

  async putClaimPairProposal(proposal: ClaimPairProposalWrite): Promise<"inserted" | "unchanged"> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const rows = await sql`insert into companyos_knowledge.claim_pair_proposals
        (proposal_id, left_claim_id, right_claim_id, proposal_kind, judgment, severity, confidence,
          rationale, details, model_receipt_id, prompt_identity, access_policy_id, created_at)
      values (${proposal.proposalId}, ${proposal.leftClaimId}, ${proposal.rightClaimId}, ${proposal.proposalKind},
        ${proposal.judgment}, ${proposal.severity ?? null}, ${proposal.confidence}, ${proposal.rationale},
        ${JSON.stringify(proposal.details)}, ${proposal.modelReceiptId}, ${proposal.promptIdentity},
        ${proposal.accessPolicyId}, ${proposal.createdAt})
      on conflict (proposal_id) do nothing returning proposal_id`;
    return rows.length === 1 ? "inserted" : "unchanged";
  }

  async putWorkingSynthesis(synthesis: WorkingSynthesisWrite): Promise<"inserted" | "unchanged"> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const [subjectType, ...subjectParts] = synthesis.subjectIdentity.split(":");
    const subjectId = subjectParts.join(":");
    if (!subjectType || !subjectId) throw new Error("Working synthesis subject identity is invalid.");
    const synthesisId = sha256({ subjectType, subjectId, accessPolicyId: synthesis.accessPolicyId });
    const content = `# ${synthesis.title.trim()}\n\n${synthesis.body.trim()}`;
    const contentDigest = sha256(content);
    const current = await sql`select s.current_version_id, v.version_number, v.content_digest
      from companyos_knowledge.syntheses s
      join companyos_knowledge.synthesis_versions v on v.synthesis_version_id = s.current_version_id
      where s.synthesis_id = ${synthesisId} limit 1`;
    if (current[0]?.content_digest === contentDigest) return "unchanged";
    const versionNumber = Number(current[0]?.version_number ?? 0) + 1;
    const citations = [...new Set([...synthesis.supportingClaimIds, ...synthesis.contestedClaimIds, ...synthesis.supersededClaimIds])]
      .sort().map((claimId) => ({ identity: `claim:${claimId}` }));
    const versionBase = {
      synthesisId, versionNumber, contentDigest,
      supportingClaimIds: synthesis.supportingClaimIds,
      contestedClaimIds: synthesis.contestedClaimIds,
      supersededClaimIds: synthesis.supersededClaimIds,
      gaps: synthesis.gaps,
      modelReceiptId: synthesis.modelReceipt.receiptId,
      synthesizedAt: synthesis.synthesizedAt,
    };
    const synthesisVersionId = sha256(versionBase);
    const results = await sql.transaction((tx) => [
      tx`insert into companyos_knowledge.syntheses
          (synthesis_id, subject_type, subject_id, current_version_id, access_policy_id, lifecycle_status, created_at)
        values (${synthesisId}, ${subjectType}, ${subjectId}, ${synthesisVersionId}, ${synthesis.accessPolicyId}, 'active', ${synthesis.synthesizedAt})
        on conflict (synthesis_id) do nothing returning synthesis_id`,
      tx`insert into companyos_knowledge.synthesis_versions
          (synthesis_version_id, synthesis_id, version_number, content, content_digest, supporting_claim_ids,
            contested_claim_ids, superseded_claim_ids, gaps, citations, model_provenance, access_policy_id, synthesized_at)
        values (${synthesisVersionId}, ${synthesisId}, ${versionNumber}, ${content}, ${contentDigest},
          ${JSON.stringify(synthesis.supportingClaimIds)}, ${JSON.stringify(synthesis.contestedClaimIds)},
          ${JSON.stringify(synthesis.supersededClaimIds)}, ${JSON.stringify(synthesis.gaps)}, ${JSON.stringify(citations)},
          ${JSON.stringify(synthesis.modelReceipt)}, ${synthesis.accessPolicyId}, ${synthesis.synthesizedAt})
        on conflict (synthesis_version_id) do nothing returning synthesis_version_id`,
      tx`update companyos_knowledge.syntheses set current_version_id = ${synthesisVersionId}
        where synthesis_id = ${synthesisId} and current_version_id is distinct from ${synthesisVersionId}
        returning synthesis_id`,
    ], { isolationLevel: "Serializable" });
    if (results[1]?.length !== 1) throw new Error("Working synthesis version conflicts with existing content.");
    return "inserted";
  }

  async listPendingGradingRequests(input: { accessPolicyIds: string[]; limit: number }): Promise<ClaimGradingWorkItem[]> {
    await ensureCompanyKnowledgeSchema();
    if (input.accessPolicyIds.length === 0) return [];
    const sql = connection();
    const requests = await sql`select r.*, c.claim_text, c.memory_class, c.claim_kind, c.status as claim_status,
        c.observed_at, c.access_policy_id as claim_access_policy_id,
        coalesce(jsonb_agg(distinct own.page_id) filter (where own.page_id is not null), '[]'::jsonb) as subject_ids,
        coalesce(jsonb_agg(distinct jsonb_build_object('sourceId', own.source_id, 'providerObjectId', own.provider_object_id))
          filter (where own.evidence_id is not null), '[]'::jsonb) as original_sources
      from companyos_knowledge.claim_grading_requests r
      join companyos_knowledge.claims c on c.claim_id = r.claim_id
      left join companyos_knowledge.claim_evidence own on own.claim_id = c.claim_id
      where r.status = 'pending' and r.access_policy_id = any(${input.accessPolicyIds}::text[])
        and (c.model_provenance is null or exists (
          select 1 from companyos_knowledge.extraction_runs er
          where er.run_id = c.model_provenance->>'extractionRunId' and er.status = 'succeeded'))
      group by r.request_id, c.claim_id
      order by r.requested_at, r.request_id
      limit ${Math.max(1, Math.min(input.limit, 1_000))}`;
    const work: ClaimGradingWorkItem[] = [];
    for (const request of requests) {
      const ids = json<unknown[]>(request.outcome_evidence_ids).map(String);
      const originals = new Set(json<Array<{ sourceId: string; providerObjectId: string }>>(request.original_sources)
        .map((entry) => `${entry.sourceId}\0${entry.providerObjectId}`));
      const rows = ids.length === 0 ? [] : await sql`select ce.evidence_id, ce.source_id, ce.provider_object_id,
          ce.provider_version, ce.content_digest, ce.observed_at, ce.locator, ce.page_id, ce.page_version_id,
          pv.body as page_body
        from companyos_knowledge.claim_evidence ce
        left join companyos_knowledge.page_versions pv on pv.page_version_id = ce.page_version_id
        where ce.evidence_id = any(${ids}::text[])
          and ce.observed_at > ${iso(request.observed_at)}
        order by ce.evidence_id, ce.observed_at desc`;
      const seen = new Set<string>();
      const outcomeEvidence: CompoundingEvidenceBlock[] = [];
      for (const row of rows) {
        const evidenceId = String(row.evidence_id);
        if (seen.has(evidenceId) || originals.has(`${String(row.source_id)}\0${String(row.provider_object_id)}`)) continue;
        seen.add(evidenceId);
        const content = String(row.page_body ?? canonicalJson({ contentDigest: row.content_digest, locator: row.locator }));
        outcomeEvidence.push({ evidenceId, content, contentDigest: sha256(content), metadata: {
          sourceId: String(row.source_id), providerObjectId: String(row.provider_object_id), providerVersion: String(row.provider_version),
          sourceContentDigest: String(row.content_digest), observedAt: iso(row.observed_at), locator: row.locator,
          ...(row.page_id ? { pageId: String(row.page_id) } : {}), ...(row.page_version_id ? { pageVersionId: String(row.page_version_id) } : {}),
        } });
      }
      work.push({
        requestId: String(request.request_id),
        claim: mapClaim({ ...request, claim_id: request.claim_id, status: request.claim_status, access_policy_id: request.claim_access_policy_id }),
        outcomeEvidenceIds: ids,
        outcomeEvidence,
        accessPolicyId: String(request.access_policy_id),
      });
    }
    return work;
  }

  async completeGradingRequest(result: ClaimGradingResultWrite): Promise<"inserted" | "unchanged"> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const selected = new Set(result.supportingEvidenceIds);
    const outcomeEvidence = result.outcomeEvidence.filter((entry) => selected.has(entry.evidenceId)).map((entry) => entry.metadata);
    if (result.outcome !== "unresolvable" && outcomeEvidence.length === 0) throw new Error("A resolved Claim grade requires supporting outcome evidence.");
    const base = { requestId: result.requestId, claimId: result.claimId, outcome: result.outcome, outcomeEvidence, judgeReceiptId: result.modelReceipt.receiptId, proposedAt: result.proposedAt };
    const proposalId = sha256(base);
    const results = await sql.transaction((tx) => [
      tx`insert into companyos_knowledge.claim_resolution_proposals
          (proposal_id, claim_id, outcome, outcome_evidence, judge_receipt_id, proposed_by, proposed_at, status)
        values (${proposalId}, ${result.claimId}, ${result.outcome}, ${JSON.stringify(outcomeEvidence)},
          ${result.modelReceipt.receiptId}, 'knowledge-compounding', ${result.proposedAt}, 'proposed')
        on conflict (proposal_id) do nothing returning proposal_id`,
      tx`update companyos_knowledge.claim_grading_requests set status = 'processed', result_proposal_id = ${proposalId},
          result_receipt_id = ${result.modelReceipt.receiptId}, updated_at = ${result.proposedAt}
        where request_id = ${result.requestId} and status = 'pending' returning request_id`,
    ], { isolationLevel: "Serializable" });
    if (results[1]?.length !== 1) {
      const existing = await sql`select result_proposal_id from companyos_knowledge.claim_grading_requests
        where request_id = ${result.requestId} limit 1`;
      if (existing[0]?.result_proposal_id !== proposalId) throw new Error("Claim grading request was completed by different evidence.");
      return "unchanged";
    }
    return results[0]?.length === 1 ? "inserted" : "unchanged";
  }

  async deferGradingRequest(requestId: string, reason: string): Promise<void> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    await sql`update companyos_knowledge.claim_grading_requests set status = 'deferred',
        result_receipt_id = ${sha256({ requestId, reason })}, updated_at = ${new Date().toISOString()}
      where request_id = ${requestId} and status = 'pending'`;
  }
}
