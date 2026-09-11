import type { CompanyOSArtifact, CompiledAgent } from "../companyos-builder/types.ts";
import type { WorkflowConversation, WorkflowExecutionStore } from "../state-store/workflow-engine.ts";
import { findByCanonicalPrincipal, isHumanRosterMember, type RosterMember } from "../state-store/roster.ts";
import { sha256 } from "./canonical.ts";

export interface PublishedConversationContext {
  agent: CompiledAgent;
  member: RosterMember;
  /** Evidence supplied to the model, not workflow execution authority. */
  evidence: {
    kind: "published-conversation";
    snapshot: "as-delivered";
    truncated: boolean;
    messages: Array<{ messageId: string; content: string; format: string; publishedAt: string; runId: string; stepId: string; workflowStatus: string }>;
  };
}

/** The caller must authenticate the incoming conversation and human through its
 * transport before returning this context to a model. Addresses are opaque:
 * no provider SDK, thread syntax, business rule or execution reader belongs here. */
export class PublishedConversationContextReader {
  readonly options: { artifact: CompanyOSArtifact; store: WorkflowExecutionStore; enabledWorkflowIds: readonly string[];
    roster: () => Promise<RosterMember[]>; clock: () => string };
  constructor(options: PublishedConversationContextReader["options"]) { this.options = options; }

  async read(conversation: WorkflowConversation, principal: string): Promise<PublishedConversationContext | undefined> {
    const { artifact, store } = this.options, roster = await this.options.roster();
    const member = findByCanonicalPrincipal(roster, principal);
    if (!member?.id || !isHumanRosterMember(member) || !/^(active|aktiv)$/i.test(member.status)
      || (conversation.subjectPrincipal && conversation.subjectPrincipal !== principal)) throw new Error("Published context requires its authenticated active human");
    const entries = await store.publishedAssignments({ instanceId: artifact.instance.id, conversation: { ...conversation, subjectPrincipal: principal }, now: this.options.clock() });
    let agent: CompiledAgent | undefined, size = 0, truncated = entries.length > 40;
    const messages: PublishedConversationContext["evidence"]["messages"] = [];
    for (const entry of entries) {
      const publication = entry.publication, run = await store.read(artifact.instance.id, entry.runId);
      if (!publication || !run || run.artifactHash !== entry.artifactHash || !this.options.enabledWorkflowIds.includes(run.workflowId)) continue;
      // Do not trust a store implementation to broaden the requested boundary.
      if (entry.instanceId !== artifact.instance.id || entry.surface !== conversation.surface || entry.accountId !== conversation.accountId
        || entry.channelId !== conversation.channelId || entry.threadId !== conversation.threadId || entry.expiresAt <= this.options.clock()
        || (entry.subjectPrincipal && entry.subjectPrincipal !== principal)
        || publication.contentDigest !== sha256({ content: publication.content, format: publication.format })) throw new Error("Published context differs from its exact delivered scope");
      const pinned = await store.getArtifact(entry.artifactHash), workflow = pinned?.workflows?.find((w) => w.id === run.workflowId);
      if (!workflow || workflow.manifestHash !== run.manifestHash || !workflow.steps.some((step) => step.id === entry.stepId)) throw new Error("Publication has no retained owning workflow");
      const currentWorkflow = artifact.workflows?.find((w) => w.id === workflow.id);
      const owner = artifact.agents.find((a) => a.id === workflow.agentId);
      if (!owner || currentWorkflow?.agentId !== owner.id) continue;
      if (agent && agent.id !== owner.id) throw new Error("Published conversation has ambiguous Agent ownership");
      agent = owner;
      if (messages.length === 40 || size + publication.content.length > 80_000) { truncated = true; continue; }
      size += publication.content.length;
      messages.push({ messageId: publication.messageId, content: publication.content, format: publication.format, publishedAt: publication.publishedAt,
        runId: run.runId, stepId: entry.stepId, workflowStatus: run.state.status });
    }
    if (!agent || !messages.length) return undefined;
    return { agent, member, evidence: { kind: "published-conversation", snapshot: "as-delivered", truncated, messages: messages.reverse() } };
  }
}
