import { sha256 } from "./canonical.ts";
import {
  validateAgentRouting,
  type AgentHandoffRule,
  type CompiledAgentRouting,
} from "./agent-resolver.ts";
import {
  type ConversationAssignment,
  type ConversationAssignmentKey,
  type ConversationAssignmentStore,
  type ConversationAssignmentTransitionResult,
} from "../state-store/conversation-assignments.ts";
import { findByCanonicalPrincipal, type RosterMember } from "../state-store/roster.ts";
import { nextLocalDayStartIso } from "./local-time.ts";

export interface AgentHandoffRequest extends ConversationAssignmentKey {
  readonly activeAgentId: string;
  readonly targetAgentId: string;
  readonly purpose: string;
  readonly transitionKey: string;
  readonly artifactHash: string;
  readonly requestedAt: string;
}

export interface AgentReturnRequest extends ConversationAssignmentKey {
  readonly activeAgentId: string;
  readonly transitionKey: string;
  readonly artifactHash: string;
  readonly requestedAt: string;
  readonly reason?: string;
}

export interface WorkflowAgentAssignmentRequest extends AgentHandoffRequest {
  readonly initiatedByPrincipal: string;
}

export interface AgentRevocationRequest extends ConversationAssignmentKey {
  readonly revokedByPrincipal: string;
  readonly transitionKey: string;
  readonly artifactHash: string;
  readonly requestedAt: string;
  readonly reason: string;
}

export interface AgentHandoffServiceConfiguration {
  readonly artifactHash: string;
  readonly routing: CompiledAgentRouting;
  readonly agentIds: readonly string[];
  readonly roster: readonly RosterMember[];
  readonly store: ConversationAssignmentStore;
}

export class AgentHandoffError extends Error {
  readonly code:
    | "stale-artifact"
    | "unknown-principal"
    | "inactive-principal"
    | "agent-identity"
    | "exact-binding"
    | "handoff-not-allowed"
    | "assignment-conflict"
    | "no-active-assignment";

  constructor(code: AgentHandoffError["code"], message: string) {
    super(message);
    this.name = "AgentHandoffError";
    this.code = code;
  }
}

export class AgentHandoffService {
  readonly #configuration: AgentHandoffServiceConfiguration;

  constructor(configuration: AgentHandoffServiceConfiguration) {
    validateAgentRouting(configuration.routing, configuration.agentIds);
    this.#configuration = configuration;
  }

  async activeAssignment(key: ConversationAssignmentKey, now: string): Promise<ConversationAssignment | undefined> {
    return await this.#configuration.store.getActive(key, now);
  }

  async handoff(request: AgentHandoffRequest): Promise<ConversationAssignmentTransitionResult> {
    return await this.#assign(request, request.subjectPrincipal, "allowlisted-agent-handoff");
  }

  /**
   * Creates the same governed assignment for an outbound deterministic
   * Workflow. The service actor is authenticated separately from the human
   * recipient and receives no conversational or Tool authority from this
   * transition.
   */
  async assignFromWorkflow(request: WorkflowAgentAssignmentRequest): Promise<ConversationAssignmentTransitionResult> {
    this.#authorizedWorkflowActor(request.initiatedByPrincipal);
    return await this.#assign(request, request.initiatedByPrincipal, "allowlisted-workflow-initiated-handoff");
  }

  async #assign(
    request: AgentHandoffRequest,
    initiatedByPrincipal: string,
    reason: "allowlisted-agent-handoff" | "allowlisted-workflow-initiated-handoff",
  ): Promise<ConversationAssignmentTransitionResult> {
    this.#assertArtifact(request.artifactHash);
    const member = this.#authorizedMember(request.subjectPrincipal);
    this.#assertNoExactBinding(request);
    const rule = this.#matchingRule(request, member);
    const current = await this.#configuration.store.getActive(request, request.requestedAt);
    if (current?.agentId === request.targetAgentId && current.ruleId === rule.id && current.purpose === rule.purpose) {
      return { outcome: "duplicate", assignment: current };
    }
    if (current && current.agentId !== request.activeAgentId) {
      throw new AgentHandoffError(
        "assignment-conflict",
        `The active Conversation Assignment targets '${current.agentId}', not '${request.activeAgentId}'.`,
      );
    }
    const expiresAt = rule.localDayEndTimeZone
      ? nextLocalDayStartIso(request.requestedAt, rule.localDayEndTimeZone)
      : new Date(Date.parse(request.requestedAt) + rule.ttlSeconds! * 1000).toISOString();
    const assignment: ConversationAssignment = {
      instanceId: request.instanceId,
      surface: request.surface,
      accountId: request.accountId,
      channelId: request.channelId,
      subjectPrincipal: request.subjectPrincipal,
      assignmentId: `ca_${sha256({
        instanceId: request.instanceId,
        transitionKey: request.transitionKey,
        targetAgentId: request.targetAgentId,
      }).slice(0, 32)}`,
      fromAgentId: request.activeAgentId,
      agentId: request.targetAgentId,
      ruleId: rule.id,
      purpose: rule.purpose,
      artifactHash: request.artifactHash,
      assignedAt: request.requestedAt,
      expiresAt,
    };
    const result = await this.#configuration.store.applyTransition({
      transitionKey: request.transitionKey,
      action: "assign",
      key: request,
      expectedAssignmentId: current?.assignmentId,
      nextAssignment: assignment,
      initiatedByPrincipal,
      occurredAt: request.requestedAt,
      evidence: {
        artifactHash: request.artifactHash,
        ruleId: rule.id,
        purpose: rule.purpose,
        reason,
      },
    });
    if (result.outcome === "conflict") {
      throw new AgentHandoffError("assignment-conflict", "The Conversation Assignment changed before the handoff was committed.");
    }
    return result;
  }

  async returnToDefault(request: AgentReturnRequest): Promise<ConversationAssignmentTransitionResult> {
    this.#assertArtifact(request.artifactHash);
    this.#authorizedMember(request.subjectPrincipal);
    const current = await this.#configuration.store.getActive(request, request.requestedAt);
    if (!current) throw new AgentHandoffError("no-active-assignment", "This conversation has no active Agent assignment.");
    if (current.agentId !== request.activeAgentId) {
      throw new AgentHandoffError(
        "assignment-conflict",
        `The active Conversation Assignment targets '${current.agentId}', not '${request.activeAgentId}'.`,
      );
    }
    const result = await this.#configuration.store.applyTransition({
      transitionKey: request.transitionKey,
      action: "return",
      key: request,
      expectedAssignmentId: current.assignmentId,
      initiatedByPrincipal: request.subjectPrincipal,
      occurredAt: request.requestedAt,
      evidence: {
        artifactHash: request.artifactHash,
        ruleId: current.ruleId,
        purpose: current.purpose,
        reason: request.reason?.trim() || "explicit-return-to-deterministic-route",
      },
    });
    if (result.outcome === "conflict") {
      throw new AgentHandoffError("assignment-conflict", "The Conversation Assignment changed before the return was committed.");
    }
    return result;
  }

  async revoke(request: AgentRevocationRequest): Promise<ConversationAssignmentTransitionResult> {
    this.#assertArtifact(request.artifactHash);
    const actor = this.#authorizedMember(request.revokedByPrincipal);
    if (request.revokedByPrincipal !== request.subjectPrincipal && !actor.mayApprove.includes("R2")) {
      throw new AgentHandoffError(
        "handoff-not-allowed",
        "Only the assigned subject or an active R2 approver may revoke this Conversation Assignment.",
      );
    }
    const current = await this.#configuration.store.getActive(request, request.requestedAt);
    if (!current) throw new AgentHandoffError("no-active-assignment", "This conversation has no active Agent assignment.");
    const result = await this.#configuration.store.applyTransition({
      transitionKey: request.transitionKey,
      action: "revoke",
      key: request,
      expectedAssignmentId: current.assignmentId,
      initiatedByPrincipal: request.revokedByPrincipal,
      occurredAt: request.requestedAt,
      evidence: {
        artifactHash: request.artifactHash,
        ruleId: current.ruleId,
        purpose: current.purpose,
        reason: request.reason.trim() || "explicit-assignment-revocation",
      },
    });
    if (result.outcome === "conflict") {
      throw new AgentHandoffError("assignment-conflict", "The Conversation Assignment changed before revocation was committed.");
    }
    return result;
  }

  #assertArtifact(artifactHash: string): void {
    if (artifactHash !== this.#configuration.artifactHash) {
      throw new AgentHandoffError("stale-artifact", "The handoff request was prepared against a different Artifact.");
    }
  }

  #authorizedMember(principal: string): RosterMember {
    const member = findByCanonicalPrincipal([...this.#configuration.roster], principal);
    if (!member) throw new AgentHandoffError("unknown-principal", "The authenticated principal is not in the active roster.");
    if (member.type === "agent" || member.type === "service") throw new AgentHandoffError("agent-identity", "Agent and service identities cannot receive conversational handoffs.");
    if (!/^(active|aktiv)$/i.test(member.status)) {
      throw new AgentHandoffError("inactive-principal", "The authenticated principal is not active in the roster.");
    }
    return member;
  }

  #authorizedWorkflowActor(principal: string): RosterMember {
    const member = findByCanonicalPrincipal([...this.#configuration.roster], principal);
    if (!member) throw new AgentHandoffError("unknown-principal", "The Workflow service principal is not in the active roster.");
    if (!/^(active|aktiv)$/i.test(member.status)) {
      throw new AgentHandoffError("inactive-principal", "The Workflow service principal is not active in the roster.");
    }
    if (member.type !== "agent" && member.type !== "service") {
      throw new AgentHandoffError("agent-identity", "A Workflow-initiated handoff requires an active agent or service identity.");
    }
    return member;
  }

  #assertNoExactBinding(request: Pick<AgentHandoffRequest, "surface" | "accountId" | "channelId">): void {
    const exact = this.#configuration.routing.bindings.find((binding) =>
      binding.surface === request.surface
      && binding.accountId === request.accountId
      && binding.channelId === request.channelId);
    if (exact) {
      throw new AgentHandoffError(
        "exact-binding",
        `Exact Agent Binding '${exact.id}' owns this conversation and cannot be overridden by a handoff.`,
      );
    }
  }

  #matchingRule(request: AgentHandoffRequest, member: RosterMember): AgentHandoffRule {
    const candidates = (this.#configuration.routing.handoffs ?? []).filter((rule) =>
      rule.fromAgentId === request.activeAgentId
      && rule.toAgentId === request.targetAgentId
      && rule.purpose === request.purpose
      && rule.surfaces.includes(request.surface)
      && (rule.eligibleRoles.includes(member.role)
        || (member.groups ?? []).some((group) => rule.eligibleGroups.includes(group))));
    if (candidates.length !== 1) {
      throw new AgentHandoffError(
        "handoff-not-allowed",
        candidates.length === 0
          ? "No compiled handoff rule authorizes this principal, direction, purpose, and surface."
          : "More than one compiled handoff rule matches this request.",
      );
    }
    return candidates[0]!;
  }
}
