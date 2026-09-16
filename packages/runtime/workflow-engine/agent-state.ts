import type { CompiledWorkflowStep } from "../../companyos-builder/workflow-types.ts";
import type { WorkflowStepState } from "../../state-store/workflow-engine.ts";
import { canonicalJson } from "../canonical.ts";
import { AGENT_FINISH_TOOL, isTextCompletion } from "./agent-contract.ts";

/** Append-only conversation evidence. A prepared turn can gain one response and ordered results. */
export function validateAgentState(step: WorkflowStepState, declaration: CompiledWorkflowStep, prior?: WorkflowStepState): void {
  if (!step.agent) { if (prior?.agent) throw new Error("Agent journal cannot be removed"); return; }
  if (!declaration.agent || !Array.isArray(step.agent.turns) || !step.agent.turns.length
    || step.agent.turns.length > declaration.agent.budget.turns) throw new Error("Invalid bounded Agent journal");
  const turns = step.agent.turns, old = prior?.agent?.turns ?? [];
  if (turns.length < old.length || turns.length > old.length + 1) throw new Error("Agent journal advances at most one model turn at a time");
  let calls = 0;
  for (const [index, turn] of turns.entries()) {
    if (!/^language-attempt:[a-f0-9-]{36}$/.test(turn.attemptId) || turns.some((other, i) => i !== index && other.attemptId === turn.attemptId)
      || !Array.isArray(turn.results) || (turn.failure && turn.response)) throw new Error("Invalid Agent turn");
    const before = old[index];
    if (before) {
      if (before.attemptId !== turn.attemptId || (before.response && canonicalJson(before.response) !== canonicalJson(turn.response))
        || (before.failure && canonicalJson(before.failure) !== canonicalJson(turn.failure))) throw new Error("Agent model response is immutable");
      if (turn.results.length < before.results.length || turn.results.length > before.results.length + 1
        || before.results.some((result, i) => canonicalJson(result) !== canonicalJson(turn.results[i]))) throw new Error("Agent Tool results are immutable and ordered");
    } else if (turn.response || turn.failure || turn.results.length) throw new Error("New Agent turn must be prepared before dispatch");
    if (turn.requestBudget && (Object.keys(turn.requestBudget).sort().join(",") !== "inputBytes,outputTokens"
      || !Number.isSafeInteger(turn.requestBudget.inputBytes) || turn.requestBudget.inputBytes < 1
      || !Number.isSafeInteger(turn.requestBudget.outputTokens) || turn.requestBudget.outputTokens < 1
      || turn.requestBudget.outputTokens > declaration.agent.budget.outputTokens)) throw new Error("Invalid Agent budget reservation");
    if (turn.outputTokensUsed !== undefined && (!Number.isSafeInteger(turn.outputTokensUsed) || turn.outputTokensUsed < 0 || !turn.requestBudget)) throw new Error("Invalid Agent output usage");
    if (before?.requestBudget && canonicalJson(before.requestBudget) !== canonicalJson(turn.requestBudget)
      || before?.outputTokensUsed !== undefined && before.outputTokensUsed !== turn.outputTokensUsed) throw new Error("Agent budget evidence is immutable");
    if (!before && (turn.requestBudget || turn.outputTokensUsed !== undefined)) throw new Error("New Agent budget must be prepared before dispatch");
    if (before?.retryAuthorization && canonicalJson(before.retryAuthorization) !== canonicalJson(turn.retryAuthorization)) throw new Error("Agent model retry authorization is immutable");
    if (turn.retryAuthorization) {
      const retry = turn.retryAuthorization;
      if (!turn.failure || turn.response || turn.results.length
        || Object.keys(retry).sort().join(",") !== "authorizedAt,principal,reasonDigest"
        || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/.test(retry.principal) || !/^[a-f0-9]{64}$/.test(retry.reasonDigest)
        || !Number.isFinite(Date.parse(retry.authorizedAt)) || new Date(retry.authorizedAt).toISOString() !== retry.authorizedAt
        || (!before?.retryAuthorization && (!before?.failure || index !== old.length - 1 || turns.length !== old.length))) throw new Error("Invalid explicit Agent model retry proof");
    }
    if (turn.failure && (!['failed', 'unknown'].includes(turn.failure.outcome) || !/^[a-f0-9]{64}$/.test(turn.failure.digest))) throw new Error("Invalid Agent failure evidence");
    if (turn.response) {
      const response = turn.response;
      if (!Array.isArray(response.messages) || !Array.isArray(response.calls) || response.calls.length > 16
        || typeof response.text !== "string" || !["stop", "tool-calls"].includes(response.finishReason)
        || Buffer.byteLength(canonicalJson(response)) > 4 * 1024 * 1024
        || new Set(response.calls.map(call => call.id)).size !== response.calls.length) throw new Error("Invalid Agent model response");
      for (const call of response.calls) if (typeof call.id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(call.id)
        || typeof call.name !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(call.name)) throw new Error("Invalid Agent Tool call identity");
      calls += response.calls.length;
    }
    if (turn.results.length > (turn.response?.calls.length ?? 0)) throw new Error("Agent result has no model Tool call");
    for (const [i, result] of turn.results.entries()) if (result.callId !== turn.response!.calls[i]!.id
      || (result.error === undefined) === (result.output === undefined)
      || (result.error !== undefined && (typeof result.error !== "string" || !result.error.length || result.error.length > 2000))) throw new Error("Invalid Agent Tool result");
    if (index < turns.length - 1 && declaration.agent.completion === "text" && isTextCompletion(turn.response)) throw new Error("Agent cannot advance beyond its final text response");
    if (index < turns.length - 1 && (turn.failure && (turn.failure.outcome === "unknown" || declaration.agent.failurePolicy === "stop") && !turn.retryAuthorization || (!turn.failure && (!turn.response || turn.results.length !== turn.response.calls.length)))) throw new Error("Agent cannot advance beyond an unresolved turn");
  }
  if (calls > declaration.agent.budget.toolCalls) throw new Error("Agent Tool budget exhausted");
  if (step.status === "succeeded") {
    const last = turns.at(-1)!, result = last.results.at(-1)?.output as Record<string, unknown> | undefined;
    if (declaration.agent.completion === "text") {
      const calls = turns.flatMap(turn => turn.results.map((entry, i) => ({ ...turn.response!.calls[i]!, ...entry })));
      if (!isTextCompletion(last.response) || last.results.length || canonicalJson(step.output) !== canonicalJson({ result: { text: last.response!.text }, calls })) throw new Error("Agent task requires its retained final text and Tool journal");
    } else if (last.response?.calls.at(-1)?.name !== AGENT_FINISH_TOOL || result?.accepted !== true || last.results.length !== last.response.calls.length) throw new Error("Agent task requires accepted completion evidence");
  }
}
