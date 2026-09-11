import { CONVERSATION_CONTROL_TOOL, CONVERSATION_PARTICIPATION_INSTRUCTIONS, conversationContext, type ConversationContextEntry } from "../../../runtime/conversation-participation.ts";
import { withConversationParticipation, participationStep } from "./conversation-model-tools.ts";
import { slackParticipation, slackConversationMessage } from "./conversation-participation.ts";
import { boundedConversationHistory, linkConversationDraft, SharedConversationTurn, type CheckedConcern, type ConversationScope } from "../../../runtime/shared-conversation.ts";
import { createPostgresConversationAttentionStore } from "../../../state-postgres/conversation-attention-store.ts";
import { createPostgresConversationWorkSource } from "../../../state-postgres/conversation-work-source.ts";
import { interpretConversation } from "./conversation-coordinator.ts";
import type { WorkflowAssignment } from "../../../state-store/workflow-engine.ts";
import { publishConversationChoice } from "../../../runtime/conversation-choice.ts";
import { retainSlackDecisionReview } from "./slack-decision-review.ts";
import { workflowDmRecipients } from "./slack-workflow-dm-routing.ts";
import { workflowInboundThreadId } from "./workflow-conversations.ts";
import { decisionFeedback } from "../../../runtime/decision-feedback.ts";
import { decisionCard } from "./decision-cards.ts";
import { recordWorkflowButtonResponse } from "./workflow-button-response.ts";
import { randomUUID } from "node:crypto";
import { createSlackAdapter } from "@chat-adapter/slack";
import { connectSlackAdapter } from "@vercel/connect/chat";
import { hasDeliveredCollectionReview } from "./workflow-conversation-presentation.ts";
import { stepCountIs, ToolLoopAgent, generateText, jsonSchema, tool, type ModelMessage, type ToolSet } from "ai";
import { type BuilderTurnIntent } from "../../../runtime/builder/turn-intent.ts";
import { classifyBuilderTurn } from "./builder/turn-intent.ts";
import { builderCurrentRequestKey, type BuilderRequestReference } from "../../../runtime/builder/experience.ts";
import { readBuilderImages } from "../../../runtime/builder/attachments.ts";
import { BUILDER_INTAKE_INSTRUCTIONS } from "../../../runtime/builder/brief.ts";
import { Actions, Button, Card, CardText, Chat, type Author, type Message, type Thread } from "chat";
import { RISK_ORDER, type RiskLevel } from "../../../capabilities/contracts.ts";
import { ArtifactPostgresConnector } from "../../../connectors/artifact-postgres.ts";
import { KnowledgeProviderConnector } from "../../../connectors/knowledge.ts";
import { createUnifiedKnowledgeProvider } from "../../../knowledge/unified-provider.ts";
import { sha256 } from "../../../runtime/canonical.ts";
import { CompanyOSRuntime, type ExecuteToolRequest } from "../../../runtime/companyos-runtime.ts";
import { AgentHandoffService } from "../../../runtime/agent-handoff.ts";
import { PostgresBrainKnowledgeProjectionStore } from "../../../state-postgres/brain-retrieval-store.ts";
import { PostgresKnowledgeAccessAuditor } from "../../../state-postgres/knowledge-access-store.ts";
import { createPostgresKnowledgeCanaryProvider, resolveKnowledgeRetrievalRuntimeSelection } from "../../../state-postgres/knowledge-canary-provider.ts";
import { createPostgresKnowledgeProvider } from "../../../state-postgres/knowledge-store.ts";
import { createPostgresStateStore } from "../../../state-postgres/store.ts";
import { createPostgresConversationAssignmentStore } from "../../../state-postgres/conversation-assignment-store.ts";
import type { ConversationAssignmentStore } from "../../../state-store/conversation-assignments.ts";
import type { RosterMember } from "../../../state-store/roster.ts";
import type { CompanyOSArtifact, CompiledAgent } from "../../../companyos-builder/types.ts";
import type { StateAdapter } from "chat";
import { loadArtifact, resolvedAgentForConversation } from "./artifact.ts";
import type { ResolvedConversationAgent } from "./artifact.ts";
import { continuesInBuilder, executeAgentHandoffControl } from "./agent-handoff-tools.ts";
import {
  createBuilderChatIntegration,
  type BuilderChatIntegration,
} from "./builder/chat-integration.ts";
import { createBuilderCardPresenter } from "./builder/card-presenter.ts";
import { builderProgressCard } from "./builder/action-cards.ts";
import type { BuilderJob } from "../../../state-store/builder-jobs.ts";
import { createBuilderReleaseRuntime } from "./builder/release-provider.ts";
import { createBuilderChatNotifier } from "./builder/chat-notifier.ts";
import { findActiveHumanRosterMember } from "./identity.ts";
import { createPostgresChatState } from "./postgres-chat-state.ts";
import { modelExecutionEvidence, resolveModelExecution } from "./model-execution.ts";
import {
  knowledgeStepChoice,
  renderKnowledgeTurnResponse,
  resolveKnowledgeTurnRoute,
} from "./knowledge-turn-routing.ts";
import { agentModelTask } from "./agent-model-task.ts";
import { agentInstructionMessages } from "./agent-instructions.ts";
import { COLLECTION_TOOL_DESCRIPTION } from "../../../runtime/workflow-engine/collection.ts";
import { setupVerificationPrompt, setupVerificationResponse, setupExchangeKey, type SetupExchange } from "./setup-verification.ts";
import {
  abortRememberedSlackAgentSessionConversation,
  createSlackToolProgressReporter,
  coordinatorSlackMessage,
  rememberSlackAgentSessionConversation,
  resolveSlackAgentExperience,
  resolveSlackAgentSessionThreadId,
  resolveSlackTurnAbortSignal,
  shouldStreamSlackAgentResponse,
  showSlackAgentWorking,
  withSlackAgentWorking,
  toolResultNeedsHumanInput,
  validatedSlackResponsePlan,
  type SlackAgentExperienceConfiguration,
} from "./slack-agent-experience.ts";
import { decodeModelRuntimeConfiguration, type ModelExecutionEvidence } from "../../../runner/model-execution.ts";
import { createConfiguredRuntimeConnectors } from "./runtime-connectors.ts";
import { workflowHostingEnabled } from "./workflow-configuration.ts";
import { workflowReplyThreadId, type WorkflowConversationSession } from "./workflow-conversations.ts";
import type { BeforeSlackDirectPublish } from "../../../connectors/slack/communication.ts";

const DAY = 24 * 60 * 60 * 1000;
const TOOL_EXECUTION_TIMEOUT_MS = 30_000;
let state: StateAdapter;
let artifact: CompanyOSArtifact;
let runtime: CompanyOSRuntime;
let builderChat: BuilderChatIntegration;
let builderRelease: ReturnType<typeof createBuilderReleaseRuntime>;
let assignmentStore: ConversationAssignmentStore;
let handoffService: AgentHandoffService;
let slackAgentExperience: SlackAgentExperienceConfiguration;

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

interface ConversationEntry extends ConversationContextEntry {
  role: "user" | "assistant";
  content: string;
  model_execution?: ModelExecutionEvidence;
  message_id?: string;
  in_reply_to?: string;
  principal?: string;
  artifact_hash?: string;
}

interface PendingApproval extends ExecuteToolRequest {
  risk: RiskLevel;
  toolLabel: string;
  requestedBy: string;
}

interface PendingConfirmation extends ExecuteToolRequest {
  toolLabel: string;
  requestedBy: string;
}

function rosterMember(author: Author): RosterMember | undefined {
  return findActiveHumanRosterMember(artifact.roster, author);
}

function principal(member: RosterMember): string {
  const canonical = member.principals?.find((value) => value.startsWith("slack:"));
  if (canonical) return canonical;
  if (member.teamId && member.userId) return `slack:${member.teamId}:${member.userId}`;
  throw new Error(`Roster member '${member.name}' has no canonical Slack principal.`);
}

function toolName(grantId: string): string {
  return grantId.replace(/[^a-zA-Z0-9_]/g, "_");
}

function compact(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 1400 ? `${text.slice(0, 1400)}…` : text;
}

function resolvedTools(
  agent: CompiledAgent,
  thread: Thread,
  requester: string,
  runId: string,
  messageId: string,
  conversation: ResolvedConversationAgent,
  visibleGrantIds: ReadonlySet<string>,
  workflowSession?: WorkflowConversationSession,
  builderIntent?: BuilderTurnIntent,
): ToolSet {
  const selectedRuntime = workflowSession?.runtime ?? runtime;
  const output: ToolSet = {};
  for (const resolved of agent.toolSet.tools) {
    if (!visibleGrantIds.has(resolved.grantId)) continue;
    const compiled = agent.tools.find((candidate) => candidate.contract.runtimeId === resolved.runtimeId);
    if (!compiled) throw new Error(`Resolved Tool '${resolved.runtimeId}' has no compiled implementation.`);
    const name = toolName(resolved.grantId);
    if (output[name]) throw new Error(`Tool name collision for '${name}'.`);
    output[name] = tool({
      description: `${compiled.contract.description} Effective risk: ${resolved.risk}. ${RISK_ORDER[resolved.risk] >= RISK_ORDER.R3 ? "A human approval card is required before execution." : "Executes immediately through CompanyOS controls."}`,
      inputSchema: jsonSchema(compiled.contract.inputSchema),
      execute: async (input: unknown) => {
        const request = {
          runId,
          stepId: workflowSession?.stepId ?? `${messageId}:${name}`,
          agentId: agent.id,
          grantId: resolved.grantId,
          input,
          subjectPrincipal: requester,
        };
        if (compiled.contract.confirmation === "subject") {
          const token = randomUUID();
          const pending: PendingConfirmation = { ...request, toolLabel: resolved.grantId, requestedBy: requester };
          await state.set(`confirmation:${token}`, pending, DAY);
          await thread.post(Card({
            title: "Confirm reversible change",
            children: [
              CardText(`Action: ${resolved.grantId}`),
              CardText(`Exact input hash: ${sha256(input)}`),
              CardText(`Requested for: ${requester}`),
              CardText(`Input preview: ${compact(input)}`),
              Actions([
                Button({ id: "companyos.confirm", label: "Confirm", style: "primary", value: token }),
                Button({ id: "companyos.cancel-confirmation", label: "Cancel", style: "danger", value: token }),
              ]),
            ],
          }));
          return { ok: true, pendingConfirmation: true, inputHash: sha256(input) };
        }
        if (RISK_ORDER[resolved.risk] < RISK_ORDER.R3) return await selectedRuntime.execute(request);
        const approval = await selectedRuntime.requestApproval(request);
        const token = randomUUID();
        const pending: PendingApproval = {
          ...request,
          risk: resolved.risk,
          toolLabel: resolved.grantId,
          requestedBy: requester,
        };
        await state.set(`approval:${token}`, pending, DAY);
        await thread.post(decisionCard({
          title: `CompanyOS approval · ${resolved.risk}`,
          content: [`Action: ${resolved.grantId}`, `Exact input hash: ${approval.inputHash}`,
            `Requested by: ${requester}`, `Input preview: ${compact(input)}`].join("\n\n"),
          value: token, approve: { id: "companyos.approve", label: "Approve" }, reject: { id: "companyos.reject", label: "Reject" },
        }));
        return { ok: true, pendingApproval: true, requestId: approval.requestId, inputHash: approval.inputHash };
      },
    });
  }
  if (workflowSession?.collection) {
    const collection = workflowSession.collection;
    output.companyos_collect_facts = tool({ description: COLLECTION_TOOL_DESCRIPTION,
      inputSchema: jsonSchema(collection.schema), execute: async (input: unknown) => collection.submit(input as import("../../../capabilities/contracts.ts").JsonValue) });
  }
  if (workflowSession) return output;
  const hasOutgoingHandoff = (artifact.agentRouting.handoffs ?? [])
    .some((rule) => rule.fromAgentId === agent.id && rule.surfaces.includes(conversation.assignmentKey.surface));
  if (!agent.conversationCoordinator && (hasOutgoingHandoff || conversation.resolution.reason === "assignment")) {
    output.companyos_agent_handoff = tool({
      description: "Request an allowlisted CompanyOS Agent handoff for this authenticated conversation, or return to its deterministic route. A handoff to Builder continues the current human request immediately so the human need not repeat it. Other handoffs apply next turn. No Tool grants are copied.",
      inputSchema: jsonSchema({
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["handoff", "return"] },
          target_agent: { type: "string", minLength: 1, maxLength: 128 },
          purpose: { type: "string", minLength: 1, maxLength: 128 },
        },
      }),
      execute: async (input: unknown) => await executeAgentHandoffControl(
        input as { action: "handoff" | "return"; target_agent?: string; purpose?: string },
        {
          service: handoffService,
          assignmentKey: conversation.assignmentKey,
          activeAgentId: agent.id,
          resolution: conversation.resolution,
          artifactHash: artifact.artifactHash,
          messageId,
          continueBuilderInTurn: agent.id !== "builder",
        },
      ),
    });
  }
  Object.assign(output, builderChat.proposalTools({ agent, thread, requester, messageId, intent: builderIntent }));
  return output;
}

/** Explicit operator recovery of an existing reply; never a synthetic inbound webhook. */
export async function recoverHostedWorkflowReply(reference: { threadId: string; messageId: string; authorId?: string }) {
  if (!workflowHostingEnabled()) throw new Error("Workflow recovery is disabled in this Instance");
  const bot = getBot();
  const { createWorkflowHost } = await import("./workflow-host.ts");
  const { recoverWorkflowReply } = await import("./workflow-reply-recovery.ts");
  const host = await createWorkflowHost();
  const referenceDigest = sha256(reference);
  const result = await recoverWorkflowReply(reference, {
    receive: (input) => input.authorId !== undefined && input.threadId.endsWith(`:${input.messageId}`)
      ? host.conversations.receiveChannel(input) : host.conversations.receive(input),
    dispatch: async (message) => {
      console.info(JSON.stringify({ event: "workflow.reply-recovery.dispatch", referenceDigest }));
      await bot.initialize();
      // Reuse verification, duplicate claims, historical Agent/Tool selection,
      // collection and governed output from the ordinary conversation path.
      await handleMessage(bot.thread(reference.threadId), message);
    },
  });
  console.info(JSON.stringify({ event: "workflow.reply-recovery.completed", referenceDigest, kind: result.kind,
    dispatchCompleted: result.dispatchCompleted }));
  return result;
}

async function handleMessage(thread: Thread, message: Pick<Message, "id" | "text" | "author" | "metadata"> & Partial<Pick<Message, "attachments" | "isMention">>, builderContinuation = false) {
  const { workflowSlackMessageTrace } = await import("./workflow-slack-diagnostics.ts");
  const trace = workflowSlackMessageTrace(thread.id, message.id);
  trace.emit("handler-entered");
  try {
    await processConversationMessage(thread, message, trace, undefined, builderContinuation);
    trace.emit("handler-finished");
  } catch (error) { trace.emit("handler-failed"); throw error; }
}

interface CoordinatedTurn { agent: CompiledAgent; session?: WorkflowConversationSession; concern: CheckedConcern; }

/** The Slack adapter only translates verified addresses. Interpretation and state are shared Core. */
async function coordinateConversation(thread: Thread, message: Pick<Message, "id" | "text" | "author" | "metadata"> & Partial<Pick<Message, "attachments" | "isMention">>, trace: import("./workflow-slack-diagnostics.ts").WorkflowSlackTrace): Promise<boolean> {
  const member = rosterMember(message.author);
  if (!member) return false;
  const requester = principal(member);
  const entry = await resolvedAgentForConversation({ threadId: thread.id, requesterPrincipal: requester });
  if (!entry.agent.conversationCoordinator) return false;
  const sourceThread = workflowInboundThreadId(thread.id, message.id);
  const [, channelId, threadId] = sourceThread.split(":");
  if (!channelId || !threadId) throw new Error("Conversation source has no verified thread identity");
  const workingThread = botInstance!.thread(resolveSlackAgentSessionThreadId(thread.id, message.id, slackAgentExperience));
  const incoming = slackConversationMessage(thread, message, { id: requester, name: member.name });
  const ambient = incoming.shared && !incoming.mentioned;
  return withSlackAgentWorking(workingThread, ambient ? { ...slackAgentExperience, enabled: false } : slackAgentExperience, async finishWorking => {
  const scope: ConversationScope = { instanceId: artifact.instance.id, principal: requester, surface: "slack", accountId: entry.assignmentKey.accountId, channelId };
  const source = createPostgresConversationWorkSource(artifact);
  source.history = async (verifiedScope, address, agentId) => {
    if (address.surface !== verifiedScope.surface || address.accountId !== verifiedScope.accountId || address.channelId !== verifiedScope.channelId)
      throw new Error("Conversation history crosses the verified audience");
    return state.getList<ConversationEntry>(`conversation:slack:${address.channelId}:${address.threadId}:${agentId}`);
  };
  const verifiedPending = workflowHostingEnabled() && message.id !== threadId
    ? await (await (await import("./workflow-host.ts")).createWorkflowHost()).conversations.pendingChoiceForCoordinator({ threadId: sourceThread, authorId: message.author.userId })
    : undefined;
  const turn = await SharedConversationTurn.open({ scope, verifiedPending, input: { eventId: `${sourceThread}:${message.id}`, messageId: message.id,
    text: message.text, message: incoming, address: { surface: "slack", accountId: scope.accountId, channelId, threadId } },
    coordinatorId: entry.agent.id, source, store: createPostgresConversationAttentionStore(), now: new Date().toISOString(),
    authorize: async (agentId, purpose) => handoffService.authorizeConcern({ ...entry.assignmentKey,
      activeAgentId: entry.agent.id, targetAgentId: agentId, purpose, artifactHash: artifact.artifactHash, requestedAt: new Date().toISOString() }),
  });
  const specialists = (artifact.agentRouting.handoffs ?? []).filter(r => r.fromAgentId === entry.agent.id && r.surfaces.includes("slack")
    && (r.eligibleRoles.includes(member.role) || member.groups?.some(g => r.eligibleGroups.includes(g))))
    .map(r => ({ agentId: r.toAgentId, purpose: r.purpose, description: artifact.agents.find(a => a.id === r.toAgentId)?.description }));
  const { receipt, modelEvidence } = await interpretConversation({ turn, agent: entry.agent, specialists, signal: thread.signal });
  const routeKey = `conversation-dispatch:${sha256({ scope, eventId: turn.input.eventId })}`;
  if (await state.get(`${routeKey}:complete`)) return true;
  if (!await state.setIfNotExists(`${routeKey}:delivery-claim`, { eventId: turn.input.eventId, claimedAt: new Date().toISOString() }, 30 * DAY)) return true;
  if (modelEvidence) await state.set(`${routeKey}:model`, modelEvidence, 30 * DAY);
  const replyThread = botInstance!.thread(sourceThread);
  await replyThread.subscribe();
  if (receipt.plan.participation === "context-only") {
    await state.appendToList(`conversation:${sourceThread}:${entry.agent.id}`, { role: "user", content: message.text,
      message_id: message.id, principal: requester, sender_name: member.name, sent_at: incoming.sentAt } satisfies ConversationEntry, { maxLength: 40, ttlMs: 30 * DAY });
    await state.set(`${routeKey}:complete`, true, 30 * DAY);
    return true;
  }
  if (receipt.plan.clarify || !receipt.concerns.length) {
    await (receipt.plan.clarify ? replyThread : workingThread).post(coordinatorSlackMessage(receipt.plan.clarify?.question ?? receipt.plan.reply));
  } else {
    // Each selected Agent owns its own status, including suspended approvals.
    // Finish the coordinator first so its cleanup cannot reset that later state.
    await finishWorking();
    for (const [index, concern] of receipt.concerns.entries()) {
      if (await state.get(`${routeKey}:${index}:complete`)) continue;
      let session: WorkflowConversationSession | undefined;
      let selected = artifact.agents.find(a => a.id === concern.agentId);
      if (!selected) throw new Error("Selected Agent is no longer available");
      if (concern.delegation) handoffService.authorizeConcern({ ...entry.assignmentKey, activeAgentId: entry.agent.id,
        targetAgentId: concern.agentId, purpose: receipt.plan.routes[index]?.purpose ?? turn.attention.drafts.find(d => d.id === concern.work?.id)?.purpose ?? "",
        artifactHash: artifact.artifactHash, requestedAt: new Date().toISOString() });
      if (concern.work?.kind === "workflow") {
        const current = await source.read(scope, concern.work.id);
        if (!current || current.version !== concern.work.version) throw new Error("Selected work changed; please reply in its original thread");
        const { createWorkflowHost } = await import("./workflow-host.ts");
        const host = await createWorkflowHost();
        const result = await host.conversations.receiveSelected({ source: { threadId: `slack:${concern.source.address.channelId}:${concern.source.address.threadId}`,
          messageId: concern.source.messageId, authorId: message.author.userId }, target: (current.context as { assignment: WorkflowAssignment }).assignment,
          text: concern.text, version: current.version });
        if (result.kind !== "conversation") throw new Error("The selected workflow is no longer available for this reply");
        session = result.session; selected = session.agent;
      }
      if (concern.work?.kind === "builder") {
        const current = await source.read(scope, concern.work.id);
        if (!current) throw new Error("The selected job is no longer accessible");
        concern.work = { ...current, context: JSON.stringify(current.context).slice(0, 10000) };
      }
      const destination = concern.work?.address ?? turn.input.address;
      const target = concern.work ? botInstance!.thread(`slack:${destination.channelId}:${destination.threadId}`) : thread;
      await target.subscribe();
      if (concern.needsAcknowledgement && !await state.get(`${routeKey}:${index}:ack`)) {
        const link = `https://slack.com/archives/${destination.channelId}/p${destination.threadId.replace(".", "")}`;
        const title = concern.work!.title.replace(/[\\[\]<>]/g, " ");
        await replyThread.post(coordinatorSlackMessage(`${receipt.plan.reply || "I have assigned your answer to the matching conversation."}\n\nContinue here: [${title}](${link}).`));
        await state.set(`${routeKey}:${index}:ack`, true, 30 * DAY);
      }
      await state.set(`${routeKey}:${index}:status`, { state: "running", workId: concern.work?.id, agentId: concern.agentId, at: new Date().toISOString() }, 30 * DAY);
      try {
        await processConversationMessage(target, { ...message, id: concern.source.messageId, text: concern.text }, trace, { agent: selected, session, concern });
        await state.set(`${routeKey}:${index}:complete`, true, 30 * DAY);
        await state.set(`${routeKey}:${index}:status`, { state: "completed", workId: concern.work?.id, agentId: concern.agentId, at: new Date().toISOString() }, 30 * DAY);
      } catch (error) {
        await state.set(`${routeKey}:${index}:status`, { state: "failed", reference: sha256(String(error)), at: new Date().toISOString() }, 30 * DAY);
        throw error;
      }
    }
  }
  await state.set(`${routeKey}:complete`, true, 30 * DAY);
  return true;
  });
}

async function processConversationMessage(thread: Thread, message: Pick<Message, "id" | "text" | "author" | "metadata"> & Partial<Pick<Message, "attachments" | "isMention">>,
  trace: import("./workflow-slack-diagnostics.ts").WorkflowSlackTrace, coordinated?: CoordinatedTurn, builderContinuation = false) {
  const incomingMember = rosterMember(message.author);
  const incoming = incomingMember ? slackConversationMessage(thread, message, { id: principal(incomingMember), name: incomingMember.name }) : undefined;
  if (!builderContinuation && !coordinated && await builderRelease?.receive({ conversation: thread.id, author: message.author, participation: incoming,
    messageId: message.id, text: message.text, occurredAt: message.metadata.dateSent.toISOString() })) return;
  if (!builderContinuation && !coordinated && !setupVerificationResponse(message.text)) {
    try { if (await coordinateConversation(thread, message, trace)) return; }
    catch (error) {
      if (thread.isDM || message.isMention) await thread.post("I could not safely match or process this message. Please try again; your existing work remains available.");
      throw error;
    }
  }
  let workflowSession: WorkflowConversationSession | undefined = coordinated?.session;
  let workflowNotice: string | undefined;
  const entryAgent = !coordinated && incomingMember ? (await resolvedAgentForConversation({ threadId: thread.id, requesterPrincipal: principal(incomingMember), assignmentStore })).agent : undefined;
  if (!builderContinuation && !coordinated && entryAgent?.id !== "builder" && workflowHostingEnabled()) {
    try {
      const { createWorkflowHost } = await import("./workflow-host.ts");
      const host = await createWorkflowHost();
      const input = { threadId: workflowInboundThreadId(thread.id, message.id), messageId: message.id, authorId: message.author.userId };
      const received = input.threadId.endsWith(`:${message.id}`)
        ? await host.conversations.receiveChannel(input) : await host.conversations.receive(input);
      trace.emit("assignment", received.kind);
      if (received.kind === "ambiguous" && !thread.isDM && !message.isMention) {
        workflowNotice = "Several workflow questions are waiting. If this message asks you to act on one, ask the sender to continue in that question’s original thread. Team discussion alone needs no response.";
      } else if (received.kind === "ambiguous") {
        const choice = await host.conversations.prepareChoice(input, received.conversations);
        const links = choice.conversations.map((c, index) => `<https://slack.com/archives/${c.channelId}/p${c.threadId.replace(".", "")}|Question ${index + 1}>`).join(" · ");
        await publishConversationChoice({ conversationId: input.threadId, inbound: thread, resolve: (id) => botInstance!.thread(id),
          content: `Several questions are open for you. Which question does your answer belong to? Reply here with the number (for example “Question 2”), and I will use your original answer. You can also open the matching question: ${links}`,
          recordPublication: choice.presented });
        trace.emit("reply-posted");
        return;
      }
      if (received.kind === "routing") workflowNotice = received.text;
      if (received.kind === "unassigned" && process.env.COMPANYOS_WORKFLOW_ONLY === "true") return;
      if (received.kind === "decision") {
        if (await state.setIfNotExists(`workflow-response:${received.runId}:${message.id}`, true, 30 * DAY)) {
          await thread.post(`Your workflow decision was recorded: ${received.decision}.`);
          trace.emit("reply-posted");
        }
        return;
      }
      if (received.kind === "closed") workflowNotice = "This workflow conversation is closed. Explain only when addressed; no action is available.";
      if (received.kind === "conversation") {
        workflowSession = received.session;
        message = { ...message, text: workflowSession.text };
      }
    } catch (error) {
      const reference = sha256(error instanceof Error ? error.message : String(error));
      console.error(JSON.stringify({ event: "workflow.conversation.failed", reference }));
      trace.emit("verification-failed");
      workflowNotice = `The workflow message could not be verified or processed. No decision was inferred. Evidence reference: ${reference}. Explain only when addressed.`;
    }
  }
  const member = workflowSession?.member ?? rosterMember(message.author);
  if (!member) {
    trace.emit("identity-rejected");
    if (!thread.isDM && !message.isMention) return;
    await thread.post("This Slack identity is not an active human in the Company Workspace roster. The message was blocked before model invocation.");
    trace.emit("reply-posted");
    return;
  }
  const claimThreadId = workflowSession ? workflowInboundThreadId(thread.id, message.id) : thread.id;
  const claimKey = `message:${claimThreadId}:${message.id}${coordinated ? `:concern:${sha256({ agent: coordinated.agent.id, work: coordinated.concern.work?.id, text: coordinated.concern.text })}` : ""}`;
  if (!builderContinuation && !await state.setIfNotExists(claimKey, true, 30 * DAY)) { trace.emit("deduplicated"); return; }
  try {
  await thread.subscribe();
  const requester = workflowSession?.principal ?? principal(member);
  const participation = slackParticipation(thread, message, { id: requester, name: member.name });
  if ((coordinated || builderContinuation) && participation.ambient) participation.choose("respond");
  const conversation: ResolvedConversationAgent = workflowSession ? {
    agent: workflowSession.agent,
    resolution: { agentId: workflowSession.agent.id, reason: "assignment", assignmentId: workflowSession.runId },
    assignmentKey: { instanceId: workflowSession.artifact.instance.id, surface: workflowSession.conversation.surface,
      accountId: workflowSession.conversation.accountId, channelId: workflowSession.conversation.channelId, subjectPrincipal: requester },
  } : await resolvedAgentForConversation({
    threadId: thread.id,
    requesterPrincipal: requester,
    ...(coordinated ? {} : { assignmentStore }),
  });
  const agent = coordinated?.agent ?? conversation.agent;
  if (builderContinuation && (agent.id !== "builder" || conversation.resolution.reason !== "assignment")) {
    throw new Error("Builder handoff changed before the current request could be continued.");
  }
  const sessionThreadId = workflowSession ? workflowReplyThreadId(workflowSession)
    : resolveSlackAgentSessionThreadId(thread.id, message.id, slackAgentExperience);
  const deliveryThread = sessionThreadId === thread.id ? thread : botInstance!.thread(sessionThreadId);
  if (workflowSession && deliveryThread !== thread) await deliveryThread.subscribe();
  await rememberSlackAgentSessionConversation(
    state,
    sessionThreadId,
    thread.id,
    slackAgentExperience,
  );
  if (!participation.ambient || coordinated) await showSlackAgentWorking(deliveryThread, slackAgentExperience);
  const historyThreadId = workflowSession ? workflowReplyThreadId(workflowSession) : thread.id;
  const conversationKey = `conversation:${historyThreadId}:${agent.id}`;
  const recordSetupExchange = async (evidence: ModelExecutionEvidence) => {
    if (agent.id !== 'oregano' || agent.toolSet.tools.length !== 0 || !evidence.responseId) return;
    const receipt: SetupExchange = {
      version: 1, artifact_hash: artifact.artifactHash, core_commit: artifact.provenance.coreCommit,
      workspace_commit: artifact.provenance.workspaceCommit, principal: requester,
      message_id: message.id, conversation_key: conversationKey, response_id: evidence.responseId,
      model_route: evidence.route, model: evidence.model, delivered_at: new Date().toISOString(),
    };
    await state.setIfNotExists(setupExchangeKey(artifact.artifactHash, requester), receipt, 30 * DAY);
  };
  await state.appendToList(conversationKey, { role: "user", content: `${member.name}: ${message.text}`, message_id: message.id, principal: requester, sender_name: member.name, sent_at: message.metadata.dateSent.toISOString(), artifact_hash: artifact.artifactHash } satisfies ConversationEntry, {
    maxLength: 40,
    ttlMs: 30 * DAY,
  });
  const verificationResponse = setupVerificationResponse(message.text);
  if (verificationResponse && !participation.ambient) {
    const resolved = resolveModelExecution({ profile: "utility", task: "setup.verification", requiredCapability: "language" });
    trace.emit("model-started");
    const probe = await generateText({
      model: resolved.model,
      prompt: setupVerificationPrompt(verificationResponse),
      temperature: 0,
      maxOutputTokens: 48,
      ...(resolved.selection.retries === undefined ? {} : { maxRetries: resolved.selection.retries }),
      abortSignal: resolveSlackTurnAbortSignal(thread.signal, resolved.selection.timeoutMs),
    });
    trace.emit("model-finished");
    thread.signal.throwIfAborted();
    const generated = probe.text.trim();
    if (generated !== verificationResponse) throw new Error("The selected model did not return the exact CompanyOS setup proof response.");
    await state.appendToList(conversationKey, { role: "assistant", content: generated, in_reply_to: message.id, artifact_hash: artifact.artifactHash, model_execution: modelExecutionEvidence(resolved.selection, probe) } satisfies ConversationEntry, {
      maxLength: 40,
      ttlMs: 30 * DAY,
    });
    await deliveryThread.post(generated);
    trace.emit("reply-posted");
    await recordSetupExchange(modelExecutionEvidence(resolved.selection, probe));
    return;
  }
  const history = boundedConversationHistory(await state.getList<ConversationEntry>(conversationKey));
  const runId = workflowSession?.runId ?? `slack-${sha256(`${thread.id}:${agent.id}`).slice(0, 24)}`;
  const visibleGrantIds = new Set(workflowSession?.allowedTools ?? agent.toolSet.tools.map((entry) => entry.grantId));
  let builderIntent: BuilderTurnIntent | undefined;
  if (agent.id === "builder" && !workflowNotice) {
    const current = await state.get<BuilderRequestReference>(builderCurrentRequestKey(artifact.instance.id, requester, deliveryThread.id));
    const classification = await classifyBuilderTurn({ messageId: message.id, currentMessage: message.text,
      currentBuild: current ?? null, recentConversation: history.slice(-8).map(({ role, content }) => ({ role, content })) }, thread.signal);
    builderIntent = classification.intent;
    const reference = sha256([artifact.artifactHash, conversationKey, message.id]);
    await state.set(`builder:intake:${reference}`, { artifactHash: artifact.artifactHash, messageId: message.id,
      kind: builderIntent.kind, attempts: classification.attempts, failures: classification.failures, executions: classification.executions }, 30 * DAY);
    console.info(JSON.stringify({ event: "builder.intake", reference, kind: builderIntent.kind, attempts: classification.attempts, failures: classification.failures }));
    if (builderIntent.kind === "unavailable" && !participation.ambient) {
      const response = `I could not process your build request because the request check failed. No build was started. Your conversation is retained; please retry in this thread with an app mention. Reference: ${reference.slice(0, 12)}`;
      await state.appendToList(conversationKey, { role: "assistant", content: response, in_reply_to: message.id, artifact_hash: artifact.artifactHash } satisfies ConversationEntry, { maxLength: 40, ttlMs: 30 * DAY });
      await deliveryThread.post(response);
      return;
    }
  }
  const tools = withConversationParticipation(workflowNotice ? {} : resolvedTools(agent, deliveryThread, requester, runId, message.id, conversation, visibleGrantIds, workflowSession, builderIntent), participation);
  if (coordinated) delete tools.companyos_agent_handoff;
  const knowledgeRoute = resolveKnowledgeTurnRoute({
    text: message.text,
    requiresKnowledge: coordinated?.concern.knowledge,
    tools: (workflowNotice ? [] : agent.toolSet.tools)
      .filter((entry) => visibleGrantIds.has(entry.grantId))
      .map((entry) => ({ grantId: entry.grantId, toolName: toolName(entry.grantId) })),
  });
  const modelTask = agentModelTask(agent, knowledgeRoute);
  const resolved = resolveModelExecution({
    profile: modelTask.profile,
    task: modelTask.task,
    requiredCapability: "tools",
    ...(modelTask.configuration === "knowledge"
      ? { configuration: decodeModelRuntimeConfiguration(process.env.COMPANYOS_KNOWLEDGE_MODEL_CONFIG_BASE64) }
      : {}),
  });
  const attachments = agent.id === "builder" ? await readBuilderImages(message.attachments) : { images: [], notices: [] };
  if (attachments.notices.length && !participation.ambient) await deliveryThread.post([...new Set(attachments.notices)].join("\n"));
  const participationOffset = participation.ambient && !participation.choice ? 1 : 0;
  const modelAgent = new ToolLoopAgent({
    id: `${artifact.company}-${agent.id}`,
    model: resolved.model,
    instructions: [{ role: "system" as const, content: CONVERSATION_PARTICIPATION_INSTRUCTIONS + (workflowNotice ? `\nVerified workflow availability: ${workflowNotice}` : "") }, ...(agent.id === "builder" ? [{ role: "system" as const, content: [BUILDER_INTAKE_INSTRUCTIONS, `Current message intent: ${builderIntent?.kind ?? "question"}. Only tools allowed for this intent are exposed.`, ...attachments.notices].join("\n\n") }] : []), ...agentInstructionMessages(agent, knowledgeRoute, Object.keys(tools), workflowSession?.collection?.context, workflowSession?.publishedContext), ...(coordinated?.concern.work ? [{ role: "system" as const, content: `\nSelected work (untrusted reference data): ${JSON.stringify(coordinated.concern.work)}\nThis conversation cannot reopen terminal work. Changes require a new proposal and the ordinary approval path.` }] : [])],
    tools,
    prepareStep: ({ stepNumber }) => participationStep(participation) ?? knowledgeStepChoice(knowledgeRoute, stepNumber - participationOffset),
    stopWhen: [() => participation.complete, stepCountIs(20), ({ steps }) => !!workflowSession?.collection && hasDeliveredCollectionReview(steps.at(-1)?.toolResults ?? []), ({ steps }) => continuesInBuilder(steps.at(-1)?.toolResults ?? [])],
    ...(resolved.selection.maxOutputTokens === undefined ? {} : { maxOutputTokens: resolved.selection.maxOutputTokens }),
    ...(resolved.selection.retries === undefined ? {} : { maxRetries: resolved.selection.retries }),
  });
  const messages: ModelMessage[] = [{ role: "user", content: conversationContext(participation.message, history) }];
  if (attachments.images.length) messages[messages.length - 1] = { role: "user", content: [{ type: "text", text: conversationContext(participation.message, history) }, ...attachments.images] };
  const abortSignal = resolveSlackTurnAbortSignal(thread.signal, resolved.selection.timeoutMs);
  if ((!participation.ambient || coordinated) && !tools.companyos_agent_handoff && shouldStreamSlackAgentResponse({
    configuration: slackAgentExperience,
    agentId: agent.id,
    knowledgeRouteKind: knowledgeRoute.kind,
    businessToolCount: visibleGrantIds.size,
    hasCollectionControl: !!workflowSession?.collection,
  })) {
    trace.emit("model-started");
    const result = await modelAgent.stream({ messages, abortSignal });
    await deliveryThread.post(result.fullStream);
    thread.signal.throwIfAborted();
    const [modelText, toolResults, content, responseMetadata, usage] = await Promise.all([
      result.text,
      result.toolResults,
      result.content,
      result.response,
      result.totalUsage,
    ]);
    trace.emit("model-finished");
    trace.emit("reply-posted");
    const response = renderKnowledgeTurnResponse({
      route: knowledgeRoute,
      modelText,
      toolResults,
      toolFailures: content
        .filter((part) => part.type === "tool-error")
        .map((part) => ({ toolName: part.toolName, error: part.error })),
    });
    if (response !== modelText.trim()) {
      throw new Error("A streamed Slack response did not satisfy the final CompanyOS presentation contract.");
    }
    await state.appendToList(conversationKey, {
      role: "assistant",
      content: response,
      in_reply_to: message.id, sent_at: new Date().toISOString(), artifact_hash: artifact.artifactHash,
      model_execution: modelExecutionEvidence(resolved.selection, { response: responseMetadata, usage }),
    } satisfies ConversationEntry, {
      maxLength: 40,
      ttlMs: 30 * DAY,
    });
    await recordSetupExchange(modelExecutionEvidence(resolved.selection, { response: responseMetadata, usage }));
    return;
  }
  const toolProgress = createSlackToolProgressReporter(deliveryThread, workflowSession?.collection || participation.ambient ? { ...slackAgentExperience, streamingEnabled: false } : slackAgentExperience);
  let waitingForHuman = false;
  let result: Awaited<ReturnType<typeof modelAgent.generate>>;
  try {
    trace.emit("model-started");
    result = await modelAgent.generate({
      messages,
      abortSignal,
      onToolExecutionStart: async ({ toolCall }) => {
        if (toolCall.toolName !== CONVERSATION_CONTROL_TOOL) await toolProgress.start({ id: toolCall.toolCallId, toolName: toolCall.toolName });
      },
      onToolExecutionEnd: async ({ toolCall, toolOutput }) => {
        if (toolCall.toolName === CONVERSATION_CONTROL_TOOL) return;
        const succeeded = toolOutput.type === "tool-result";
        const toolWaitingForHuman = succeeded && toolResultNeedsHumanInput(toolOutput.output);
        waitingForHuman ||= toolWaitingForHuman;
        await toolProgress.finish({
          id: toolCall.toolCallId,
          succeeded,
          ...(toolWaitingForHuman ? { waitingForHuman: true } : {}),
        });
      },
    });
    trace.emit("model-finished");
  } catch (error) {
    await toolProgress.fail();
    if (waitingForHuman && slackAgentExperience.streamingEnabled) {
      await deliveryThread.post(validatedSlackResponsePlan(
        "Waiting for your confirmation in the card above. The response could not be completed.",
        { suspended: true },
      ));
    }
    throw error;
  }
  thread.signal.throwIfAborted();
  if (!builderContinuation && agent.id !== "builder" && continuesInBuilder(result.toolResults)) {
    await toolProgress.complete({ waitingForHuman: false });
    await state.appendToList(conversationKey, {
      role: "assistant", content: "The current request was handed to Builder for process discovery and clarification.",
      model_execution: modelExecutionEvidence(resolved.selection, result),
    } satisfies ConversationEntry, { maxLength: 40, ttlMs: 30 * DAY });
    // Forward the original authenticated input, never a model-written instruction
    // or another Agent's private history. The target resolves its own read scope.
    await handleMessage(thread, message, true);
    return;
  }
  const output = participation.finish(result.text);
  await state.set(`conversation-participation:${sha256([thread.id, message.id, agent.id])}`, { participation: output.participation, reason: output.reason, principal: requester, messageId: message.id }, 30 * DAY);
  if (output.participation === "context-only") return;
  const response = renderKnowledgeTurnResponse({
    route: knowledgeRoute,
    modelText: output.text ?? "",
    toolResults: result.toolResults,
    toolFailures: result.content
      .filter((part) => part.type === "tool-error")
      .map((part) => ({ toolName: part.toolName, error: part.error })),
  });
  const reviewDelivered = !!workflowSession?.collection && hasDeliveredCollectionReview(result.toolResults);
  const presentation = reviewDelivered
    ? { historyResponse: "Review card delivered in this conversation. Awaiting the human decision.", visibleResponse: "" }
    : agent.id === "builder"
    ? builderChat.presentTurn(response, result.toolResults)
    : { historyResponse: response, visibleResponse: response };
  waitingForHuman ||= result.toolResults.some((entry) => toolResultNeedsHumanInput(entry.output));
  await toolProgress.complete({ waitingForHuman });
  await state.appendToList(conversationKey, { role: "assistant", content: presentation.historyResponse, sent_at: new Date().toISOString(), in_reply_to: message.id, artifact_hash: artifact.artifactHash, model_execution: modelExecutionEvidence(resolved.selection, result) } satisfies ConversationEntry, {
    maxLength: 40,
    ttlMs: 30 * DAY,
  });
  if (reviewDelivered) {
    try { await deliveryThread.adapter.endTyping?.(deliveryThread.id, "suspended"); } catch { /* Presentation cannot veto delivery or consent. */ }
    return;
  }
  if (presentation.visibleResponse) {
    await deliveryThread.post(slackAgentExperience.streamingEnabled
      ? validatedSlackResponsePlan(presentation.visibleResponse, { suspended: waitingForHuman })
      : presentation.visibleResponse);
    trace.emit("reply-posted");
    await recordSetupExchange(modelExecutionEvidence(resolved.selection, result));
  } else if (waitingForHuman && slackAgentExperience.streamingEnabled) {
    await deliveryThread.post(validatedSlackResponsePlan(
      "Waiting for your confirmation in the card above.",
      { suspended: true },
    ));
    trace.emit("reply-posted");
  }
  } catch (error) {
    await state.delete(claimKey);
    throw error;
  }
}

function registerHandlers(bot: Chat) {
  bot.onDirectMessage((thread, message) => handleMessage(thread, message));
  bot.onNewMention((thread, message) => handleMessage(thread, message));
  bot.onSubscribedMessage((thread, message) => handleMessage(thread, message));
  const names = [...new Set([process.env.BOT_USERNAME ?? "oregano", ...artifact.agents.map(agent => agent.id)])];
  const escapedNames = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  bot.onNewMessage(process.env.COMPANYOS_WORKFLOW_ONLY === "true" ? /[\s\S]*/ : new RegExp(`(?:^|\\s)(?:${escapedNames.join("|")})(?:[,!:?]|\\s)`, "iu"), (thread, message) => handleMessage(thread, message));
  bot.onAgentSessionStopped(async (event) => {
    const bridgedLegacyConversation = await abortRememberedSlackAgentSessionConversation(
      bot,
      state,
      event.threadId,
      slackAgentExperience,
    );
    console.info(JSON.stringify({
      event: "slack.agent-session.stopped",
      bridgedLegacyConversation,
    }));
  });
  bot.onAction(["companyos.workflow.approve", "companyos.workflow.reject"], async (event) => {
    if (!event.thread || !event.value) return;
    let feedbackLanguage: string | undefined;
    try {
      if (event.adapter.name !== "slack") throw new Error("Workflow action reached the wrong transport");
      if (!workflowHostingEnabled()) throw new Error("Workflow interactions are unavailable in this Instance");
      const started = performance.now();
      const { createWorkflowHost } = await import("./workflow-host.ts");
      const host = await createWorkflowHost();
      feedbackLanguage = host.artifact.language;
      console.info(JSON.stringify({ event: "workflow.button.host-ready", elapsedMs: Math.round(performance.now() - started) }));
      const result = await recordWorkflowButtonResponse({
        language: host.artifact.language,
        observe: (phase, elapsedMs) => console.info(JSON.stringify({ event: "workflow.button.phase", phase, elapsedMs })),
        decide: (onValidated) => host.conversations.receiveAction({ actionId: event.actionId, value: event.value!,
          threadId: event.threadId, messageId: event.messageId, userId: event.user.userId, raw: event.raw }, onValidated),
        replace: (card) => event.adapter.editMessage(event.threadId, event.messageId, retainSlackDecisionReview(event.raw, card)),
        continueRun: (runId) => host.engine.advance(runId, 32),
      });
      if (result.continuation === "failed") console.error(JSON.stringify({ event: "workflow.button.continuation-failed", runId: result.runId, reference: sha256(String(result.continuationError)) }));
      if (result.presentation === "failed") {
        console.error(JSON.stringify({ event: "workflow.button.presentation-failed", runId: result.runId,
          reference: sha256(result.error instanceof Error ? result.error.message : String(result.error)) }));
        await event.thread.post(decisionFeedback("delivery", feedbackLanguage).content)
          .catch(() => console.error(JSON.stringify({ event: "workflow.button.receipt-failed", runId: result.runId })));
      }
    } catch (error) {
      const reference = sha256(error instanceof Error ? error.message : String(error));
      console.error(JSON.stringify({ event: "workflow.button.failed", reference }));
      await event.thread.post(`${decisionFeedback("uncertain", feedbackLanguage).content} (${reference})`);
    }
  });

  bot.onAction(["companyos.approve", "companyos.reject"], async (event) => {
  if (!event.thread || !event.value) return;
  const pending = await state.get<PendingApproval>(`approval:${event.value}`);
  if (!pending) {
    await event.thread.post("This approval is expired or was already resolved.");
    return;
  }
  const member = rosterMember(event.user);
  if (!member) {
    await event.thread.post("Approval refused: this Slack identity is not an active authorized human in the Company Workspace roster.");
    return;
  }
  const approvingPrincipal = principal(member);
  if (event.actionId === "companyos.reject") {
    const result = await runtime.rejectApproval({ ...pending, approvingPrincipal });
    if (result.ok) await state.delete(`approval:${event.value}`);
    await event.thread.post(result.ok ? `Rejected by ${result.deniedBy}. No effect occurred.` : `Rejection refused: ${result.reason}`);
    return;
  }
  const result = await runtime.execute({ ...pending, approvingPrincipal });
  if (typeof result === "object" && result !== null && "ok" in result && (result as { ok?: boolean }).ok === false) {
    await event.thread.post(`Approval refused: ${compact(result)}`);
    return;
  }
  await state.delete(`approval:${event.value}`);
  await event.thread.post(`Approved by ${member.name} (${member.role}). Effect evidence: ${compact(result)}`);
  });
  bot.onAction(["companyos.confirm", "companyos.cancel-confirmation"], async (event) => {
    if (!event.thread || !event.value) return;
    const pending = await state.get<PendingConfirmation>(`confirmation:${event.value}`);
    if (!pending) {
      await event.thread.post("This confirmation is expired or was already resolved.");
      return;
    }
    const member = rosterMember(event.user);
    if (!member) {
      await event.thread.post("Confirmation refused: this Slack identity is not an active authorized human in the Company Workspace roster.");
      return;
    }
    const confirmingPrincipal = principal(member);
    if (confirmingPrincipal !== pending.requestedBy) {
      await event.thread.post("Confirmation refused: only the exact human subject for this proposal may confirm it.");
      return;
    }
    if (event.actionId === "companyos.cancel-confirmation") {
      await state.delete(`confirmation:${event.value}`);
      await event.thread.post(`Cancelled by ${member.name}. No effect occurred.`);
      return;
    }
    try {
      const result = await runtime.executeConfirmed(pending, confirmingPrincipal);
      await state.delete(`confirmation:${event.value}`);
      await event.thread.post(`Confirmed by ${member.name}. Effect evidence: ${compact(result)}`);
    } catch (error) {
      await event.thread.post(`Confirmation refused: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  builderChat.registerHandlers(bot);
}

let botInstance: Chat | undefined;

export function createCompanyOSRuntimeConnectors(
  selectedAgentId = process.env.COMPANYOS_AGENT_ID ?? "unresolved-agent",
  options?: { artifact?: CompanyOSArtifact; chat?: () => Chat; beforeSlackDirectPublish?: BeforeSlackDirectPublish; onlyCapabilities?: readonly string[] },
) {
  const baseline = createUnifiedKnowledgeProvider({
    handbook: createPostgresKnowledgeProvider(process.env.COMPANYOS_BUILDER_RELEASE_BINDING_BASE64 && options?.artifact?.knowledge
      ? { snapshotHash: options.artifact.knowledge.bundleHash } : {}),
    brain: new PostgresBrainKnowledgeProjectionStore(),
    accessAuditor: new PostgresKnowledgeAccessAuditor(),
  });
  const knowledge = createPostgresKnowledgeCanaryProvider({
    baseline,
    selection: resolveKnowledgeRetrievalRuntimeSelection({ environment: process.env, selectedAgentId }),
  });
  return [
    new ArtifactPostgresConnector(),
    new KnowledgeProviderConnector(knowledge),
    ...(options?.artifact && options.chat
      ? createConfiguredRuntimeConnectors({ artifact: options.artifact, chat: options.chat, beforeSlackDirectPublish: options.beforeSlackDirectPublish, onlyCapabilities: options.onlyCapabilities })
      : []),
  ];
}

export function getBot(): Chat {
  if (botInstance) return botInstance;
  workflowDmRecipients();
  state = createPostgresChatState();
  artifact = loadArtifact();
  assignmentStore = createPostgresConversationAssignmentStore();
  handoffService = new AgentHandoffService({
    artifactHash: artifact.artifactHash,
    routing: artifact.agentRouting,
    agentIds: artifact.agents.map((agent) => agent.id),
    roster: artifact.roster,
    store: assignmentStore,
  });
  builderChat = createBuilderChatIntegration({ artifact, state, rosterMember, principal,
    onJobCreated: async job => {
      const [surface, channelId, threadId] = job.sourceConversationKey.split(":");
      const accountId = job.requesterPrincipal.split(":")[1];
      if (!surface || !channelId || !threadId || !accountId) return;
      await linkConversationDraft({ scope: { instanceId: artifact.instance.id, principal: job.requesterPrincipal, surface, accountId, channelId },
        store: createPostgresConversationAttentionStore(), source: createPostgresConversationWorkSource(artifact), workId: `builder:${job.jobId}`,
        address: { surface, accountId, channelId, threadId }, eventId: `builder-linked:${job.jobId}`, now: new Date().toISOString() });
    },
    refreshResult: job => builderRelease?.notifier.deliver(job) ?? Promise.resolve(),
    present: (job, card, phase) => createBuilderCardPresenter(getBot(), state)(job, card, phase) });
  slackAgentExperience = resolveSlackAgentExperience();
  const candidateBot = new Chat({
    userName: process.env.BOT_USERNAME ?? "oregano",
    adapters: {
      slack: createSlackAdapter({
        ...connectSlackAdapter(requireEnv("SLACK_CONNECTOR")),
        agentView: slackAgentExperience.enabled,
        nativeStreaming: slackAgentExperience.streamingEnabled,
        sessionTitle: slackAgentExperience.enabled,
      }),
    },
    state,
    concurrency: { strategy: "queue", maxQueueSize: 20 },
  });
  const connectorAgentId = process.env.COMPANYOS_AGENT_ID
    ?? artifact.agentRouting?.defaultAgentId
    ?? "multi-agent";
  runtime = new CompanyOSRuntime({
    artifact,
    state: createPostgresStateStore(),
    workflowContext: { read: async () => undefined },
    connectors: createCompanyOSRuntimeConnectors(connectorAgentId, {
      artifact,
      chat: () => candidateBot,
    }),
    toolExecutionTimeoutMs: TOOL_EXECUTION_TIMEOUT_MS,
  });
  registerHandlers(candidateBot);
  builderRelease = createBuilderReleaseRuntime({ chat: candidateBot, state,
    authenticatedPrincipal: (author) => { const member = rosterMember(author); return member ? principal(member) : undefined; } });
  builderRelease?.registerHandlers();
  // Publish only after runtime construction and handler registration succeed.
  botInstance = candidateBot;
  return candidateBot;
}

export function getCompanyOSRuntime(): CompanyOSRuntime {
  getBot();
  return runtime;
}

export function getBuilderTerminalNotifier() {
  const chat = getBot();
  return builderRelease?.notifier ?? createBuilderChatNotifier(chat, createBuilderCardPresenter(chat, state));
}
export async function reportBuilderProgress(job: BuilderJob, phase: "preparing" | "coding" | "checking") {
  await createBuilderCardPresenter(getBot(), state)(job, builderProgressCard(job, phase), phase);
}
export async function advanceBuilderRelease(workerId: string) {
  getBot();
  return builderRelease ? await builderRelease.advance(workerId) : { state: "idle", reason: "release-unconfigured" };
}
