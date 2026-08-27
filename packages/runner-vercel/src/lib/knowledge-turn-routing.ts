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

export function requiredKnowledgeToolExecuted(
  route: KnowledgeTurnRoute,
  toolCalls: readonly { readonly toolName: string }[],
): boolean {
  return route.kind === "auto" || toolCalls.some((call) => call.toolName === route.toolName);
}

