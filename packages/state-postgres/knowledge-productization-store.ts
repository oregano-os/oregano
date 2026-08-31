import { neon } from "@neondatabase/serverless";
import type { KnowledgeBenchComparison, KnowledgeBenchReport } from "../knowledge/knowledge-bench.ts";
import type { KnowledgeDoctorReport } from "../knowledge/knowledge-doctor.ts";
import type { KnowledgeLiveShadowObservationReceipt, KnowledgeOperationalGateReceipt, KnowledgeProductizationActivationReceipt, KnowledgeRolloutQualificationReceipt } from "../knowledge/productization.ts";
import { canonicalJson, sha256 } from "../runtime/canonical.ts";
import { ensureCompanyKnowledgeSchema } from "./knowledge-migrate.ts";

const connection = () => {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is not set — Knowledge productization evidence uses the existing Company Instance database.");
  return neon(value);
};

const assertPayloadFree = (value: unknown): void => {
  const serialized = canonicalJson(value);
  if (/(?:postgres(?:ql)?:\/\/|(?:sk|ghp|whsec)_[A-Za-z0-9_-]{12,}|password|database_url|secret_value|access_token|refresh_token|\"query\"\s*:|\"excerpt\"\s*:)/i.test(serialized)) {
    throw new Error("Knowledge productization evidence contains a query, excerpt, credential, or secret value.");
  }
};

export class PostgresKnowledgeProductizationStore {
  async recordBenchmark(report: KnowledgeBenchReport): Promise<"inserted" | "unchanged"> {
    const { reportId, ...base } = report;
    if (sha256(base) !== reportId) throw new Error("KnowledgeBench report failed deterministic integrity validation.");
    assertPayloadFree(report);
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`insert into companyos_knowledge.knowledge_benchmark_runs
        (report_id, suite_id, implementation_id, status, sample_size, metrics, gates, failures, case_receipts, report, recorded_at)
      values (${report.reportId}, ${report.suiteId}, ${report.implementationId}, ${report.status}, ${report.sampleSize},
        ${JSON.stringify(report.metrics)}, ${JSON.stringify(report.gates)}, ${JSON.stringify(report.failures)},
        ${JSON.stringify(report.cases)}, ${JSON.stringify(report)}, ${report.recordedAt})
      on conflict (report_id) do nothing returning report_id`;
    return rows.length === 1 ? "inserted" : "unchanged";
  }

  async recordShadowComparison(comparison: KnowledgeBenchComparison): Promise<"inserted" | "unchanged"> {
    const { comparisonId, ...base } = comparison;
    if (sha256(base) !== comparisonId) throw new Error("KnowledgeBench comparison failed deterministic integrity validation.");
    assertPayloadFree(comparison);
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`insert into companyos_knowledge.knowledge_shadow_comparisons
        (comparison_id, baseline_report_id, candidate_report_id, status, deltas, blockers, comparison, compared_at)
      values (${comparison.comparisonId}, ${comparison.baselineReportId}, ${comparison.candidateReportId}, ${comparison.status},
        ${JSON.stringify(comparison.deltas)}, ${JSON.stringify(comparison.blockers)}, ${JSON.stringify(comparison)}, ${comparison.comparedAt})
      on conflict (comparison_id) do nothing returning comparison_id`;
    return rows.length === 1 ? "inserted" : "unchanged";
  }

  async recordQualification(receipt: KnowledgeRolloutQualificationReceipt | KnowledgeLiveShadowObservationReceipt | KnowledgeOperationalGateReceipt | KnowledgeDoctorReport | KnowledgeProductizationActivationReceipt): Promise<"inserted" | "unchanged"> {
    const receiptId = "reportId" in receipt ? receipt.reportId : receipt.receiptId;
    const base = "reportId" in receipt
      ? (({ reportId: _reportId, ...value }) => value)(receipt)
      : (({ receiptId: _receiptId, ...value }) => value)(receipt);
    if (sha256(base) !== receiptId) throw new Error("Knowledge productization receipt failed deterministic integrity validation.");
    assertPayloadFree(receipt);
    // Manifest 1.7.0 deliberately keeps a small immutable receipt-kind enum.
    // Canary, shadow, and operational-gate receipts are environment evidence;
    // their exact subtype remains explicit in the signed receipt payload.
    const receiptKind = "checks" in receipt
      ? "doctor"
      : receipt.status === "qualified-for-explicit-activation"
        ? "activation-qualification"
        : "environment-qualification";
    const recordedAt = "generatedAt" in receipt
      ? receipt.generatedAt
      : "observedAt" in receipt
        ? receipt.observedAt
        : "recordedAt" in receipt
          ? receipt.recordedAt
          : receipt.qualifiedAt;
    const evidenceDigest = "evidenceDigest" in receipt
      ? receipt.evidenceDigest
      : "checks" in receipt
        ? sha256(receipt.checks.map((check) => ({ checkId: check.checkId, status: check.status, evidenceIds: check.evidenceIds })))
        : "comparison" in receipt
          ? sha256({ queryDigest: receipt.queryDigest, authorizationContextDigest: receipt.authorizationContextDigest, comparison: receipt.comparison })
          : sha256(receipt.evidence);
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`insert into companyos_knowledge.knowledge_productization_receipts
        (receipt_id, receipt_kind, status, evidence_digest, receipt, recorded_at)
      values (${receiptId}, ${receiptKind}, ${receipt.status}, ${evidenceDigest}, ${JSON.stringify(receipt)}, ${recordedAt})
      on conflict (receipt_id) do nothing returning receipt_id`;
    return rows.length === 1 ? "inserted" : "unchanged";
  }

  async latestBenchmark(suiteId: string, implementationId: string): Promise<KnowledgeBenchReport | undefined> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select report from companyos_knowledge.knowledge_benchmark_runs
      where suite_id = ${suiteId} and implementation_id = ${implementationId}
      order by recorded_at desc, report_id desc limit 1`;
    return rows[0]?.report as unknown as KnowledgeBenchReport | undefined;
  }
}
