import { neon } from "@neondatabase/serverless";
import type { KnowledgeExtractionRun, KnowledgeExtractionRunStore } from "../knowledge/extraction-pipeline.ts";
import { canonicalJson, sha256 } from "../runtime/canonical.ts";
import { ensureCompanyKnowledgeSchema } from "./knowledge-migrate.ts";

const connection = () => {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is not set — extraction runs use the existing Company Instance database.");
  return neon(value);
};

const storedRun = (value: unknown): KnowledgeExtractionRun => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stored extraction run output is malformed.");
  return structuredClone(value) as KnowledgeExtractionRun;
};

export class PostgresKnowledgeExtractionRunStore implements KnowledgeExtractionRunStore {
  async getByRunKey(runKey: string): Promise<KnowledgeExtractionRun | undefined> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select output_manifest from companyos_knowledge.extraction_runs
      where run_key = ${runKey} and status = 'succeeded' limit 1`;
    return rows[0]?.output_manifest ? storedRun(rows[0].output_manifest) : undefined;
  }

  async put(run: KnowledgeExtractionRun): Promise<"inserted" | "unchanged"> {
    await ensureCompanyKnowledgeSchema();
    if (run.status !== "succeeded" || !run.result || run.result.modelReceipts.length === 0) {
      throw new Error("The Postgres extraction run store currently accepts only complete succeeded runs.");
    }
    const primaryReceipt = run.result.modelReceipts[run.result.modelReceipts.length - 1]!;
    const completedAt = primaryReceipt.completedAt;
    const outputManifest = JSON.stringify(run);
    const usageEvidence = JSON.stringify(run.result.modelReceipts.map((receipt) => ({
      receiptId: receipt.receiptId,
      inputTokens: receipt.inputTokens,
      outputTokens: receipt.outputTokens,
      costUsd: receipt.costUsd,
      latencyMs: receipt.latencyMs,
      outcome: receipt.outcome,
    })));
    const rows = await connection()`insert into companyos_knowledge.extraction_runs (
        run_id, run_key, processor_kind, pipeline_version, prompt_version, schema_version,
        model_route, model_id, input_digest, input_manifest, output_digest, output_manifest,
        usage_evidence, authorization_context, access_policy_id, attempt, status, started_at, completed_at)
      values (${run.runId}, ${run.runKey}, 'model', ${run.pipelineVersion}, ${run.promptVersions.join(",")}, ${run.schemaVersion},
        ${primaryReceipt.route}, ${primaryReceipt.model}, ${run.inputDigest},
        ${JSON.stringify({ sourceId: run.result.page.sourceId, sourcePageKey: run.result.page.sourcePageKey,
          sourceObjectVersion: run.result.pageVersion.sourceObjectVersion })},
        ${sha256(run.result)}, ${outputManifest}, ${usageEvidence},
        ${JSON.stringify({ digest: primaryReceipt.authorizationContextDigest })}, ${run.result.page.accessPolicyId},
        1, 'succeeded', ${completedAt}, ${completedAt})
      on conflict (run_key) do update set run_key = excluded.run_key
      where companyos_knowledge.extraction_runs.run_id = excluded.run_id
        and companyos_knowledge.extraction_runs.status = 'succeeded'
        and companyos_knowledge.extraction_runs.input_digest = excluded.input_digest
        and companyos_knowledge.extraction_runs.output_digest = excluded.output_digest
        and companyos_knowledge.extraction_runs.output_manifest = excluded.output_manifest
        and companyos_knowledge.extraction_runs.access_policy_id = excluded.access_policy_id
      returning (xmax = 0) as inserted`;
    if (rows.length === 0) throw new Error(`Extraction run '${run.runKey}' conflicts with existing durable state.`);
    const result = rows[0]?.inserted === true ? "inserted" : "unchanged";
    if (result === "unchanged") {
      const existing = await this.getByRunKey(run.runKey);
      if (!existing || canonicalJson(existing) !== canonicalJson(run)) throw new Error(`Extraction run '${run.runKey}' changed after completion.`);
    }
    return result;
  }
}
