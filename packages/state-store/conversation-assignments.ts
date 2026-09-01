export interface ConversationAssignmentKey {
  readonly instanceId: string;
  readonly surface: string;
  readonly accountId: string;
  readonly channelId: string;
  readonly subjectPrincipal: string;
}

export interface ConversationAssignment extends ConversationAssignmentKey {
  readonly assignmentId: string;
  readonly fromAgentId: string;
  readonly agentId: string;
  readonly ruleId: string;
  readonly purpose: string;
  readonly artifactHash: string;
  readonly assignedAt: string;
  readonly expiresAt: string;
}

export type ConversationAssignmentTransitionAction = "assign" | "return" | "revoke";

export interface ConversationAssignmentTransition {
  readonly transitionKey: string;
  readonly action: ConversationAssignmentTransitionAction;
  readonly key: ConversationAssignmentKey;
  readonly expectedAssignmentId?: string;
  readonly nextAssignment?: ConversationAssignment;
  readonly initiatedByPrincipal: string;
  readonly occurredAt: string;
  readonly evidence: {
    readonly artifactHash: string;
    readonly ruleId?: string;
    readonly purpose?: string;
    readonly reason: string;
  };
}

export interface ConversationAssignmentTransitionResult {
  readonly outcome: "applied" | "duplicate" | "conflict";
  readonly assignment?: ConversationAssignment;
}

/**
 * Company Instance routing state. This boundary deliberately stores no raw
 * message body, model prompt, provider token, or Tool grant.
 */
export interface ConversationAssignmentStore {
  getActive(key: ConversationAssignmentKey, now: string): Promise<ConversationAssignment | undefined>;
  applyTransition(transition: ConversationAssignmentTransition): Promise<ConversationAssignmentTransitionResult>;
}

export function conversationAssignmentKey(key: ConversationAssignmentKey): string {
  return [key.instanceId, key.surface, key.accountId, key.channelId, key.subjectPrincipal].join("\u0000");
}
