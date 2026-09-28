import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input: any) {
  const { task, synthesis, route } = input;
  if (!["reasoning", "deep"].includes(route) || synthesis?.route !== "one-shot" || synthesis.reason !== null || !synthesis.outcome) throw Error("A completed one-shot synthesis is required");
  const outcome = synthesis.outcome;
  if (outcome.source_identity !== task.source.identity || outcome.source_version !== task.source.version
    || !["ingested", "reconciled"].includes(outcome.status)
    || !Array.isArray(outcome.pages) || !outcome.pages.length || !Array.isArray(outcome.receipts) || !outcome.receipts.length
    || outcome.receipts.some((receipt: any) => !["saved", "unchanged"].includes(receipt.status) || !["indexed", "current_head_indexed"].includes(receipt.sync_status))
    || !outcome.indexed_revision) throw Error("One-shot Git and read-back evidence is incomplete");
  return { ...outcome, route };
} });
