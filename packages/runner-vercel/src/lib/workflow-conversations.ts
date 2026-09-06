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
}
export type WorkflowInboundResult = { kind: "unassigned" } | { kind: "decision"; runId: string; decision: "approved" | "rejected" }
  | { kind: "closed" } | { kind: "conversation"; session: WorkflowConversationSession };

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

  async receive(args: { threadId: string; messageId: string; authorId?: string }): Promise<WorkflowInboundResult> {
    const match = /^slack:([A-Z0-9]{5,32}):(\d+\.\d+)$/.exec(args.threadId);
    if (!match || args.messageId === match[2]) return { kind: "unassigned" };
    const now = this.#args.clock?.() ?? new Date().toISOString(), { store, artifact } = this.#args;
    return this.#args.slack(async (transport) => {
      const accountId = await transport.account(), roster = await this.#args.roster();
      const conversation: WorkflowConversation = { surface: "slack", accountId, channelId: match[1]!, threadId: match[2]! };
      // Reread first when no webhook author hint is available. The hint selects
      // only candidate delivery proof; provider data must independently match it.
      const initial = args.authorId ? undefined : await transport.reply({ conversation, messageId: args.messageId, roster });
      const principal = initial?.principal ?? `slack:${accountId}:${args.authorId}`;
      const qualifiedConversation = { ...conversation, subjectPrincipal: principal };
      const delivered = await store.deliveredAssignment({ instanceId: artifact.instance.id, conversation: qualifiedConversation });
      if (!delivered) return { kind: "unassigned" };
      const reply = initial ?? await transport.reply({ conversation: qualifiedConversation, messageId: args.messageId, roster });
      if (reply.principal !== principal) throw new Error("Workflow reply author differs from the candidate delivery identity");
      const run = await store.read(artifact.instance.id, delivered.runId);
      if (!run) throw new Error("Delivered workflow run is unavailable");
      if (!this.#args.enabledWorkflowIds.includes(run.workflowId)) throw new Error("Workflow conversation is disabled in this Instance");
      const decision = /^(APPROVE|REJECT) ([a-f0-9]{64})$/.exec(reply.text.trim());
      if (decision) {
        const result = await this.#args.engine.decide({ principal, conversation, eventId: reply.eventId, requestId: decision[2]!, decision: decision[1] === "APPROVE" ? "approved" : "rejected" });
        return { kind: "decision", runId: result.runId, decision: decision[1] === "APPROVE" ? "approved" : "rejected" };
      }
      const active = await store.assignment({ instanceId: artifact.instance.id, conversation: qualifiedConversation, now });
      if (!active) return { kind: "closed" };
      const pinned = await store.getArtifact(active.artifactHash), member = findByCanonicalPrincipal(roster, principal);
      const workflow = pinned?.workflows?.find((workflow) => workflow.id === run.workflowId), step = workflow?.steps.find((step) => step.id === run.state.cursor);
      const agent = pinned?.agents.find((agent) => agent.id === workflow?.agentId);
      if (!pinned || !workflow || !step || !agent || !member) throw new Error("Workflow conversation has no exact historical definition");
      const runtime = new CompanyOSRuntime({ artifact: pinned, state: this.#args.control, connectors: await this.#args.connectors(pinned),
        workflowContext: new WorkflowConversationContextReader({ store, instanceId: artifact.instance.id, conversation, subjectPrincipal: principal,
          roster: this.#args.roster, clock: () => this.#args.clock?.() ?? new Date().toISOString() }) });
      return { kind: "conversation", session: { artifact: pinned, agent, runtime, principal, member, conversation, runId: run.runId, stepId: step.id,
        allowedTools: run.state.status === "waiting" ? step.conversationalTools : [], text: reply.text } };
    });
  }
}
