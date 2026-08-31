import type { CompanyRecordProjectionDeclaration, RecordAccessDecision, RecordAccessSubject } from "./contracts.ts";
import { recordDigest } from "./identity.ts";

export function decideProjectionAccess(args: {
  projection: CompanyRecordProjectionDeclaration;
  subject: RecordAccessSubject;
  decidedAt: string;
}): RecordAccessDecision {
  const { projection, subject, decidedAt } = args;
  const policyDigest = recordDigest({ read_groups: [...projection.access.read_groups].sort() });
  if (subject.status !== "active") {
    return { allowed: false, projection_id: projection.id, principal_id: subject.principal_id, policy_digest: policyDigest, reason: "inactive-subject", decided_at: decidedAt };
  }
  if (projection.access.read_groups.some((group) => subject.group_ids.includes(group))) {
    return { allowed: true, projection_id: projection.id, principal_id: subject.principal_id, policy_digest: policyDigest, reason: "group-allowed", decided_at: decidedAt };
  }
  return { allowed: false, projection_id: projection.id, principal_id: subject.principal_id, policy_digest: policyDigest, reason: "no-matching-grant", decided_at: decidedAt };
}
