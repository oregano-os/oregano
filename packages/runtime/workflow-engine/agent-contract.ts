import type { JsonSchema, JsonValue } from "../../capabilities/contracts.ts";
import type { CompiledAgent } from "../../companyos-builder/types.ts";
import type { LanguageInstructionEvidence } from "../../language/contracts.ts";
import type { ModelExecutionSelection } from "../../runner/model-execution.ts";
import type { WorkflowAgentResponse, WorkflowAgentTurn } from "../../state-store/workflow-engine.ts";

export const AGENT_SKILL_TOOL = "companyos_read_skill";
export const AGENT_FINISH_TOOL = "companyos_finish_task";
export const agentToolName = (grantId: string): string => grantId.replace(/[^a-zA-Z0-9_]/g, "_");
export const agentCallKey = (turn: number, call: number): string => `agent-call:${turn}:${call}`;
export interface WorkflowAgentRequest {
  agent: CompiledAgent;
  instructions: string[];
  skills?: string[];
  context: JsonValue;
  profile: "utility" | "reasoning" | "deep";
  task: string;
  outputTokens: number;
  outputSchema: JsonSchema;
  tools: Array<{ name: string; description: string; inputSchema: JsonSchema }>;
  turns: WorkflowAgentTurn[];
  beforeDispatch(selection: ModelExecutionSelection, instructions: LanguageInstructionEvidence): Promise<void>;
}
export type WorkflowAgentGenerator = (request: WorkflowAgentRequest) => Promise<{ response: WorkflowAgentResponse; evidence: Record<string, unknown> }>;
