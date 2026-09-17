import type { WorkflowAgentTurn } from "../../state-store/workflow-engine.ts";
import { jsonDigest } from "../canonical.ts";
import { AGENT_FINISH_TOOL } from "./agent-contract.ts";

/** Repeated reads of identical evidence and repeated rejected finishes are not progress. */
export function agentNoProgressTurns(turns: readonly WorkflowAgentTurn[]): number {
  const seen = new Set<string>();
  let idle = 0;
  for (const turn of turns) {
    if (turn.failure?.reason === "output-limit") { idle++; continue; }
    if (!turn.response || turn.results.length !== turn.response.calls.length) continue;
    let progressed = false;
    for (const [i, result] of turn.results.entries()) {
      const call = turn.response.calls[i]!;
      if (result.error !== undefined || call.name === AGENT_FINISH_TOOL) continue;
      const digest = jsonDigest({ name: call.name, input: result.input ?? call.input, output: result.output! });
      if (!seen.has(digest)) { seen.add(digest); progressed = true; }
    }
    idle = progressed ? 0 : idle + 1;
  }
  return idle;
}

export function agentBudgetUsed(turns: readonly WorkflowAgentTurn[]) {
  return turns.reduce((used, turn) => ({
    inputBytes: used.inputBytes + (turn.requestBudget?.inputBytes ?? 0),
    outputTokens: used.outputTokens + (turn.outputTokensUsed ?? turn.requestBudget?.outputTokens ?? 0),
  }), { inputBytes: 0, outputTokens: 0 });
}
