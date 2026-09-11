import { diagnostic } from "./diagnostics.mjs";

// Concrete vendor names are evidence of a possible implementation assumption,
// not proof that the surrounding prose is semantically provider-neutral.
const PROVIDERS = /\b(?:Vercel|Neon|Slack|Telegram|Microsoft Teams|Monday|Anthropic|OpenAI|Claude|Codex|Gemini|Postgres|PostgreSQL|GitHub|AWS|Azure|Supabase)\b|\b(?:VERCEL_[A-Z_]+|SLACK_[A-Z_]+|MONDAY_[A-Z_]+)\b/ig;
export function scopeFindings(document) {
  if (!document.data || document.data.authority === "historical" || document.data.status === "frozen") return [];
  const scope = document.data.implementation_scope ?? "general";
  const file = `docs/${document.relative}`;
  if (!["general", "provider"].includes(scope)) return [{ code: "DOC030", file, text: "Unknown implementation_scope; use general or provider." }];
  if (scope === "provider") {
    if (!Array.isArray(document.data.providers) || !document.data.providers.length) return [{ code: "DOC030", file, text: "Provider documents must declare a non-empty providers list." }];
    return [];
  }
  const findings = [];
  let example = null;
  for (const [index, line] of document.body.split("\n").entries()) {
    if (/^::: implementation-example\s*$/.test(line)) { example = { line: index + 1, linked: false }; continue; }
    if (example) {
      if (/\[[^\]]+\]\([^)]*\.md(?:#[^)]*)?\)/.test(line)) example.linked = true;
      if (/^:::\s*$/.test(line)) {
        if (!example.linked) findings.push({ code: "DOC031", file, text: "Implementation examples must link to their concrete implementation document." });
        example = null;
      }
      continue;
    }
    // References are allowed; vendor assumptions in surrounding prose are not.
    const prose = line.replace(/\[[^\]]+\]\([^)]*\)/g, "");
    if (PROVIDERS.test(prose)) findings.push({ code: "DOC032", file, text: line.trim() });
    PROVIDERS.lastIndex = 0;
  }
  if (example) findings.push({ code: "DOC031", file, text: "Unclosed implementation-example block." });
  return findings;
}
export function inspectDocumentationScopes(documents, baseline = []) {
  // Baseline counts cannot be reused for duplicate new lines in the same page.
  const remaining = new Map();
  for (const entry of baseline) { const key = JSON.stringify(entry); remaining.set(key, (remaining.get(key) ?? 0) + 1); }
  const diagnostics = [];
  for (const finding of documents.flatMap(scopeFindings)) {
    const key = JSON.stringify(finding), count = remaining.get(key) ?? 0;
    if (finding.code === "DOC032" && count > 0) { remaining.set(key, count - 1); continue; }
    diagnostics.push(diagnostic(finding.code, "error", finding.code === "DOC032" ? "Concrete implementation detail in a general document." : finding.text,
      { file: finding.file, hint: "Move implementation details to a scoped implementation document, or use a linked ::: implementation-example block. Do not expand the legacy baseline for new content." }));
  }
  return diagnostics;
}
