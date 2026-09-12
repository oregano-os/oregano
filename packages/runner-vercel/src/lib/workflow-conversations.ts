import { sha256 } from "../../../runtime/canonical.ts";
import { ConversationChoiceService, type ConversationChoiceScope } from "../../../runtime/conversation-choice.ts";
import { subjectDecisionReply, workflowDecisionId } from "../../../runtime/workflow-engine/decision-notice.ts";
import { collectionReviewDelivery } from "./workflow-conversation-presentation.ts";
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
import type { WorkflowAssignment, WorkflowConversation, WorkflowExecutionStore } from "../../../state-store/workflow-engine.ts";
import type { WorkflowSlackScope } from "./workflow-slack.ts";
import { PublishedConversationContextReader, type PublishedConversationContext } from "../../../runtime/published-conversation-context.ts";

export interface WorkflowQuestionChoice extends WorkflowAssignment { collectionStepId: string }

export interface WorkflowConversationSession {
  artifact: CompanyOSArtifact;
  agent: CompiledAgent;
  runtime?: CompanyOSRuntime;
  principal: string;
  member: RosterMember;
  conversation: WorkflowConversation;
  runId: string;
  stepId: string;
  allowedTools: readonly string[];
  text: string;
  publishedContext?: PublishedConversationContext["evidence"];
  collection?: { schema: ReturnType<typeof collectionSchema>; context: JsonValue; submit: (output: JsonValue) => Promise<unknown> };
}
export type WorkflowInboundResult = { kind: "unassigned" } | { kind: "decision"; runId: string; decision: "approved" | "rejected" }
  | { kind: "ambiguous"; conversations: WorkflowAssignment[] } | { kind: "routing"; text: string } | { kind: "closed" } | { kind: "conversation"; session: WorkflowConversationSession };

/** Keep follow-up replies on the delivered question, including after a channel-root answer. */
export function workflowReplyThreadId(session: WorkflowConversationSession): string {
  return `slack:${session.conversation.channelId}:${session.conversation.threadId}`;
}

/** The Slack SDK represents a main-DM message with an empty thread suffix.
 * Use its actual message timestamp to locate that root; do not invent a reply. */
export function workflowInboundThreadId(threadId: string, messageId: string): string {
  return /^slack:D[A-Z0-9]{4,31}:$/.test(threadId) && /^\d+\.\d+$/.test(messageId)
    ? `${threadId}${messageId}` : threadId;
}

/** Shared by verified webhook delivery and operator-triggered provider rereads. Neither can submit an approving principal. */
interface WorkflowConversationHostOptions {
    artifact: CompanyOSArtifact; engine: WorkflowEngine; store: WorkflowExecutionStore; control: StateStore;
    roster: () => Promise<RosterMember[]>; connectors: (artifact: CompanyOSArtifact) => Promise<Connector[]>;
    choices?: ConversationChoiceService<WorkflowQuestionChoice>;
    slack: WorkflowSlackScope; enabledWorkflowIds: readonly string[]; clock?: () => string;
}
export class WorkflowConversationHost {
  readonly #args: WorkflowConversationHostOptions;
  constructor(args: WorkflowConversationHostOptions) { this.#args = args; }
  #published() {
    return new PublishedConversationContextReader({ ...this.#args, clock: () => this.#args.clock?.() ?? new Date().toISOString() });
  }
  async #discussion(conversation: WorkflowConversation, principal: string, text: string): Promise<WorkflowInboundResult> {
    const context = await this.#published().read(conversation, principal);
    if (!context) return { kind: "closed" };
    const latest = context.evidence.messages.at(-1)!;
    return { kind: "conversation", session: { artifact: this.#args.artifact, agent: context.agent, principal, member: context.member,
      conversation, runId: latest.runId, stepId: latest.stepId, allowedTools: [], text, publishedContext: context.evidence } };
  }
  /** Only the Chat SDK's signature-verified action handler may call this entrypoint.
   * It is deliberately not exposed by the bearer-authenticated operator API. */
  async receiveAction(args: { actionId: string; value: string; threadId: string; messageId: string; userId: string; raw: unknown }, onValidated?: (language?: string) => Promise<void>): Promise<Extract<WorkflowInboundResult, { kind: "decision" }>> {
    const match = /^slack:([A-Z0-9]{5,32}):(\d+\.\d+)$/.exec(args.threadId);
    const raw = args.raw as any;
    const option = args.actionId === "companyos.workflow.approve" ? "approved" : args.actionId === "companyos.workflow.reject" ? "rejected" : undefined;
    const actions = Array.isArray(raw?.actions) ? raw.actions.filter((action: any) => action.action_id === args.actionId && action.value === args.value) : [];
    if (!option || !match || (raw?.message?.thread_ts ?? args.messageId) !== match[2] || !/^[a-f0-9]{64}$/.test(args.value)
      || raw?.type !== "block_actions" || raw.user?.id !== args.userId || raw.channel?.id !== match[1]
      || raw.message?.ts !== args.messageId || actions.length !== 1 || !/^\d+\.\d+$/.test(actions[0].action_ts ?? "")) throw new Error("Invalid workflow button event");
    return this.#args.slack(async (transport) => {
      const accountId = await transport.account();
      if (raw.team?.id !== accountId) throw new Error("Workflow button belongs to another installation");
      const principal = await transport.human(accountId, args.userId, await this.#args.roster());
      const conversation: WorkflowConversation = { surface: "slack", accountId, channelId: match[1]!, threadId: match[2]!, ...(args.messageId === match[2] ? {} : { decisionMessageId: args.messageId }), subjectPrincipal: principal };
      const run = await this.#args.engine.decide({ principal, conversation,
        eventId: `slack:${accountId}:${match[1]}:${args.messageId}:${actions[0].action_ts}`,
        requestId: args.value, decision: option }, onValidated);
      return { kind: "decision" as const, runId: run.runId, decision: option };
    });
  }

  #choiceScope(channelId: string, threadId: string, principal: string, accountId: string): ConversationChoiceScope {
    return { instanceId: this.#args.artifact.instance.id, surface: "slack", accountId, channelId, threadId, principal };
  }
  async #choiceTargetActive(target: WorkflowQuestionChoice, now: string): Promise<boolean> {
    const { store, artifact } = this.#args;
    const active = await store.assignment({ instanceId: artifact.instance.id, conversation: target, now });
    if (!active || active.runId !== target.runId || active.stepId !== target.stepId || active.artifactHash !== target.artifactHash) return false;
    const run = await store.read(artifact.instance.id, target.runId);
    if (!run || run.state.cursor !== target.collectionStepId || run.state.status !== "waiting" || run.state.blocked || !run.state.wait || run.state.wait.dueAt <= now || !this.#args.enabledWorkflowIds.includes(run.workflowId)) return false;
    const pinned = await store.getArtifact(run.artifactHash);
    const step = pinned?.workflows?.find((w) => w.id === run.workflowId)?.steps.find((s) => s.id === run.state.cursor);
    return !!step?.collect && step.collect.from === `$steps.${target.stepId}.thread_reference`;
  }
  /** Freeze the displayed order only after independently rereading the original answer. */
  async prepareChoice(args: { threadId: string; messageId: string; authorId?: string }, candidates: WorkflowAssignment[]) {
    if (!this.#args.choices || !args.authorId || !candidates.length) throw new Error("Conversation selection storage is unavailable");
    const choices = this.#args.choices;
    return this.#args.slack(async (transport) => {
      const first = candidates[0]!, accountId = await transport.account();
      const principal = await transport.human(accountId, args.authorId!, await this.#args.roster());
      if (args.threadId !== `slack:${first.channelId}:${args.messageId}` || candidates.some((c) => c.accountId !== accountId || c.subjectPrincipal !== principal || c.channelId !== first.channelId)) throw new Error("Conversation choices cross the verified recipient scope");
      const original = await transport.reply({ conversation: first, messageId: args.messageId, roster: await this.#args.roster(), channelReply: true });
      const scope = this.#choiceScope(first.channelId, args.messageId, principal, accountId);
      const targets = await Promise.all(candidates.map(async (candidate) => ({ ...candidate, collectionStepId: (await this.#args.store.read(this.#args.artifact.instance.id, candidate.runId))?.state.cursor ?? "" })));
      const request = await choices.remember(scope, { messageId: args.messageId, digest: sha256(original) }, targets);
      return { conversations: request.choices, presented: (messageId: string) => choices.presented(scope, messageId) };
    });
  }
  async #choiceReply(args: { threadId: string; messageId: string; authorId?: string }): Promise<WorkflowInboundResult | undefined> {
    const choices = this.#args.choices, match = /^slack:([CDG][A-Z0-9]{4,31}):(\d+\.\d+)$/.exec(args.threadId);
    if (!choices || !match || !args.authorId) return undefined;
    return this.#args.slack(async (transport) => {
      const accountId = await transport.account(), principal = `slack:${accountId}:${args.authorId}`;
      const scope = this.#choiceScope(match[1]!, match[2]!, principal, accountId);
      if (!await choices.read(scope)) return undefined;
      const reply = await transport.reply({ conversation: { surface: "slack", accountId, channelId: match[1]!, threadId: match[2]!, subjectPrincipal: principal }, messageId: args.messageId, roster: await this.#args.roster() });
      const selected = await choices.select(scope, { ...reply, text: reply.text.trim().replace(/^<@[UW][A-Z0-9]+>\s*/, "") }, async (target, request) => {
        if (!await this.#choiceTargetActive(target, this.#args.clock?.() ?? new Date().toISOString())) return false;
        const original = await transport.reply({ conversation: target, messageId: request.source.messageId, roster: await this.#args.roster(), channelReply: true });
        return sha256(original) === request.source.digest;
      });
      if (selected.kind === "unassigned") return undefined;
      if (selected.kind === "invalid") return { kind: "routing", text: "Please reply with the question number, for example ‘Question 2’. I will use your original answer." };
      if (selected.kind === "expired") return { kind: "routing", text: "That question is no longer open, or this selection has expired. Please open the relevant question and reply there." };
      const link = `<https://slack.com/archives/${selected.target.channelId}/p${selected.target.threadId.replace(".", "")}|selected question>`;
      if (selected.kind === "already-selected") return { kind: "routing", text: `Your original answer has already been assigned to the ${link}. Continue there.` };
      const result = await this.receive({ threadId: `slack:${selected.target.channelId}:${selected.target.threadId}`, messageId: selected.request.source.messageId, authorId: args.authorId }, true);
      if (result.kind !== "conversation" || !result.session.collection || result.session.runId !== selected.target.runId || result.session.stepId !== selected.target.collectionStepId || result.session.artifact.artifactHash !== selected.target.artifactHash) return { kind: "routing", text: `That question is no longer waiting for an answer. Please continue in the ${link}.` };
      return result;
    });
  }

  async receiveChannel(args: { threadId: string; messageId: string; authorId?: string }): Promise<WorkflowInboundResult> {
    const match = /^slack:([CDG][A-Z0-9]{4,31}):(\d+\.\d+)$/.exec(args.threadId);
    if (!match || match[2] !== args.messageId || !args.authorId || !/^[UW][A-Z0-9]{4,31}$/.test(args.authorId)) return { kind: "unassigned" };
    const { artifact, store } = this.#args, now = this.#args.clock?.() ?? new Date().toISOString();
    const candidates = await this.#args.slack(async (transport) => {
      const accountId = await transport.account();
      const frozen = await this.#args.choices?.read(this.#choiceScope(match[1]!, args.messageId, `slack:${accountId}:${args.authorId}`, accountId));
      if (frozen) {
        await transport.human(accountId, args.authorId!, await this.#args.roster());
        return frozen.choices; // A retry must never renumber or reroute the original answer.
      }
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
    return this.#receive(args, channelReply);
  }

  /** Migrate an unresolved legacy choice after independently verifying its original answer. */
  async pendingChoiceForCoordinator(args: { threadId: string; authorId: string }): Promise<import("../../../runtime/shared-conversation.ts").PendingConcern | undefined> {
    const match = /^slack:([CDG][A-Z0-9]{4,31}):(\d+\.\d+)$/.exec(args.threadId);
    if (!match || !this.#args.choices) return;
    return this.#args.slack(async transport => {
      const accountId = await transport.account(), roster = await this.#args.roster();
      const principal = await transport.human(accountId, args.authorId, roster);
      const request = await this.#args.choices!.unselected(this.#choiceScope(match[1]!, match[2]!, principal, accountId));
      if (!request || request.choices.some(c => c.channelId !== match[1] || c.accountId !== accountId || c.subjectPrincipal !== principal)) return;
      const original = await transport.reply({ conversation: request.choices[0]!, messageId: request.source.messageId, roster, channelReply: true });
      if (sha256(original) !== request.source.digest) throw new Error("Original clarification answer changed before migration");
      return { source: { messageId: request.source.messageId, eventId: original.eventId, text: original.text,
          address: { surface: "slack", accountId, channelId: match[1]!, threadId: match[2]! } },
        candidates: request.choices.map(c => `workflow:${c.assignmentKey}`), question: "Previously displayed numbered questions, in their original order", expiresAt: request.expiresAt };
    });
  }

  /** Reread the source independently, then resume only the selected delivered work.
   * Routing an excerpt cannot turn ordinary prose into a workflow decision. */
  async receiveSelected(args: { source: { threadId: string; messageId: string; authorId: string }; target: WorkflowAssignment; text?: string; version: string }): Promise<WorkflowInboundResult> {
    const match = /^slack:([CDG][A-Z0-9]{4,31}):(\d+\.\d+)$/.exec(args.source.threadId);
    if (!match || args.target.surface !== "slack" || args.target.channelId !== match[1]) throw new Error("Selected work crosses the verified conversation audience");
    return this.#args.slack(async transport => {
      const accountId = await transport.account(), roster = await this.#args.roster();
      const principal = await transport.human(accountId, args.source.authorId, roster);
      if (accountId !== args.target.accountId || (args.target.subjectPrincipal && args.target.subjectPrincipal !== principal)) throw new Error("Selected work belongs to another recipient");
      const reply = await transport.reply({ conversation: { surface: "slack", accountId, channelId: match[1]!, threadId: args.source.messageId === match[2] ? args.target.threadId : match[2]!, subjectPrincipal: principal },
        messageId: args.source.messageId, roster, channelReply: args.source.messageId === match[2], ...(args.text === undefined ? {} : { representation: "conversation" as const }) });
      // Ordinary routing forwards the verified provider message, never model-authored text.
      // Only a split concern needs an excerpt check, in the same presentation as ingress.
      const text = args.text ?? reply.text;
      if (!text.trim() || (args.text !== undefined && !reply.text.includes(text))) throw new Error("Selected answer is not an excerpt of the provider source");
      return this.#receive({ threadId: `slack:${args.target.channelId}:${args.target.threadId}`, messageId: args.source.messageId, authorId: args.source.authorId }, true,
        { reply: { ...reply, text, eventId: `${reply.eventId}:concern:${sha256({ target: args.target.assignmentKey, text })}` }, version: args.version });
    });
  }

  async #receive(args: { threadId: string; messageId: string; authorId?: string }, channelReply = false,
    selected?: { reply: { text: string; eventId: string; principal: string }; version: string }): Promise<WorkflowInboundResult> {
    const match = /^slack:([A-Z0-9]{5,32}):(\d+\.\d+)$/.exec(args.threadId);
    if (!match || (!selected && args.messageId === match[2])) return { kind: "unassigned" };
    if (!channelReply) { const choice = await this.#choiceReply(args); if (choice) return choice; }
    const now = this.#args.clock?.() ?? new Date().toISOString(), { store, artifact } = this.#args;
    return this.#args.slack(async (transport) => {
      const accountId = await transport.account(), roster = await this.#args.roster();
      const conversation: WorkflowConversation = { surface: "slack", accountId, channelId: match[1]!, threadId: match[2]! };
      // Reread first when no webhook author hint is available. The hint selects
      // only candidate delivery proof; provider data must independently match it.
      const initial = selected?.reply ?? (args.authorId ? undefined : await transport.reply({ conversation, messageId: args.messageId, roster, channelReply }));
      const principal = initial?.principal ?? `slack:${accountId}:${args.authorId}`;
      const qualifiedConversation = { ...conversation, subjectPrincipal: principal };
      const delivered = await store.deliveredAssignment({ instanceId: artifact.instance.id, conversation: qualifiedConversation });
      if (!delivered && !(await store.publishedAssignments({ instanceId: artifact.instance.id, conversation: qualifiedConversation, now })).length) return { kind: "unassigned" };
      const reply = initial ?? await transport.reply({ conversation: qualifiedConversation, messageId: args.messageId, roster, channelReply });
      if (reply.principal !== principal) throw new Error("Workflow reply author differs from the candidate delivery identity");
      if (!delivered) return this.#discussion(qualifiedConversation, principal, reply.text);
      const run = await store.read(artifact.instance.id, delivered.runId);
      if (!run) throw new Error("Delivered workflow run is unavailable");
      if (selected && String(run.revision) !== selected.version) throw new Error("Selected workflow changed before dispatch");
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
      if (!active) return this.#discussion(qualifiedConversation, principal, reply.text);
      const pinned = await store.getArtifact(active.artifactHash), member = findByCanonicalPrincipal(roster, principal);
      const workflow = pinned?.workflows?.find((workflow) => workflow.id === run.workflowId), step = workflow?.steps.find((step) => step.id === run.state.cursor);
      const agent = pinned?.agents.find((agent) => agent.id === workflow?.agentId);
      if (!pinned || !workflow || !step || !agent || !member) throw new Error("Workflow conversation has no exact historical definition");
      if (step.collect && (!run.state.wait || run.state.wait.dueAt <= now)) return { kind: "closed" };
      if (channelReply && (!step.collect || run.state.status !== "waiting" || run.state.blocked))
        return selected ? this.#discussion(qualifiedConversation, principal, reply.text) : { kind: "closed" };
      if (step.collect && active.stepId !== /^\$steps\.([a-z][a-z0-9-]*)\.thread_reference$/.exec(String(step.collect.from))?.[1]) {
        // The coordinator selected this run, but the person answered an earlier
        // question. Only its current delivered collection, in the same audience,
        // can receive that original verified answer. Never guess another run.
        if (selected && run.state.status === "waiting" && !run.state.blocked) {
          const sourceStep = /^\$steps\.([a-z][a-z0-9-]*)\.thread_reference$/.exec(String(step.collect.from))?.[1];
          const assignments = await store.channelAssignments({ instanceId: artifact.instance.id, surface: conversation.surface,
            accountId, channelId: conversation.channelId, subjectPrincipal: principal, now });
          const candidates = assignments.filter(a => a.runId === run.runId && a.artifactHash === run.artifactHash && a.stepId === sourceStep
              && a.subjectPrincipal === principal && a.surface === conversation.surface && a.accountId === accountId
              && a.channelId === conversation.channelId);
          if (assignments.length < 21 && candidates.length === 1) return this.#receive({ ...args, threadId: `slack:${candidates[0]!.channelId}:${candidates[0]!.threadId}` }, true, selected);
        }
        return this.#discussion(qualifiedConversation, principal, reply.text);
      }
      const runtime = new CompanyOSRuntime({ artifact: pinned, state: this.#args.control, connectors: await this.#args.connectors(pinned),
        workflowContext: new WorkflowConversationContextReader({ store, instanceId: artifact.instance.id, conversation, subjectPrincipal: principal,
          roster: this.#args.roster, clock: () => this.#args.clock?.() ?? new Date().toISOString() }) });
      const published = await this.#published().read(qualifiedConversation, principal);
      return { kind: "conversation", session: { artifact: pinned, agent, runtime, principal, member, conversation, runId: run.runId, stepId: step.id,
        allowedTools: run.state.status === "waiting" ? step.conversationalTools : [], text: reply.text,
        ...(published ? { publishedContext: published.evidence } : {}),
        ...(step.collect && run.state.status === "waiting" && !run.state.blocked ? { collection: {
          schema: collectionSchema(step.collect.fields), context: resolveWorkflowValue(step.collect.context, workflow, workflowContext(run, roster)),
          submit: async (output: JsonValue) => { const saved = await this.#args.engine.collect({ principal, conversation: qualifiedConversation, eventId: reply.eventId, output });
            const advanced = await this.#args.engine.advance(saved.runId);
            const reviewDelivery = collectionReviewDelivery(advanced, member.id!, String(resolveWorkflowValue(step.collect!.from, workflow, workflowContext(run, roster))));
            return { collected: true, authorized: false, ...(reviewDelivery ? { reviewDelivery } : {}),
              message: reviewDelivery ? "The review card is already delivered in this conversation. No additional reply is needed. Await the human decision."
                : "Facts recorded. The workflow continues; no change has been authorized." }; },
        } } : {}) } };
    });
  }
}
