import { neon } from "@neondatabase/serverless";
import type { KnowledgeAccessAuditor, KnowledgeAccessDecision, KnowledgeAccessSubject } from "../knowledge/contracts.ts";
import { sha256 } from "../runtime/canonical.ts";

const connection = () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — Company Knowledge uses the existing Company Instance database.");
  return neon(url);
};

export class PostgresKnowledgeAccessAuditor implements KnowledgeAccessAuditor {
  async record(decision: KnowledgeAccessDecision): Promise<void> {
    await connection()`insert into companyos_knowledge.access_decision_events
      (decision_id, decided_at, principal_id, principal_type, group_ids, permission,
        policy_ids, object_type, object_id_hash, outcome, reason)
      values (${decision.decisionId}, ${decision.decidedAt}, ${decision.principalId},
        ${decision.principalType}, ${JSON.stringify(decision.groupIds)}, ${decision.permission},
        ${JSON.stringify(decision.policyIds)}, ${decision.objectType}, ${decision.objectIdHash},
        ${decision.outcome}, ${decision.reason})
      on conflict (decision_id) do nothing`;
  }
}

export async function enrichPostgresKnowledgeSubject(subject?: KnowledgeAccessSubject): Promise<KnowledgeAccessSubject | undefined> {
  if (!subject || subject.status !== "active") return subject;
  const rows = await connection()`select m.group_id
    from companyos_knowledge.principal_group_members m
    join companyos_knowledge.principal_groups g on g.group_id = m.group_id
    where m.principal_id = ${subject.principalId}
      and m.membership_status = 'active' and g.group_status = 'active'
    order by m.group_id`;
  return { ...subject, groupIds: [...new Set([...subject.groupIds, ...rows.map((row) => String(row.group_id))])].sort() };
}

export async function resolvePostgresExternalPrincipal(input: {
  provider: string;
  providerAccountId: string;
  externalPrincipalId: string;
  principalType?: KnowledgeAccessSubject["principalType"];
}): Promise<KnowledgeAccessSubject> {
  const rows = await connection()`select canonical_principal_id, mapping_status
    from companyos_knowledge.external_principals
    where provider = ${input.provider} and provider_account_id = ${input.providerAccountId}
      and external_principal_id = ${input.externalPrincipalId} limit 1`;
  const row = rows[0];
  const status = row?.mapping_status === "verified" && row.canonical_principal_id ? "active" as const
    : row?.mapping_status === "revoked" ? "revoked" as const : "unresolved" as const;
  const subject = (await enrichPostgresKnowledgeSubject({
    principalId: row?.canonical_principal_id ? String(row.canonical_principal_id) : `external:${input.provider}:${input.providerAccountId}:${input.externalPrincipalId}`,
    principalType: input.principalType ?? "human",
    status,
    groupIds: [],
  }))!;
  const decidedAt = new Date().toISOString();
  const objectIdHash = sha256({ provider: input.provider, providerAccountId: input.providerAccountId, externalPrincipalId: input.externalPrincipalId });
  const outcome = status === "active" ? "permit" as const : "deny" as const;
  const reason = status === "active" ? "verified-external-principal-mapping" : `external-principal-${status}`;
  await new PostgresKnowledgeAccessAuditor().record({
    decisionId: sha256({ decidedAt, objectIdHash, principalId: subject.principalId, outcome, reason }),
    decidedAt,
    principalId: subject.principalId,
    principalType: subject.principalType,
    groupIds: subject.groupIds,
    permission: "read",
    policyIds: ["identity-mapping"],
    objectType: "policy",
    objectIdHash,
    outcome,
    reason,
  });
  return subject;
}
