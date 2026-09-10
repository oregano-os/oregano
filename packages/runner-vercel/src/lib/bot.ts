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
import { executeAgentHandoffControl } from "./agent-handoff-tools.ts";
import {
  createBuilderChatIntegration,
  type BuilderChatIntegration,
} from "./builder/chat-integration.ts";
import { findActiveHumanRosterMember } from "./identity.ts";
import { createPostgresChatState } from "./postgres-chat-state.ts";
import { modelExecutionEvidence, resolveModelExecution } from "./model-execution.ts";
import {
  knowledgeStepChoice,
  renderKnowledgeTurnResponse,
  resolveKnowledgeTurnRoute,
} from "./knowledge-turn-routing.ts";
import { agentModelTask } from "./agent-model-task.ts";
import { agentInstructions } from "./agent-instructions.ts";
import { COLLECTION_TOOL_DESCRIPTION } from "../../../runtime/workflow-engine/collection.ts";
import { setupVerificationPrompt, setupVerificationResponse } from "./setup-verification.ts";
import {
  abortRememberedSlackAgentSessionConversation,
  createSlackToolProgressReporter,
  rememberSlackAgentSessionConversation,
  resolveSlackAgentExperience,
  resolveSlackAgentSessionThreadId,
  resolveSlackTurnAbortSignal,
  shouldStreamSlackAgentResponse,
  showSlackAgentWorking,
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
let assignmentStore: ConversationAssignmentStore;
let handoffService: AgentHandoffService;
let slackAgentExperience: SlackAgentExperienceConfiguration;

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

interface ConversationEntry {
  role: "user" | "assistant";
  content: string;
  model_execution?: ModelExecutionEvidence;
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
  if (hasOutgoingHandoff || conversation.resolution.reason === "assignment") {
    output.companyos_agent_handoff = tool({
      description: "Request an allowlisted CompanyOS Agent handoff for this authenticated conversation, or return an assigned conversation to its deterministic route. This control changes only the next turn's Agent selection; it never copies Tool grants or proves a business effect.",
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
        },
      ),
    });
  }
  Object.assign(output, builderChat.proposalTools({ agent, thread, requester, messageId }));
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

async function handleMessage(thread: Thread, message: Pick<Message, "id" | "text" | "author" | "metadata">) {
  const { workflowSlackMessageTrace } = await import("./workflow-slack-diagnostics.ts");
  const trace = workflowSlackMessageTrace(thread.id, message.id);
  trace.emit("handler-entered");
  try {
    await processConversationMessage(thread, message, trace);
    trace.emit("handler-finished");
  } catch (error) { trace.emit("handler-failed"); throw error; }
}

async function processConversationMessage(thread: Thread, message: Pick<Message, "id" | "text" | "author" | "metadata">,
  trace: import("./workflow-slack-diagnostics.ts").WorkflowSlackTrace) {
  let workflowSession: WorkflowConversationSession | undefined;
  if (workflowHostingEnabled()) {
    try {
      const { createWorkflowHost } = await import("./workflow-host.ts");
      const host = await createWorkflowHost();
      const input = { threadId: workflowInboundThreadId(thread.id, message.id), messageId: message.id, authorId: message.author.userId };
      const received = input.threadId.endsWith(`:${message.id}`)
        ? await host.conversations.receiveChannel(input) : await host.conversations.receive(input);
      trace.emit("assignment", received.kind);
      if (received.kind === "ambiguous") {
        const choice = await host.conversations.prepareChoice(input, received.conversations);
        const links = choice.conversations.map((c, index) => `<https://slack.com/archives/${c.channelId}/p${c.threadId.replace(".", "")}|Question ${index + 1}>`).join(" · ");
        await publishConversationChoice({ conversationId: input.threadId, inbound: thread, resolve: (id) => botInstance!.thread(id),
          content: `Several questions are open for you. Which question does your answer belong to? Reply here with the number (for example “Question 2”), and I will use your original answer. You can also open the matching question: ${links}`,
          recordPublication: choice.presented });
        trace.emit("reply-posted");
        return;
      }
      if (received.kind === "routing") { await thread.post(received.text); trace.emit("reply-posted"); return; }
      if (received.kind === "unassigned" && process.env.COMPANYOS_WORKFLOW_ONLY === "true") return;
      if (received.kind === "decision") {
        if (await state.setIfNotExists(`workflow-response:${received.runId}:${message.id}`, true, 30 * DAY)) {
          await thread.post(`Your workflow decision was recorded: ${received.decision}.`);
          trace.emit("reply-posted");
        }
        return;
      }
      if (received.kind === "closed") { await thread.post("This workflow conversation is closed."); trace.emit("reply-posted"); return; }
      if (received.kind === "conversation") {
        workflowSession = received.session;
        message = { ...message, text: workflowSession.text };
      }
    } catch (error) {
      const reference = sha256(error instanceof Error ? error.message : String(error));
      console.error(JSON.stringify({ event: "workflow.conversation.failed", reference }));
      trace.emit("verification-failed");
      await thread.post(`Your workflow message could not be verified or processed. No decision was inferred. Evidence reference: ${reference}`);
      trace.emit("reply-posted");
      return;
    }
  }
  const member = workflowSession?.member ?? rosterMember(message.author);
  if (!member) {
    trace.emit("identity-rejected");
    await thread.post("This Slack identity is not an active human in the Company Workspace roster. The message was blocked before model invocation.");
    trace.emit("reply-posted");
    return;
  }
  const claimThreadId = workflowSession ? workflowInboundThreadId(thread.id, message.id) : thread.id;
  if (!await state.setIfNotExists(`message:${claimThreadId}:${message.id}`, true, 30 * DAY)) { trace.emit("deduplicated"); return; }
  await thread.subscribe();
  const requester = workflowSession?.principal ?? principal(member);
  const conversation: ResolvedConversationAgent = workflowSession ? {
    agent: workflowSession.agent,
    resolution: { agentId: workflowSession.agent.id, reason: "assignment", assignmentId: workflowSession.runId },
    assignmentKey: { instanceId: workflowSession.artifact.instance.id, surface: workflowSession.conversation.surface,
      accountId: workflowSession.conversation.accountId, channelId: workflowSession.conversation.channelId, subjectPrincipal: requester },
  } : await resolvedAgentForConversation({
    threadId: thread.id,
    requesterPrincipal: requester,
    assignmentStore,
  });
  const agent = conversation.agent;
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
  await showSlackAgentWorking(deliveryThread, slackAgentExperience);
  const historyThreadId = workflowSession ? workflowReplyThreadId(workflowSession) : thread.id;
  const conversationKey = `conversation:${historyThreadId}:${agent.id}`;
  await state.appendToList(conversationKey, { role: "user", content: `${member.name}: ${message.text}` } satisfies ConversationEntry, {
    maxLength: 40,
    ttlMs: 30 * DAY,
  });
  const verificationResponse = setupVerificationResponse(message.text);
  if (verificationResponse) {
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
    await state.appendToList(conversationKey, { role: "assistant", content: generated, model_execution: modelExecutionEvidence(resolved.selection, probe) } satisfies ConversationEntry, {
      maxLength: 40,
      ttlMs: 30 * DAY,
    });
    await deliveryThread.post(generated);
    trace.emit("reply-posted");
    return;
  }
  const history = await state.getList<ConversationEntry>(conversationKey);
  const runId = workflowSession?.runId ?? `slack-${sha256(`${thread.id}:${agent.id}`).slice(0, 24)}`;
  const visibleGrantIds = new Set(workflowSession?.allowedTools ?? agent.toolSet.tools.map((entry) => entry.grantId));
  const tools = resolvedTools(agent, deliveryThread, requester, runId, message.id, conversation, visibleGrantIds, workflowSession);
  const knowledgeRoute = resolveKnowledgeTurnRoute({
    text: message.text,
    tools: agent.toolSet.tools
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
  const modelAgent = new ToolLoopAgent({
    id: `${artifact.company}-${agent.id}`,
    model: resolved.model,
    instructions: agentInstructions(agent, knowledgeRoute, Object.keys(tools), workflowSession?.collection?.context, workflowSession?.publishedContext),
    tools,
    prepareStep: ({ stepNumber }) => knowledgeStepChoice(knowledgeRoute, stepNumber),
    ...(workflowSession?.collection ? { stopWhen: [stepCountIs(20), ({ steps }: any) => hasDeliveredCollectionReview(steps.at(-1)?.toolResults ?? [])] } : {}),
    ...(resolved.selection.maxOutputTokens === undefined ? {} : { maxOutputTokens: resolved.selection.maxOutputTokens }),
    ...(resolved.selection.retries === undefined ? {} : { maxRetries: resolved.selection.retries }),
  });
  const messages: ModelMessage[] = history.map((entry) => ({ role: entry.role, content: entry.content }));
  const abortSignal = resolveSlackTurnAbortSignal(thread.signal, resolved.selection.timeoutMs);
  if (shouldStreamSlackAgentResponse({
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
      result.usage,
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
      model_execution: modelExecutionEvidence(resolved.selection, { response: responseMetadata, usage }),
    } satisfies ConversationEntry, {
      maxLength: 40,
      ttlMs: 30 * DAY,
    });
    return;
  }
  const toolProgress = createSlackToolProgressReporter(deliveryThread, workflowSession?.collection ? { ...slackAgentExperience, streamingEnabled: false } : slackAgentExperience);
  let waitingForHuman = false;
  let result: Awaited<ReturnType<typeof modelAgent.generate>>;
  try {
    trace.emit("model-started");
    result = await modelAgent.generate({
      messages,
      abortSignal,
      onToolExecutionStart: async ({ toolCall }) => {
        await toolProgress.start({ id: toolCall.toolCallId, toolName: toolCall.toolName });
      },
      onToolExecutionEnd: async ({ toolCall, toolOutput }) => {
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
  const response = renderKnowledgeTurnResponse({
    route: knowledgeRoute,
    modelText: result.text,
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
  await state.appendToList(conversationKey, { role: "assistant", content: presentation.historyResponse, model_execution: modelExecutionEvidence(resolved.selection, result) } satisfies ConversationEntry, {
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
  } else if (waitingForHuman && slackAgentExperience.streamingEnabled) {
    await deliveryThread.post(validatedSlackResponsePlan(
      "Waiting for your confirmation in the card above.",
      { suspended: true },
    ));
    trace.emit("reply-posted");
  }
}

function registerHandlers(bot: Chat) {
  bot.onNewMention(handleMessage);
  bot.onSubscribedMessage(handleMessage);
  if (process.env.COMPANYOS_WORKFLOW_ONLY === "true") bot.onNewMessage(/[\s\S]*/, handleMessage);
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
  options?: { artifact?: CompanyOSArtifact; chat?: () => Chat; beforeSlackDirectPublish?: BeforeSlackDirectPublish },
) {
  const baseline = createUnifiedKnowledgeProvider({
    handbook: createPostgresKnowledgeProvider(),
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
      ? createConfiguredRuntimeConnectors({ artifact: options.artifact, chat: options.chat, beforeSlackDirectPublish: options.beforeSlackDirectPublish })
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
  builderChat = createBuilderChatIntegration({ artifact, state, rosterMember, principal });
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
  // Publish only a fully configured instance. A failed Connector constructor
  // must never leave a cached Chat that acknowledges messages without handlers.
  botInstance = candidateBot;
  return candidateBot;
}

export function getCompanyOSRuntime(): CompanyOSRuntime {
  getBot();
  return runtime;
}
