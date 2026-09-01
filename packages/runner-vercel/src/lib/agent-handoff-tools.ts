import { sha256 } from "../../../runtime/canonical.ts";
import type { AgentHandoffService } from "../../../runtime/agent-handoff.ts";
import type { AgentResolution } from "../../../runtime/agent-resolver.ts";
import type { ConversationAssignmentKey } from "../../../state-store/conversation-assignments.ts";

export interface AgentHandoffControlInput {
  readonly action: "handoff" | "return";
  readonly target_agent?: string;
  readonly purpose?: string;
}

export interface AgentHandoffControlContext {
  readonly service: AgentHandoffService;
  readonly assignmentKey: ConversationAssignmentKey;
  readonly activeAgentId: string;
  readonly resolution: AgentResolution;
  readonly artifactHash: string;
  readonly messageId: string;
  readonly now?: () => string;
}

export async function executeAgentHandoffControl(
  input: AgentHandoffControlInput,
  context: AgentHandoffControlContext,
): Promise<Record<string, unknown>> {
  const requestedAt = (context.now ?? (() => new Date().toISOString()))();
  const transitionKey = `agent-handoff:${sha256({
    instanceId: context.assignmentKey.instanceId,
    messageId: context.messageId,
    activeAgentId: context.activeAgentId,
    input,
  })}`;
  if (input.action === "return") {
    if (context.resolution.reason !== "assignment") {
      throw new Error("This conversation is already using its deterministic Agent route.");
    }
    const result = await context.service.returnToDefault({
      ...context.assignmentKey,
      activeAgentId: context.activeAgentId,
      transitionKey,
      artifactHash: context.artifactHash,
      requestedAt,
    });
    return {
      ok: true,
      outcome: result.outcome,
      routeApplies: "next-turn",
      activeAgent: "deterministic-route",
    };
  }
  if (!input.target_agent?.trim() || !input.purpose?.trim()) {
    throw new Error("A handoff requires target_agent and purpose.");
  }
  const result = await context.service.handoff({
    ...context.assignmentKey,
    activeAgentId: context.activeAgentId,
    targetAgentId: input.target_agent,
    purpose: input.purpose,
    transitionKey,
    artifactHash: context.artifactHash,
    requestedAt,
  });
  return {
    ok: true,
    outcome: result.outcome,
    routeApplies: "next-turn",
    activeAgent: result.assignment?.agentId,
    purpose: result.assignment?.purpose,
    expiresAt: result.assignment?.expiresAt,
  };
}
