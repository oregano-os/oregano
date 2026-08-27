const KNOWLEDGE_SEARCH_GRANT_ID = "oregano:knowledge/search";

export interface RoutedTool {
  readonly grantId: string;
  readonly toolName: string;
}

export type KnowledgeTurnRoute =
  | { readonly kind: "auto" }
  | {
      readonly kind: "required-search";
      readonly grantId: typeof KNOWLEDGE_SEARCH_GRANT_ID;
      readonly toolName: string;
      readonly reason: "explicit-search" | "company-evidence-question";
    };

export interface KnowledgeStepChoice {
  readonly toolChoice: "auto" | { readonly type: "tool"; readonly toolName: string };
  readonly activeTools?: readonly string[];
}

export interface CompletedToolResult {
  readonly toolName: string;
  readonly output: unknown;
}

export interface FailedToolResult {
  readonly toolName: string;
  readonly error: unknown;
}

interface KnowledgeSearchCitation {
  readonly path: string;
  readonly fragment_id: string;
  readonly heading?: string;
}

interface KnowledgeSearchHit {
  readonly excerpt: string;
  readonly citation: KnowledgeSearchCitation;
}

interface KnowledgeSearchOutput {
  readonly query: string;
  readonly hits: readonly KnowledgeSearchHit[];
  readonly gaps?: readonly string[];
  readonly degradations?: readonly string[];
}

const normalize = (value: string): string => value
  .normalize("NFKD")
  .replace(/\p{Diacritic}/gu, "")
  .toLowerCase();

const explicitSearch = /(?:knowledge[\s._:/-]*search|wissenssuche|company[\s-]+knowledge|company[\s-]+brain)/u;
const searchAction = /\b(?:search\w*|lookup|look\s+up|find\w*|durchsuch\w*|such\w*|recherchier\w*)\b/u;
const question = /\b(?:was|welch\w*|wer|wann|wo|what|which|who|when|where)\b/u;
const companyEvidence = /(?:company[\s-]+knowledge|company[\s-]+brain|granola|transkript\w*|transcript\w*|meeting\w*|gesprach\w*|conversation\w*|entscheidung\w*|decision\w*|beschloss\w*|decid\w*|vereinbart\w*|agreed|commitment\w*|projekt\w*|project\w*|research|forschung)/u;

/**
 * Selects the already-granted read-only search Tool for high-confidence
 * Company Knowledge turns. This is turn-level Tool routing, not Agent routing.
 */
export function resolveKnowledgeTurnRoute(input: {
  readonly text: string;
  readonly tools: readonly RoutedTool[];
}): KnowledgeTurnRoute {
  const searchTool = input.tools.find((candidate) => candidate.grantId === KNOWLEDGE_SEARCH_GRANT_ID);
  if (!searchTool) return { kind: "auto" };

  const text = normalize(input.text);
  if (explicitSearch.test(text) && searchAction.test(text)) {
    return {
      kind: "required-search",
      grantId: KNOWLEDGE_SEARCH_GRANT_ID,
      toolName: searchTool.toolName,
      reason: "explicit-search",
    };
  }
  if (question.test(text) && companyEvidence.test(text)) {
    return {
      kind: "required-search",
      grantId: KNOWLEDGE_SEARCH_GRANT_ID,
      toolName: searchTool.toolName,
      reason: "company-evidence-question",
    };
  }
  return { kind: "auto" };
}

/** Requires the selected search Tool only on the first model step. */
export function knowledgeStepChoice(route: KnowledgeTurnRoute, stepNumber: number): KnowledgeStepChoice {
  if (route.kind === "required-search" && stepNumber === 0) {
    return {
      toolChoice: { type: "tool", toolName: route.toolName },
      activeTools: [route.toolName],
    };
  }
  return { toolChoice: "auto" };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function knowledgeToolFailureCode(error: unknown): string {
  const details = record(error);
  const name = error instanceof Error ? error.name : typeof details?.name === "string" ? details.name : "UnknownError";
  const message = error instanceof Error ? error.message : typeof details?.message === "string" ? details.message : "";
  const providerCode = typeof details?.code === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(details.code)
    ? details.code.toLowerCase()
    : undefined;
  const evidence = `${name} ${message}`.toLowerCase();
  if (/abort|deadline|timed?\s*out|timeout/u.test(evidence)) return "execution-timeout";
  if (/invalid.*(?:tool|function).*input|schema|validation/u.test(evidence)) return "invalid-tool-input";
  if (/postgres|database|neon|sql|relation|connection|econn/u.test(evidence)) return providerCode ? `database-${providerCode}` : "database-unavailable";
  if (/connector|capability/u.test(evidence)) return "connector-unavailable";
  if (/isolat|child process|tool sdk|company tool/u.test(evidence)) return "isolated-runtime-failure";
  return providerCode ? `runtime-${providerCode}` : `runtime-${name.replace(/[^A-Za-z0-9_-]/g, "-").toLowerCase()}`;
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function knowledgeSearchOutput(value: unknown): KnowledgeSearchOutput | undefined {
  const runtimeResult = record(value);
  const candidate = record(runtimeResult?.output ?? value);
  if (!candidate || typeof candidate.query !== "string" || !Array.isArray(candidate.hits)) return undefined;
  const hits: KnowledgeSearchHit[] = [];
  for (const valueHit of candidate.hits) {
    const hit = record(valueHit);
    const citation = record(hit?.citation);
    if (!hit || typeof hit.excerpt !== "string" || !citation
      || typeof citation.path !== "string" || typeof citation.fragment_id !== "string") return undefined;
    hits.push({
      excerpt: hit.excerpt,
      citation: {
        path: citation.path,
        fragment_id: citation.fragment_id,
        ...(typeof citation.heading === "string" ? { heading: citation.heading } : {}),
      },
    });
  }
  return {
    query: candidate.query,
    hits,
    ...(stringArray(candidate.gaps) ? { gaps: stringArray(candidate.gaps) } : {}),
    ...(stringArray(candidate.degradations) ? { degradations: stringArray(candidate.degradations) } : {}),
  };
}

const falseToolUnavailableClaim = /(?:keine\s+(?:such|tool)[\w/-]*funktionalit[aä]t|keine\s+registrierten\s+tools|wissenssuche[\s\S]{0,80}\bnicht\s+ausf[uü]hren|(?:cannot|can't|unable to)[\s\S]{0,80}(?:search|tool)|no\s+(?:registered\s+)?tools?\s+(?:are\s+)?available)/iu;

function citesAtLeastOneHit(text: string, hits: readonly KnowledgeSearchHit[]): boolean {
  return hits.some((hit) => text.includes(hit.citation.path) && text.includes(hit.citation.fragment_id));
}

function extractiveKnowledgeResponse(output: KnowledgeSearchOutput): string {
  if (output.hits.length === 0) {
    const diagnostics = [...(output.gaps ?? []), ...(output.degradations ?? [])];
    return [
      `Die Company-Knowledge-Suche nach „${output.query}“ wurde ausgeführt, hat aber keine autorisierten Treffer gefunden.`,
      ...(diagnostics.length > 0 ? [`Hinweise: ${diagnostics.join("; ")}`] : []),
    ].join("\n");
  }
  const hits = output.hits.slice(0, 5).map((hit, index) => {
    const heading = hit.citation.heading ? ` · ${hit.citation.heading}` : "";
    return `${index + 1}. ${hit.excerpt}\n   Quelle: ${hit.citation.path}${heading} · Fragment-ID: ${hit.citation.fragment_id}`;
  });
  return [
    `Die Company-Knowledge-Suche nach „${output.query}“ hat folgende autorisierte Fundstellen geliefert:`,
    "",
    ...hits,
  ].join("\n");
}

/**
 * Enforces a successful, structurally valid search result before a required
 * Knowledge answer can leave the runner. A grounded model answer is retained;
 * otherwise an extractive response is rendered from authorized Tool output.
 */
export function renderKnowledgeTurnResponse(input: {
  readonly route: KnowledgeTurnRoute;
  readonly modelText: string;
  readonly toolResults: readonly CompletedToolResult[];
  readonly toolFailures?: readonly FailedToolResult[];
}): string {
  const modelText = input.modelText.trim();
  if (input.route.kind === "auto") {
    return modelText || "The requested CompanyOS operation was processed. Review any approval card above before an effect can occur.";
  }
  const requiredToolName = input.route.toolName;
  const completed = input.toolResults.find((result) => result.toolName === requiredToolName);
  if (!completed) {
    const failed = input.toolFailures?.find((result) => result.toolName === requiredToolName);
    const code = failed ? knowledgeToolFailureCode(failed.error) : "missing-tool-result";
    return `Die registrierte Company-Knowledge-Suche wurde ausgewählt, aber nicht erfolgreich ausgeführt. Deshalb wurde keine Wissensantwort veröffentlicht. Diagnosecode: ${code}.`;
  }
  const searchOutput = knowledgeSearchOutput(completed.output);
  if (!searchOutput) {
    return "Die Company-Knowledge-Suche wurde ausgeführt, lieferte aber kein gültiges Suchergebnis. Deshalb wurde keine Wissensantwort veröffentlicht.";
  }
  if (searchOutput.hits.length > 0 && modelText && !falseToolUnavailableClaim.test(modelText)
    && citesAtLeastOneHit(modelText, searchOutput.hits)) return modelText;
  return extractiveKnowledgeResponse(searchOutput);
}
