import { sha256 } from "../runtime/canonical.ts";
import type {
  KnowledgeAccessAuditor,
  KnowledgeAccessDecision,
  KnowledgeAccessPolicy,
  KnowledgeAccessSubject,
  KnowledgeBundle,
  KnowledgePermission,
  KnowledgeVisibility,
} from "./contracts.ts";

export const COMPANY_KNOWLEDGE_POLICY_ID = "policy:company-handbook";
export const QUARANTINE_POLICY_ID = "policy:quarantine";
export const KNOWLEDGE_ADMIN_GROUP_ID = "companyos:knowledge-admin";

const VISIBILITY_ORDER: Record<KnowledgeVisibility, number> = {
  public: 0,
  company: 1,
  team: 2,
  restricted_group: 3,
  individual: 4,
  private: 5,
};

export const COMPANY_KNOWLEDGE_POLICY: KnowledgeAccessPolicy = Object.freeze({
  policyId: COMPANY_KNOWLEDGE_POLICY_ID,
  policyVersion: 1,
  visibility: "company",
  sourceRoot: true,
  status: "active",
  entries: [],
});

export const QUARANTINE_POLICY: KnowledgeAccessPolicy = Object.freeze({
  policyId: QUARANTINE_POLICY_ID,
  policyVersion: 1,
  visibility: "private",
  sourceRoot: true,
  status: "quarantined",
  entries: [{ subjectKind: "group" as const, subjectId: KNOWLEDGE_ADMIN_GROUP_ID, permission: "admin" as const, effect: "allow" as const }],
});

export class InMemoryKnowledgeAccessAuditor implements KnowledgeAccessAuditor {
  readonly decisions: KnowledgeAccessDecision[] = [];
  record(decision: KnowledgeAccessDecision): void { this.decisions.push(structuredClone(decision)); }
}

const subjectMatches = (subject: KnowledgeAccessSubject, kind: "principal" | "group", id: string): boolean =>
  kind === "principal" ? subject.principalId === id : subject.groupIds.includes(id);

const permissionMatches = (requested: KnowledgePermission, granted: KnowledgePermission): boolean =>
  granted === requested || granted === "admin";

export function assertNarrowingPolicy(policy: KnowledgeAccessPolicy, parent?: KnowledgeAccessPolicy): void {
  if (!policy.policyId.trim() || policy.policyVersion < 1) throw new Error("Knowledge access policies require a stable id and positive version.");
  if (policy.parentPolicyId && !parent) throw new Error(`Knowledge policy '${policy.policyId}' has an unknown parent '${policy.parentPolicyId}'.`);
  if (parent && VISIBILITY_ORDER[policy.visibility] < VISIBILITY_ORDER[parent.visibility]) {
    throw new Error(`Knowledge policy '${policy.policyId}' widens parent '${parent.policyId}'.`);
  }
  const keys = new Set<string>();
  for (const entry of policy.entries) {
    if (!entry.subjectId.trim()) throw new Error(`Knowledge policy '${policy.policyId}' has an empty subject.`);
    const key = `${entry.subjectKind}\0${entry.subjectId}\0${entry.permission}`;
    if (keys.has(key)) throw new Error(`Knowledge policy '${policy.policyId}' has conflicting duplicate ACL entries.`);
    keys.add(key);
  }
  if (["team", "restricted_group"].includes(policy.visibility) && !policy.entries.some((entry) => entry.effect === "allow" && entry.subjectKind === "group")) {
    throw new Error(`Knowledge policy '${policy.policyId}' requires an allowed group.`);
  }
  if (["individual", "private"].includes(policy.visibility) && policy.status === "active" && !policy.entries.some((entry) => entry.effect === "allow")) {
    throw new Error(`Knowledge policy '${policy.policyId}' requires an explicit allowed subject.`);
  }
}

export function validateKnowledgePolicies(policies: readonly KnowledgeAccessPolicy[]): void {
  const byId = new Map(policies.map((policy) => [policy.policyId, policy]));
  if (byId.size !== policies.length) throw new Error("Knowledge access policy ids must be unique.");
  for (const policy of policies) assertNarrowingPolicy(policy, policy.parentPolicyId ? byId.get(policy.parentPolicyId) : undefined);
  for (const policy of policies) {
    const visited = new Set<string>();
    let cursor: KnowledgeAccessPolicy | undefined = policy;
    while (cursor?.parentPolicyId) {
      if (visited.has(cursor.policyId)) throw new Error(`Knowledge policy '${policy.policyId}' has an inheritance cycle.`);
      visited.add(cursor.policyId);
      cursor = byId.get(cursor.parentPolicyId);
    }
  }
}

export class KnowledgeAuthorizer {
  readonly #policies: Map<string, KnowledgeAccessPolicy>;
  readonly #auditor?: KnowledgeAccessAuditor;

  constructor(policies: readonly KnowledgeAccessPolicy[], auditor?: KnowledgeAccessAuditor) {
    validateKnowledgePolicies(policies);
    this.#policies = new Map(policies.map((policy) => [policy.policyId, structuredClone(policy)]));
    this.#auditor = auditor;
  }

  async authorize(input: {
    subject?: KnowledgeAccessSubject;
    permission: KnowledgePermission;
    policyIds: readonly string[];
    objectType: KnowledgeAccessDecision["objectType"];
    objectId: string;
  }): Promise<boolean> {
    const subject = input.subject ?? { principalId: "unresolved", principalType: "service" as const, status: "unresolved" as const, groupIds: [] };
    const policyIds = [...new Set(input.policyIds)].sort();
    let reason = "all-policy-intersections-permit";
    let permit = subject.status === "active" && Boolean(subject.principalId.trim()) && policyIds.length > 0;
    if (!permit) reason = subject.status !== "active" ? `principal-${subject.status}` : "missing-policy";
    if (permit) {
      for (const policyId of policyIds) {
        const evaluation = this.#evaluatePolicy(policyId, subject, input.permission, new Set());
        if (!evaluation.permit) { permit = false; reason = evaluation.reason; break; }
      }
    }
    const decidedAt = new Date().toISOString();
    const decision: KnowledgeAccessDecision = {
      decisionId: sha256({ decidedAt, principalId: subject.principalId, permission: input.permission, policyIds, objectType: input.objectType, objectIdHash: sha256(input.objectId), permit, reason }),
      decidedAt,
      principalId: subject.principalId,
      principalType: subject.principalType,
      groupIds: [...subject.groupIds].sort(),
      permission: input.permission,
      policyIds,
      objectType: input.objectType,
      objectIdHash: sha256(input.objectId),
      outcome: permit ? "permit" : "deny",
      reason,
    };
    await this.#auditor?.record(decision);
    return permit;
  }

  #evaluatePolicy(policyId: string, subject: KnowledgeAccessSubject, permission: KnowledgePermission, visited: Set<string>): { permit: boolean; reason: string } {
    const policy = this.#policies.get(policyId);
    if (!policy) return { permit: false, reason: "unknown-policy" };
    if (visited.has(policyId)) return { permit: false, reason: "policy-cycle" };
    visited.add(policyId);
    if (policy.status === "revoked") return { permit: false, reason: "policy-revoked" };
    if (policy.parentPolicyId) {
      const parent = this.#evaluatePolicy(policy.parentPolicyId, subject, permission, visited);
      if (!parent.permit) return { permit: false, reason: `parent-${parent.reason}` };
    }
    const matches = policy.entries.filter((entry) => subjectMatches(subject, entry.subjectKind, entry.subjectId) && permissionMatches(permission, entry.permission));
    if (matches.some((entry) => entry.effect === "deny")) return { permit: false, reason: "explicit-deny" };
    if (policy.status === "quarantined") return matches.some((entry) => entry.effect === "allow" && entry.permission === "admin")
      ? { permit: true, reason: "quarantine-admin" }
      : { permit: false, reason: "policy-quarantined" };
    if (matches.some((entry) => entry.effect === "allow")) return { permit: true, reason: "explicit-allow" };
    return ["public", "company"].includes(policy.visibility)
      ? { permit: true, reason: "visibility-baseline" }
      : { permit: false, reason: "no-matching-allow" };
  }
}

export async function filterAuthorizedKnowledgeBundle(
  bundle: KnowledgeBundle,
  subject: KnowledgeAccessSubject | undefined,
  authorizer: KnowledgeAuthorizer,
): Promise<KnowledgeBundle> {
  const documents = [];
  for (const document of bundle.documents) {
    if (await authorizer.authorize({ subject, permission: "read", policyIds: [document.accessPolicyId], objectType: "document", objectId: document.path })) documents.push(document);
  }
  const paths = new Set(documents.map((document) => document.path));
  const edges = bundle.edges.filter((edge) => paths.has(edge.from) && paths.has(edge.to));
  return {
    ...bundle,
    documents,
    edges,
    orphanPaths: documents.filter((document) => !edges.some((edge) => edge.from === document.path || edge.to === document.path)).map((document) => document.path),
    documentCount: documents.length,
    fragmentCount: documents.reduce((sum, document) => sum + document.fragments.length, 0),
  };
}
