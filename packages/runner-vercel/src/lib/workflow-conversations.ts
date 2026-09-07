import { subjectDecisionReply, workflowDecisionId } from "../../../runtime/workflow-engine/decision-notice.ts";
import { collectionSchema } from "../../../runtime/workflow-engine/collection.ts";
import { resolveWorkflowValue } from "../../../runtime/workflow-engine/references.ts";
import { workflowContext } from "../../../runtime/workflow-engine/readers.ts";
import type { JsonValue } from "../../../capabilities/contracts.ts";
import type { Connector } from "../../../capabilities/contracts.ts";
import type { CompanyOSArtifact, CompiledAgent } from "../../../companyos-builder/types.ts";
import { CompanyOSRuntime } from "../../../runtime/companyos-runtime.ts";
import { WorkflowEngine } from "../../../runtime/workflow-engine/engine.ts";
import { WorkflowConversationContextReader } from "../../../runtime/workflow-engine/readers.ts";
import type { StateStore } from "../../../state-store/interface.ts";
import { findByCanonicalPrincipal, type RosterMember } from "../../../state-store/roster.ts";
import type { WorkflowConversation, WorkflowExecutionStore } from "../../../state-store/workflow-engine.ts";
import type { WorkflowSlackScope } from "./workflow-slack.ts";

export interface WorkflowConversationSession {
  artifact: CompanyOSArtifact;
  agent: CompiledAgent;
  runtime: CompanyOSRuntime;
  principal: string;
  member: RosterMember;
  conversation: WorkflowConversation;
  runId: string;
  stepId: string;
  allowedTools: readonly string[];
  text: string;
  collection?: { schema: ReturnType<typeof collectionSchema>; context: JsonValue; submit: (output: JsonValue) => Promise<unknown> };
}
export type WorkflowInboundResult = { kind: "unassigned" } | { kind: "decision"; runId: string; decision: "approved" | "rejected" }
  | { kind: "ambiguous"; conversations: WorkflowConversation[] } | { kind: "closed" } | { kind: "conversation"; session: WorkflowConversationSession };

/** Keep follow-up replies on the delivered question, including after a channel-root answer. */
export function workflowReplyThreadId(session: WorkflowConversationSession): string {
  return `slack:${session.conversation.channelId}:${session.conversation.threadId}`;
}

/** Shared by verified webhook delivery and operator-triggered provider rereads. Neither can submit an approving principal. */
interface WorkflowConversationHostOptions {
    artifact: CompanyOSArtifact; engine: WorkflowEngine; store: WorkflowExecutionStore; control: StateStore;
    roster: () => Promise<RosterMember[]>; connectors: (artifact: CompanyOSArtifact) => Promise<Connector[]>;
    slack: WorkflowSlackScope; enabledWorkflowIds: readonly string[]; clock?: () => string;
}
export class WorkflowConversationHost {
  readonly #args: WorkflowConversationHostOptions;
  constructor(args: WorkflowConversationHostOptions) { this.#args = args; }
  /** Only the Chat SDK's signature-verified action handler may call this entrypoint.
   * It is deliberately not exposed by the bearer-authenticated operator API. */
  async receiveAction(args: { actionId: string; value: string; threadId: string; messageId: string; userId: string; raw: unknown }, onValidated?: (language?: string) => Promise<void>): Promise<Extract<WorkflowInboundResult, { kind: "decision" }>> {
    const match = /^slack:([A-Z0-9]{5,32}):(\d+\.\d+)$/.exec(args.threadId);
    const raw = args.raw as any;
    const option = args.actionId === "companyos.workflow.approve" ? "approved" : args.actionId === "companyos.workflow.reject" ? "rejected" : undefined;
    const actions = Array.isArray(raw?.actions) ? raw.actions.filter((action: any) => action.action_id === args.actionId && action.value === args.value) : [];
    if (!option || !match || args.messageId !== match[2] || !/^[a-f0-9]{64}$/.test(args.value)
      || raw?.type !== "block_actions" || raw.user?.id !== args.userId || raw.channel?.id !== match[1]
      || raw.message?.ts !== args.messageId || actions.length !== 1 || !/^\d+\.\d+$/.test(actions[0].action_ts ?? "")) throw new Error("Invalid workflow button event");
    return this.#args.slack(async (transport) => {
      const accountId = await transport.account();
      if (raw.team?.id !== accountId) throw new Error("Workflow button belongs to another installation");
      const principal = await transport.human(accountId, args.userId, await this.#args.roster());
      const conversation: WorkflowConversation = { surface: "slack", accountId, channelId: match[1]!, threadId: match[2]!, subjectPrincipal: principal };
      const run = await this.#args.engine.decide({ principal, conversation,
        eventId: `slack:${accountId}:${match[1]}:${args.messageId}:${actions[0].action_ts}`,
        requestId: args.value, decision: option }, onValidated);
      return { kind: "decision" as const, runId: run.runId, decision: option };
    });
  }

  async receiveChannel(args: { threadId: string; messageId: string; authorId?: string }): Promise<WorkflowInboundResult> {
    const match = /^slack:([CG][A-Z0-9]{4,31}):(\d+\.\d+)$/.exec(args.threadId);
    if (!match || match[2] !== args.messageId || !args.authorId || !/^[UW][A-Z0-9]{4,31}$/.test(args.authorId)) return { kind: "unassigned" };
    const { artifact, store } = this.#args, now = this.#args.clock?.() ?? new Date().toISOString();
    const candidates = await this.#args.slack(async (transport) => {
      const accountId = await transport.account();
      const assignments = await store.channelAssignments({ instanceId: artifact.instance.id, surface: "slack", accountId,
        channelId: match[1]!, subjectPrincipal: `slack:${accountId}:${args.authorId}`, now });
      if (!assignments.length) return [];
      await transport.human(accountId, args.authorId!, await this.#args.roster());
      // Never treat a truncated candidate set as proof of uniqueness.
      if (assignments.length === 21) return assignments;
      const eligible = [];
      for (const assignment of assignments) {
        if (Number(assignment.threadId) >= Number(args.messageId)) continue;
        const run = await store.read(artifact.instance.id, assignment.runId);
        if (!run || run.state.status !== "waiting" || run.state.blocked || !run.state.wait || run.state.wait.dueAt <= now || !this.#args.enabledWorkflowIds.includes(run.workflowId)) continue;
        const pinned = await store.getArtifact(run.artifactHash);
        const step = pinned?.workflows?.find((w) => w.id === run.workflowId)?.steps.find((s) => s.id === run.state.cursor);
        if (step?.collect && step.collect.from === `$steps.${assignment.stepId}.thread_reference`) eligible.push(assignment);
      }
      return eligible;
    });
    if (!candidates.length) return { kind: "unassigned" };
    if (candidates.length !== 1) return { kind: "ambiguous", conversations: candidates.slice(0, 20) };
    const target = candidates[0]!;
    return this.receive({ ...args, threadId: `slack:${target.channelId}:${target.threadId}` }, true);
  }

  async receive(args: { threadId: string; messageId: string; authorId?: string }, channelReply = false): Promise<WorkflowInboundResult> {
    const match = /^slack:([A-Z0-9]{5,32}):(\d+\.\d+)$/.exec(args.threadId);
    if (!match || args.messageId === match[2]) return { kind: "unassigned" };
    const now = this.#args.clock?.() ?? new Date().toISOString(), { store, artifact } = this.#args;
    return this.#args.slack(async (transport) => {
      const accountId = await transport.account(), roster = await this.#args.roster();
      const conversation: WorkflowConversation = { surface: "slack", accountId, channelId: match[1]!, threadId: match[2]! };
      // Reread first when no webhook author hint is available. The hint selects
      // only candidate delivery proof; provider data must independently match it.
      const initial = args.authorId ? undefined : await transport.reply({ conversation, messageId: args.messageId, roster, channelReply });
      const principal = initial?.principal ?? `slack:${accountId}:${args.authorId}`;
      const qualifiedConversation = { ...conversation, subjectPrincipal: principal };
      const delivered = await store.deliveredAssignment({ instanceId: artifact.instance.id, conversation: qualifiedConversation });
      if (!delivered) return { kind: "unassigned" };
      const reply = initial ?? await transport.reply({ conversation: qualifiedConversation, messageId: args.messageId, roster, channelReply });
      if (reply.principal !== principal) throw new Error("Workflow reply author differs from the candidate delivery identity");
      const run = await store.read(artifact.instance.id, delivered.runId);
      if (!run) throw new Error("Delivered workflow run is unavailable");
      if (!this.#args.enabledWorkflowIds.includes(run.workflowId)) throw new Error("Workflow conversation is disabled in this Instance");
      const decision = /^(APPROVE|REJECT) ([a-f0-9]{64})$/.exec(reply.text.trim());
      if (decision && !channelReply) {
        const result = await this.#args.engine.decide({ principal, conversation, eventId: reply.eventId, requestId: decision[2]!, decision: decision[1] === "APPROVE" ? "approved" : "rejected" });
        return { kind: "decision", runId: result.runId, decision: decision[1] === "APPROVE" ? "approved" : "rejected" };
      }
      const deliveredDefinition = await store.getArtifact(run.artifactHash);
      const directDecision = run.state.decisions[delivered.stepId];
      const subjectReply = directDecision && subjectDecisionReply(reply.text, directDecision.role, deliveredDefinition?.language);
      if (subjectReply && !channelReply) {
        const result = await this.#args.engine.decide({ principal, conversation, eventId: reply.eventId,
          requestId: workflowDecisionId(run.runId, delivered.stepId, directDecision.boundDigest), decision: subjectReply });
        return { kind: "decision", runId: result.runId, decision: subjectReply };
      }
      const active = await store.assignment({ instanceId: artifact.instance.id, conversation: qualifiedConversation, now });
      if (!active) return { kind: "closed" };
      const pinned = await store.getArtifact(active.artifactHash), member = findByCanonicalPrincipal(roster, principal);
      const workflow = pinned?.workflows?.find((workflow) => workflow.id === run.workflowId), step = workflow?.steps.find((step) => step.id === run.state.cursor);
      const agent = pinned?.agents.find((agent) => agent.id === workflow?.agentId);
      if (!pinned || !workflow || !step || !agent || !member) throw new Error("Workflow conversation has no exact historical definition");
      if (step.collect && (!run.state.wait || run.state.wait.dueAt <= now)) return { kind: "closed" };
      if (channelReply && (!step.collect || run.state.status !== "waiting" || run.state.blocked)) return { kind: "closed" };
      if (step.collect && active.stepId !== /^\$steps\.([a-z][a-z0-9-]*)\.thread_reference$/.exec(String(step.collect.from))?.[1]) return { kind: "closed" };
      const runtime = new CompanyOSRuntime({ artifact: pinned, state: this.#args.control, connectors: await this.#args.connectors(pinned),
        workflowContext: new WorkflowConversationContextReader({ store, instanceId: artifact.instance.id, conversation, subjectPrincipal: principal,
          roster: this.#args.roster, clock: () => this.#args.clock?.() ?? new Date().toISOString() }) });
      return { kind: "conversation", session: { artifact: pinned, agent, runtime, principal, member, conversation, runId: run.runId, stepId: step.id,
        allowedTools: run.state.status === "waiting" ? step.conversationalTools : [], text: reply.text,
        ...(step.collect && run.state.status === "waiting" && !run.state.blocked ? { collection: {
          schema: collectionSchema(step.collect.fields), context: resolveWorkflowValue(step.collect.context, workflow, workflowContext(run, roster)),
          submit: async (output: JsonValue) => { const saved = await this.#args.engine.collect({ principal, conversation: qualifiedConversation, eventId: reply.eventId, output });
            await this.#args.engine.advance(saved.runId); return { collected: true, authorized: false, message: "Facts recorded. A separate delivered human decision is required before any change." }; },
        } } : {}) } };
    });
  }
}
