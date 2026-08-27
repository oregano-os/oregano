import { scanCredentialIndicators } from "../security/credential-scanner.ts";
import type { SourceEnvelopeV2 } from "./source-contracts-v2.ts";

export type SourceSanitySeverity = "reject" | "quarantine";

export interface SourceSanityFinding {
  code: string;
  severity: SourceSanitySeverity;
}

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous|prior|system)\s+instructions/i,
  /reveal\s+(?:the\s+)?(?:system prompt|secret|credentials?)/i,
  /(?:system|developer)\s+message\s*:/i,
  /do\s+not\s+follow\s+(?:the\s+)?(?:policy|instructions)/i,
];

export function inspectSourceEnvelopeSanity(envelope: SourceEnvelopeV2): SourceSanityFinding[] {
  const findings: SourceSanityFinding[] = [];
  if (envelope.deletionState !== "present") return findings;
  if (!("inlineText" in envelope.content) || envelope.content.inlineText === undefined) {
    return [{ code: "external-asset-content-scan-required", severity: "quarantine" }];
  }
  const text = envelope.content.inlineText;
  if (!text.trim()) findings.push({ code: "empty-content", severity: "reject" });
  if (text.includes("\uFFFD") || text.includes("\0")) findings.push({ code: "invalid-text-encoding", severity: "reject" });
  if (scanCredentialIndicators(text).length > 0) findings.push({ code: "credential-indicator", severity: "quarantine" });
  if (PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(text))) findings.push({ code: "prompt-injection-indicator", severity: "quarantine" });
  const tokens = text.toLocaleLowerCase("en").match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length >= 40 && new Set(tokens).size / tokens.length < 0.08) findings.push({ code: "low-diversity-repetition", severity: "quarantine" });
  if (text.length >= 2_000 && /(.)\1{999,}/s.test(text)) findings.push({ code: "repeated-character-run", severity: "quarantine" });
  return findings.sort((left, right) => left.code.localeCompare(right.code));
}
