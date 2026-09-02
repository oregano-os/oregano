export interface AgentBinding {
  readonly id: string;
  readonly agentId: string;
  readonly surface: string;
  readonly accountId: string;
  readonly channelId: string;
}

export interface CompiledAgentRouting {
  readonly bindings: readonly AgentBinding[];
  readonly handoffs?: readonly AgentHandoffRule[];
  readonly defaultAgentId?: string;
}

export interface AgentHandoffRule {
  readonly id: string;
  readonly fromAgentId: string;
  readonly toAgentId: string;
  readonly purpose: string;
  readonly surfaces: readonly string[];
  readonly eligibleRoles: readonly string[];
  readonly eligibleGroups: readonly string[];
  readonly ttlSeconds: number;
}

export interface ActiveAgentAssignment {
  readonly assignmentId: string;
  readonly agentId: string;
}

export interface AgentResolutionRequest {
  readonly surface: string;
  readonly accountId: string;
  readonly channelId: string;
  readonly assignment?: ActiveAgentAssignment;
}

export interface AgentResolution {
  readonly agentId: string;
  readonly reason: "binding" | "assignment" | "default" | "single-agent";
  readonly bindingId?: string;
  readonly assignmentId?: string;
}

export class AgentResolutionError extends Error {
  readonly code: "unknown-route" | "ambiguous-route" | "invalid-routing";

  constructor(
    code: "unknown-route" | "ambiguous-route" | "invalid-routing",
    message: string,
  ) {
    super(message);
    this.name = "AgentResolutionError";
    this.code = code;
  }
}

export function validateAgentRouting(
  routing: CompiledAgentRouting,
  agentIds: readonly string[],
): void {
  const known = new Set(agentIds);
  if (known.size !== agentIds.length) {
    throw new AgentResolutionError("invalid-routing", "Compiled Agent ids must be unique.");
  }
  if (routing.defaultAgentId && !known.has(routing.defaultAgentId)) {
    throw new AgentResolutionError(
      "invalid-routing",
      `Default Agent '${routing.defaultAgentId}' is not present in the Artifact.`,
    );
  }
  const bindingIds = new Set<string>();
  const routeKeys = new Set<string>();
  for (const binding of routing.bindings) {
    if (!known.has(binding.agentId)) {
      throw new AgentResolutionError(
        "invalid-routing",
        `Agent Binding '${binding.id}' references unknown Agent '${binding.agentId}'.`,
      );
    }
    if (bindingIds.has(binding.id)) {
      throw new AgentResolutionError("invalid-routing", `Duplicate Agent Binding id '${binding.id}'.`);
    }
    bindingIds.add(binding.id);
    const key = routeKey(binding);
    if (routeKeys.has(key)) {
      throw new AgentResolutionError(
        "ambiguous-route",
        `More than one Agent Binding targets ${binding.surface}:${binding.accountId}:${binding.channelId}.`,
      );
    }
    routeKeys.add(key);
  }
  const handoffIds = new Set<string>();
  for (const handoff of routing.handoffs ?? []) {
    if (handoffIds.has(handoff.id)) {
      throw new AgentResolutionError("invalid-routing", `Duplicate Agent handoff id '${handoff.id}'.`);
    }
    handoffIds.add(handoff.id);
    if (!known.has(handoff.fromAgentId) || !known.has(handoff.toAgentId)) {
      throw new AgentResolutionError(
        "invalid-routing",
        `Agent handoff '${handoff.id}' references an Agent that is not present in the Artifact.`,
      );
    }
    if (handoff.fromAgentId === handoff.toAgentId) {
      throw new AgentResolutionError("invalid-routing", `Agent handoff '${handoff.id}' must change the active Agent.`);
    }
    if (!handoff.purpose || handoff.surfaces.length === 0) {
      throw new AgentResolutionError(
        "invalid-routing",
        `Agent handoff '${handoff.id}' requires a purpose and at least one surface.`,
      );
    }
    if (handoff.eligibleRoles.length === 0 && handoff.eligibleGroups.length === 0) {
      throw new AgentResolutionError(
        "invalid-routing",
        `Agent handoff '${handoff.id}' requires at least one eligible role or group.`,
      );
    }
    if (!Number.isSafeInteger(handoff.ttlSeconds) || handoff.ttlSeconds < 60 || handoff.ttlSeconds > 30 * 24 * 60 * 60) {
      throw new AgentResolutionError(
        "invalid-routing",
        `Agent handoff '${handoff.id}' ttlSeconds must be between 60 seconds and 30 days.`,
      );
    }
  }
  if (agentIds.length > 1 && !routing.defaultAgentId && routing.bindings.length === 0) {
    throw new AgentResolutionError(
      "invalid-routing",
      "A multi-agent Artifact requires at least one exact Agent Binding or an explicit default Agent.",
    );
  }
}

export function resolveAgent(
  routing: CompiledAgentRouting,
  agentIds: readonly string[],
  request: AgentResolutionRequest,
): AgentResolution {
  validateAgentRouting(routing, agentIds);
  const matches = routing.bindings.filter((binding) =>
    binding.surface === request.surface
    && binding.accountId === request.accountId
    && binding.channelId === request.channelId);
  if (matches.length > 1) {
    throw new AgentResolutionError(
      "ambiguous-route",
      `Agent route ${request.surface}:${request.accountId}:${request.channelId} is ambiguous.`,
    );
  }
  const matched = matches[0];
  if (matched) {
    return { agentId: matched.agentId, reason: "binding", bindingId: matched.id };
  }
  if (request.assignment) {
    if (!agentIds.includes(request.assignment.agentId)) {
      throw new AgentResolutionError(
        "invalid-routing",
        `Conversation Assignment '${request.assignment.assignmentId}' references unknown Agent '${request.assignment.agentId}'.`,
      );
    }
    return {
      agentId: request.assignment.agentId,
      reason: "assignment",
      assignmentId: request.assignment.assignmentId,
    };
  }
  if (routing.defaultAgentId) {
    return { agentId: routing.defaultAgentId, reason: "default" };
  }
  if (agentIds.length === 1 && agentIds[0]) {
    return { agentId: agentIds[0], reason: "single-agent" };
  }
  throw new AgentResolutionError(
    "unknown-route",
    `No Agent Binding matches ${request.surface}:${request.accountId}:${request.channelId}, and no default Agent is configured.`,
  );
}

function routeKey(binding: Pick<AgentBinding, "surface" | "accountId" | "channelId">): string {
  return `${binding.surface}\u0000${binding.accountId}\u0000${binding.channelId}`;
}
