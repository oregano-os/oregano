import type { CompiledAgent } from "../../../companyos-builder/types.ts";
import type { ModelTaskProfile } from "../../../runner/model-execution.ts";

export interface AgentModelTask {
  readonly profile: ModelTaskProfile;
  readonly task: string;
  readonly configuration: "shared";
}

/** A declared task belongs to the Agent, including when a workflow assigns it. */
export function agentModelTask(
  agent: Pick<CompiledAgent, "modelTask">,
): AgentModelTask {
  if (agent.modelTask !== undefined) {
    return { profile: "agent", task: agent.modelTask, configuration: "shared" };
  }
  return { profile: "agent", task: "agent.chat", configuration: "shared" };
}
