export const BUILDER_CONFIRMATION_HISTORY_RESPONSE =
  "A Builder confirmation card was posted. The coding agent is waiting for the requester's explicit action.";

const DEFAULT_OPERATION_RESPONSE =
  "The requested CompanyOS operation was processed. Review any approval card above before an effect can occur.";

interface ToolResultLike {
  readonly toolName: string;
  readonly output: unknown;
}

export function builderConfirmationWasPresented(toolResults: readonly ToolResultLike[]): boolean {
  return toolResults.some((result) => {
    if (result.toolName !== "builder_propose_change") return false;
    if (!result.output || typeof result.output !== "object") return false;
    const output = result.output as Record<string, unknown>;
    return output.ok === true
      && output.pendingConfirmation === true
      && output.operation === "builder.propose_change";
  });
}

export function runnerTurnPresentation(
  generatedText: string,
  toolResults: readonly ToolResultLike[],
): { readonly historyResponse: string; readonly visibleResponse?: string } {
  if (builderConfirmationWasPresented(toolResults)) {
    return { historyResponse: BUILDER_CONFIRMATION_HISTORY_RESPONSE };
  }
  const response = generatedText.trim() || DEFAULT_OPERATION_RESPONSE;
  return { historyResponse: response, visibleResponse: response };
}
