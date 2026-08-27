import { canonicalJson, sha256 } from "../runtime/canonical.ts";

export type HandbookEffectKind = "handbook" | "policy" | "workflow" | "role" | "grant" | "schedule" | "goal" | "personnel";
export type PromotionDecision = "accepted" | "rejected" | "superseded" | "request-more-evidence";

export interface HandbookPromotionFile {
  path: string;
  baseDigest?: string;
  proposedContent: string;
  proposedDigest: string;
  effectKinds: HandbookEffectKind[];
}

export interface HandbookPromotionCandidateV2 {
  candidateId: string;
  files: HandbookPromotionFile[];
  evidenceClaimIds: string[];
  evidenceDigests: string[];
  conflictSummary: string[];
  consequenceSummary: string[];
  sourceDigest: string;
  effectDigest: string;
  accessPolicyId: string;
  status: "proposed" | "accepted" | "rejected" | "superseded" | "needs-evidence";
  createdBy: string;
  createdAt: string;
}

export interface HandbookDecisionReceiptV2 {
  receiptId: string;
  candidateId: string;
  authorityPrincipalId: string;
  authorityRole: string;
  authorityScope: string[];
  decision: PromotionDecision;
  sourceDigest: string;
  effectDigest: string;
  decidedAt: string;
  evidence: { human: true; authorizationDecisionId: string; note?: string };
}

const normalizePath = (path: string): string => {
  const value = path.replaceAll("\\", "/");
  if (!value.startsWith("handbook/") || value.startsWith("/") || value.split("/").includes("..") || !/\.md$/i.test(value)) throw new Error(`Invalid Handbook promotion path '${path}'.`);
  return value;
};

export function detectHandbookEffects(path: string, content: string): HandbookEffectKind[] {
  const effects = new Set<HandbookEffectKind>(["handbook"]);
  const combined = `${path}\n${content}`;
  if (/\b(policy|policies|richtlinie)\b/i.test(combined)) effects.add("policy");
  if (/\b(workflow|procedure|process|playbook)\b/i.test(combined)) effects.add("workflow");
  if (/\b(role|owner|responsib|zuständig)\b/i.test(combined)) effects.add("role");
  if (/\b(grant|permission|access|zugriff|berechtigung)\b/i.test(combined)) effects.add("grant");
  if (/\b(schedule|cadence|weekly|monthly|deadline|termin)\b/i.test(combined)) effects.add("schedule");
  if (/\b(goal|objective|okr|ziel)\b/i.test(combined)) effects.add("goal");
  if (/\b(salary|compensation|promotion|termination|hire|personnel|gehalt|personalentscheidung)\b/i.test(combined)) effects.add("personnel");
  return [...effects].sort();
}

export function createHandbookPromotionCandidate(input: {
  files: Array<{ path: string; baseContent?: string; proposedContent: string }>;
  evidenceClaimIds: string[];
  evidenceDigests: string[];
  conflicts?: string[];
  consequences?: string[];
  accessPolicyId: string;
  createdBy: string;
  createdAt: string;
}): HandbookPromotionCandidateV2 {
  if (input.files.length === 0 || input.files.length > 25) throw new Error("Handbook promotion requires a bounded non-empty file set.");
  const paths = new Set<string>();
  const files = input.files.map((file): HandbookPromotionFile => {
    const path = normalizePath(file.path);
    if (paths.has(path)) throw new Error(`Duplicate Handbook promotion path '${path}'.`);
    paths.add(path);
    if (!file.proposedContent.trim()) throw new Error(`Handbook promotion '${path}' has empty proposed content.`);
    return { path, ...(file.baseContent === undefined ? {} : { baseDigest: sha256(file.baseContent) }), proposedContent: file.proposedContent, proposedDigest: sha256(file.proposedContent), effectKinds: detectHandbookEffects(path, file.proposedContent) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const evidenceClaimIds = [...new Set(input.evidenceClaimIds)].sort();
  const evidenceDigests = [...new Set(input.evidenceDigests)].sort();
  if (evidenceClaimIds.length === 0 || evidenceDigests.length === 0 || evidenceDigests.some((digest) => !/^[a-f0-9]{64}$/.test(digest))) throw new Error("Handbook promotion requires exact Claim and evidence identities.");
  const conflictSummary = [...new Set(input.conflicts ?? [])].sort();
  const consequenceSummary = [...new Set(input.consequences ?? [])].sort();
  const sourceDigest = sha256({ evidenceClaimIds, evidenceDigests });
  const effectDigest = sha256({ files: files.map(({ path, baseDigest, proposedDigest, effectKinds }) => ({ path, baseDigest, proposedDigest, effectKinds })), conflictSummary, consequenceSummary });
  const base = { files, evidenceClaimIds, evidenceDigests, conflictSummary, consequenceSummary, sourceDigest, effectDigest, accessPolicyId: input.accessPolicyId, status: "proposed" as const, createdBy: input.createdBy, createdAt: new Date(input.createdAt).toISOString() };
  return { candidateId: sha256(base), ...base };
}

export function decideHandbookPromotion(input: {
  candidate: HandbookPromotionCandidateV2;
  decision: PromotionDecision;
  authority: { principalId: string; principalType: "human" | "agent" | "service"; status: "active" | "inactive"; role: string; scope: string[]; authorizationDecisionId: string; canPromote: boolean };
  decidedAt: string;
  note?: string;
}): { candidate: HandbookPromotionCandidateV2; receipt: HandbookDecisionReceiptV2 } {
  if (input.candidate.status !== "proposed" && input.candidate.status !== "needs-evidence") throw new Error(`Promotion candidate '${input.candidate.candidateId}' is not decidable.`);
  if (input.authority.principalType !== "human" || input.authority.status !== "active" || !input.authority.canPromote) throw new Error("Handbook promotion requires an active attributable human with promote authority.");
  if (!input.authority.principalId.trim() || !input.authority.role.trim() || !input.authority.authorizationDecisionId.trim()) throw new Error("Handbook promotion authority evidence is incomplete.");
  const authorityScope = [...new Set(input.authority.scope.map(normalizePath))].sort();
  if (input.decision === "accepted" && input.candidate.files.some((file) => !authorityScope.includes(file.path))) throw new Error("Handbook promotion exceeds the authority scope.");
  const decidedAt = new Date(input.decidedAt).toISOString();
  const withoutId = { candidateId: input.candidate.candidateId, authorityPrincipalId: input.authority.principalId, authorityRole: input.authority.role, authorityScope, decision: input.decision, sourceDigest: input.candidate.sourceDigest, effectDigest: input.candidate.effectDigest, decidedAt, evidence: { human: true as const, authorizationDecisionId: input.authority.authorizationDecisionId, ...(input.note?.trim() ? { note: input.note.trim() } : {}) } };
  const receipt = { receiptId: sha256(withoutId), ...withoutId };
  const status = input.decision === "accepted" ? "accepted" : input.decision === "request-more-evidence" ? "needs-evidence" : input.decision;
  return { candidate: { ...input.candidate, status }, receipt };
}

export function materializeHandbookPromotion(input: {
  candidate: HandbookPromotionCandidateV2;
  receipt: HandbookDecisionReceiptV2;
  currentFiles: Readonly<Record<string, string | undefined>>;
}): { files: Record<string, string>; materializationDigest: string; evidenceArchive: { candidateId: string; receiptId: string; sourceDigest: string; effectDigest: string } } {
  if (input.candidate.status !== "accepted" || input.receipt.decision !== "accepted") throw new Error("Only an accepted Handbook promotion can materialize.");
  if (input.receipt.candidateId !== input.candidate.candidateId || input.receipt.sourceDigest !== input.candidate.sourceDigest || input.receipt.effectDigest !== input.candidate.effectDigest) throw new Error("Decision Receipt does not bind the exact candidate source and effect digests.");
  const receiptWithoutId = { candidateId: input.receipt.candidateId, authorityPrincipalId: input.receipt.authorityPrincipalId, authorityRole: input.receipt.authorityRole, authorityScope: input.receipt.authorityScope, decision: input.receipt.decision, sourceDigest: input.receipt.sourceDigest, effectDigest: input.receipt.effectDigest, decidedAt: input.receipt.decidedAt, evidence: input.receipt.evidence };
  if (sha256(receiptWithoutId) !== input.receipt.receiptId) throw new Error("Decision Receipt failed integrity validation.");
  const allEffects = new Set(input.candidate.files.flatMap((file) => file.effectKinds));
  const paths = new Set(input.candidate.files.map((file) => file.path));
  if (allEffects.has("grant") && ![...paths].some((path) => /(?:access|grant|permission|role)/i.test(path))) throw new Error("Cross-document grant effects require an explicit access, grant, permission, or role file in the materialization set.");
  if (allEffects.has("schedule") && ![...paths].some((path) => /(?:schedule|cadence|calendar|operating)/i.test(path))) throw new Error("Cross-document schedule effects require an explicit schedule, cadence, calendar, or operating file in the materialization set.");
  const files: Record<string, string> = {};
  for (const file of input.candidate.files) {
    const current = input.currentFiles[file.path];
    if (file.baseDigest === undefined ? current !== undefined : current === undefined || sha256(current) !== file.baseDigest) throw new Error(`Handbook base changed for '${file.path}'; create and review a new candidate.`);
    if (sha256(file.proposedContent) !== file.proposedDigest) throw new Error(`Handbook proposed content changed for '${file.path}'.`);
    files[file.path] = file.proposedContent;
  }
  const materializationDigest = sha256({ receiptId: input.receipt.receiptId, files: Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => ({ path, digest: sha256(content) })) });
  return { files, materializationDigest, evidenceArchive: { candidateId: input.candidate.candidateId, receiptId: input.receipt.receiptId, sourceDigest: input.candidate.sourceDigest, effectDigest: input.candidate.effectDigest } };
}

export function assertHandbookPromotionIntegrity(candidate: HandbookPromotionCandidateV2): void {
  if (candidate.candidateId !== sha256({ files: candidate.files, evidenceClaimIds: candidate.evidenceClaimIds, evidenceDigests: candidate.evidenceDigests, conflictSummary: candidate.conflictSummary, consequenceSummary: candidate.consequenceSummary, sourceDigest: candidate.sourceDigest, effectDigest: candidate.effectDigest, accessPolicyId: candidate.accessPolicyId, status: "proposed", createdBy: candidate.createdBy, createdAt: candidate.createdAt }) && candidate.status === "proposed") throw new Error("Handbook promotion candidate failed integrity validation.");
  if (canonicalJson(candidate).includes("DATABASE_URL")) throw new Error("Handbook promotion candidate contains forbidden runtime secret material.");
}
