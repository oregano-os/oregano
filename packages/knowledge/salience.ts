import { sha256 } from "../runtime/canonical.ts";

export type ProcessingTier = "low" | "medium" | "high";
export type ProcessingFailureClass = "refusal" | "truncated" | "parse-failure" | "provider-failure" | "budget-deferral" | "validation-failure";

export interface ProcessingTriage {
  triageId: string;
  tier: ProcessingTier;
  reasonCodes: string[];
  inputDigest: string;
  status: "decided" | "retryable";
  failureClass?: ProcessingFailureClass;
  retryAfter?: string;
}

export interface RetrievalSalienceSignals {
  relevance: number;
  authority: number;
  freshness: number;
  confidence: number;
  duplication: number;
  contradiction: number;
  sensitivity: number;
  expectedValue: number;
}

export interface RetrievalSalience {
  score: number;
  components: RetrievalSalienceSignals;
  explanation: string[];
}

const bounded = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1.`);
  return value;
};

export function createProcessingTriage(input: {
  inputDigest: string;
  tier?: ProcessingTier;
  reasonCodes?: string[];
  failureClass?: ProcessingFailureClass;
  retryAfter?: string;
}): ProcessingTriage {
  if (!/^[a-f0-9]{64}$/.test(input.inputDigest)) throw new Error("Processing triage requires an input digest.");
  if (input.failureClass) {
    if (input.retryAfter && Number.isNaN(Date.parse(input.retryAfter))) throw new Error("Processing triage retryAfter must be an ISO timestamp.");
    const base = { inputDigest: input.inputDigest, tier: input.tier ?? "medium" as const, reasonCodes: [...new Set(input.reasonCodes ?? [input.failureClass])].sort(), status: "retryable" as const, failureClass: input.failureClass, ...(input.retryAfter ? { retryAfter: new Date(input.retryAfter).toISOString() } : {}) };
    return { triageId: sha256(base), ...base };
  }
  if (!input.tier) throw new Error("Successful processing triage requires a tier.");
  const base = { inputDigest: input.inputDigest, tier: input.tier, reasonCodes: [...new Set(input.reasonCodes ?? [])].sort(), status: "decided" as const };
  return { triageId: sha256(base), ...base };
}

export function computeRetrievalSalience(signals: RetrievalSalienceSignals): RetrievalSalience {
  const values = Object.fromEntries(Object.entries(signals).map(([key, value]) => [key, bounded(value, `Salience ${key}`)])) as unknown as RetrievalSalienceSignals;
  const score = Math.max(0, Math.min(1,
    values.relevance * 0.34 + values.authority * 0.16 + values.freshness * 0.12 + values.confidence * 0.12
    + values.expectedValue * 0.14 + (1 - values.duplication) * 0.05 + (1 - values.contradiction) * 0.04 + (1 - values.sensitivity) * 0.03,
  ));
  const explanation = Object.entries(values).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, value]) => `${name}:${value.toFixed(3)}`);
  return { score: Number(score.toFixed(6)), components: values, explanation };
}

export type DuplicateCascadeDecision =
  | { outcome: "exact-duplicate" | "exact-version"; automatic: true; basis: string }
  | { outcome: "distinct"; automatic: true; basis: string }
  | { outcome: "proposal-required" | "retryable"; automatic: false; basis: string };

export function classifyDuplicateCascade(input: {
  leftIdentity: string;
  rightIdentity: string;
  leftDigest: string;
  rightDigest: string;
  semanticSimilarity?: number;
  modelOutcome?: "distinct" | "duplicate" | "supersedes" | "uncertain";
  modelFailure?: ProcessingFailureClass;
}): DuplicateCascadeDecision {
  if (input.leftIdentity === input.rightIdentity && input.leftDigest === input.rightDigest) return { outcome: "exact-version", automatic: true, basis: "stable-identity-and-content" };
  if (input.leftDigest === input.rightDigest) return { outcome: "exact-duplicate", automatic: true, basis: "content-digest" };
  if (input.semanticSimilarity === undefined || input.semanticSimilarity < 0.72) return { outcome: "distinct", automatic: true, basis: "below-candidate-threshold" };
  if (input.modelFailure) return { outcome: "retryable", automatic: false, basis: input.modelFailure };
  if (input.semanticSimilarity >= 0.93 && input.modelOutcome === "duplicate") return { outcome: "proposal-required", automatic: false, basis: "semantic-and-model-proposal" };
  return { outcome: "proposal-required", automatic: false, basis: input.modelOutcome ? `ambiguous-${input.modelOutcome}` : "ambiguous-band" };
}
