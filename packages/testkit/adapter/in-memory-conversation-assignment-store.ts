import {
  conversationAssignmentKey,
  type ConversationAssignment,
  type ConversationAssignmentStore,
  type ConversationAssignmentTransition,
  type ConversationAssignmentTransitionResult,
} from "../../state-store/conversation-assignments.ts";

export class InMemoryConversationAssignmentStore implements ConversationAssignmentStore {
  readonly assignments = new Map<string, ConversationAssignment>();
  readonly transitions = new Map<string, ConversationAssignmentTransitionResult>();
  readonly receipts: ConversationAssignmentTransition[] = [];

  async getActive(key: Parameters<ConversationAssignmentStore["getActive"]>[0], now: string) {
    const assignment = this.assignments.get(conversationAssignmentKey(key));
    if (!assignment || Date.parse(assignment.expiresAt) <= Date.parse(now)) return undefined;
    return assignment;
  }

  async applyTransition(transition: ConversationAssignmentTransition): Promise<ConversationAssignmentTransitionResult> {
    const receiptKey = `${transition.key.instanceId}\u0000${transition.transitionKey}`;
    const duplicate = this.transitions.get(receiptKey);
    if (duplicate) return { ...duplicate, outcome: "duplicate" };
    const key = conversationAssignmentKey(transition.key);
    const stored = this.assignments.get(key);
    if (stored && Date.parse(stored.expiresAt) <= Date.parse(transition.occurredAt)) this.assignments.delete(key);
    const current = this.assignments.get(key);
    if (transition.expectedAssignmentId !== current?.assignmentId) return { outcome: "conflict", assignment: current };
    if (transition.nextAssignment) this.assignments.set(key, transition.nextAssignment);
    else this.assignments.delete(key);
    const result: ConversationAssignmentTransitionResult = {
      outcome: "applied",
      assignment: transition.nextAssignment,
    };
    this.transitions.set(receiptKey, result);
    this.receipts.push(transition);
    return result;
  }
}
