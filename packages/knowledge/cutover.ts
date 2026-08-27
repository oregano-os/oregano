import { canonicalJson, sha256 } from "../runtime/canonical.ts";

export interface BrainExportLedgerV1 {
  exportId: string;
  manifestId: string;
  manifestVersion: string;
  schemaDigest: string;
  handbookCommit: string;
  objectIdentities: string[];
  receiptIdentities: string[];
  policyIdentities: string[];
  sourceIdentities: string[];
  stateDigest: string;
  exportedAt: string;
}

export interface CompanyKnowledgeCutoverEvidence {
  databaseQualificationReceiptId: string;
  databaseManifestDigest: string;
  aclRegressionReceiptId: string;
  retrievalRegressionReceiptId: string;
  sourceQualificationReceiptIds: string[];
  modelProfileQualificationReceiptIds: string[];
  handbookCommit: string;
  handbookSnapshotDigest: string;
  backupReceiptId: string;
  rollbackTestReceiptId: string;
  exportLedgerId: string;
}

export interface CompanyKnowledgeCutoverReceipt {
  receiptId: string;
  status: "qualified";
  evidence: CompanyKnowledgeCutoverEvidence;
  activatedAt: string;
}

const identities = (values: string[], label: string): string[] => {
  const normalized = [...new Set(values.map((entry) => entry.trim()).filter(Boolean))].sort();
  if (normalized.length !== values.length || normalized.length === 0) throw new Error(`${label} must contain distinct non-empty identities.`);
  return normalized;
};

export function createBrainExportLedger(input: Omit<BrainExportLedgerV1, "exportId" | "stateDigest" | "objectIdentities" | "receiptIdentities" | "policyIdentities" | "sourceIdentities"> & {
  objectIdentities: string[]; receiptIdentities: string[]; policyIdentities: string[]; sourceIdentities: string[];
}): BrainExportLedgerV1 {
  const base = {
    manifestId: input.manifestId,
    manifestVersion: input.manifestVersion,
    schemaDigest: input.schemaDigest,
    handbookCommit: input.handbookCommit,
    objectIdentities: identities(input.objectIdentities, "Export objects"),
    receiptIdentities: identities(input.receiptIdentities, "Export receipts"),
    policyIdentities: identities(input.policyIdentities, "Export policies"),
    sourceIdentities: identities(input.sourceIdentities, "Export Sources"),
    exportedAt: new Date(input.exportedAt).toISOString(),
  };
  const stateDigest = sha256(base);
  return { exportId: sha256({ stateDigest, manifestId: base.manifestId, manifestVersion: base.manifestVersion }), ...base, stateDigest };
}

export function qualifyCompanyKnowledgeCutover(input: { evidence: CompanyKnowledgeCutoverEvidence; exportLedger: BrainExportLedgerV1; activatedAt: string }): CompanyKnowledgeCutoverReceipt {
  const fields = Object.entries(input.evidence).filter(([, value]) => typeof value === "string") as Array<[string, string]>;
  for (const [field, value] of fields) if (!value.trim()) throw new Error(`Cutover evidence '${field}' is missing.`);
  if (input.evidence.sourceQualificationReceiptIds.length === 0 || input.evidence.modelProfileQualificationReceiptIds.length === 0) throw new Error("Cutover requires qualified Source and model profile evidence.");
  if (input.exportLedger.exportId !== input.evidence.exportLedgerId || input.exportLedger.handbookCommit !== input.evidence.handbookCommit) throw new Error("Cutover evidence does not match its export ledger or Handbook commit.");
  const rebuilt = createBrainExportLedger(input.exportLedger);
  if (canonicalJson(rebuilt) !== canonicalJson(input.exportLedger)) throw new Error("Brain export ledger failed deterministic integrity validation.");
  const base = { status: "qualified" as const, evidence: { ...input.evidence, sourceQualificationReceiptIds: identities(input.evidence.sourceQualificationReceiptIds, "Cutover Source receipts"), modelProfileQualificationReceiptIds: identities(input.evidence.modelProfileQualificationReceiptIds, "Cutover model receipts") }, activatedAt: new Date(input.activatedAt).toISOString() };
  if (/postgres(?:ql)?:\/\//i.test(canonicalJson(base))) throw new Error("Cutover receipt contains a forbidden database credential.");
  return { receiptId: sha256(base), ...base };
}
