import type { JsonSchema, JsonValue } from "../../capabilities/contracts.ts";
import type { CompiledWorkflowStep } from "../../companyos-builder/workflow-types.ts";
import type { CompiledAgent } from "../../companyos-builder/types.ts";
import type { LanguageInstructionEvidence } from "../../language/contracts.ts";
import type { ModelExecutionSelection } from "../../runner/model-execution.ts";
import type { WorkflowAgentResponse, WorkflowAgentTurn } from "../../state-store/workflow-engine.ts";

/** Only a known length cutoff may opt into automatic recovery; unknowns remain stopped. */
export function agentFailureNeedsReview(turn: WorkflowAgentTurn, policy: NonNullable<CompiledWorkflowStep["agent"]>["failurePolicy"]): boolean {
  return !!turn.failure && !turn.retryAuthorization && (turn.failure.outcome === "unknown" || policy === "stop"
    || policy === "continue-output-limit" && turn.failure.reason !== "output-limit");
}
export const AGENT_MODEL_TIMEOUT_MS = 360_000;
export const AGENT_HOST_DURATION_MS = 600_000;
export const AGENT_SKILL_TOOL = "companyos_read_skill";
export const AGENT_FINISH_TOOL = "companyos_finish_task";
export const agentToolName = (grantId: string): string => grantId.replace(/[^a-zA-Z0-9_]/g, "_");
export const isTextCompletion = (response: WorkflowAgentResponse | undefined): boolean =>
  response?.finishReason === "stop" && response.calls.length === 0 && response.text.trim().length > 0;
export const agentCallKey = (turn: number, call: number): string => `agent-call:${turn}:${call}`;
export interface WorkflowAgentRequest {
  agent: CompiledAgent;
  instructions: string[];
  skills?: string[];
  context: JsonValue;
  profile: "utility" | "reasoning" | "deep";
  task: string;
  outputTokens: number;
  completion?: "text";
  outputSchema: JsonSchema;
  tools: Array<{ name: string; description: string; inputSchema: JsonSchema }>;
  turns: WorkflowAgentTurn[];
  beforeDispatch(selection: ModelExecutionSelection, instructions: LanguageInstructionEvidence, reservation?: { inputBytes: number; outputTokens: number }): Promise<void>;
}
export type WorkflowAgentGenerator = (request: WorkflowAgentRequest) => Promise<{ response: WorkflowAgentResponse; evidence: Record<string, unknown> }>;
