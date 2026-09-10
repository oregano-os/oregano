import { type BuilderTurnIntent } from "../../../runtime/builder/turn-intent.ts";
import { classifyBuilderTurn } from "./builder/turn-intent.ts";
import { builderCurrentRequestKey, type BuilderRequestReference } from "../../../runtime/builder/experience.ts";
import { readBuilderImages } from "../../../runtime/builder/attachments.ts";
import { systemInstructions } from "./agent-instructions.ts";
import { BUILDER_INTAKE_INSTRUCTIONS } from "../../../runtime/builder/brief.ts";
import { randomUUID } from "node:crypto";
import { createSlackAdapter } from "@chat-adapter/slack";
import { connectSlackAdapter } from "@vercel/connect/chat";
import { ToolLoopAgent, generateText, jsonSchema, stepCountIs, tool, type ModelMessage, type ToolSet } from "ai";
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
import type { CompanyOSArtifact, CompiledAgent, CompiledSprintRuntime } from "../../../companyos-builder/types.ts";
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
  knowledgeTurnModelTask,
  renderKnowledgeTurnResponse,
  resolveKnowledgeTurnRoute,
  type KnowledgeTurnRoute,
} from "./knowledge-turn-routing.ts";
import { setupVerificationPrompt, setupVerificationResponse, setupExchangeKey, type SetupExchange } from "./setup-verification.ts";
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
import { isFridaySprintUpdate } from "../../../runtime/sprint-slack-submission.ts";
import { workflowHostingEnabled } from "./workflow-configuration.ts";
import type { WorkflowConversationSession } from "./workflow-conversations.ts";
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

interface ConversationEntry {
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

/** Keep operator-only scenario publication authority out of model-visible chat. */
export function modelVisibleToolGrantIds(
  agent: CompiledAgent,
  sprintRuntime?: CompiledSprintRuntime,
): string[] {
  const operatorOnly = sprintRuntime?.execution === "shadow-only" && sprintRuntime.testPublication?.testOnly
    ? new Set(["oregano:communications/publish"])
    : new Set<string>();
  return agent.toolSet.tools
    .map((entry) => entry.grantId)
    .filter((grantId) => !operatorOnly.has(grantId));
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
        await thread.post(Card({
          title: `CompanyOS approval · ${resolved.risk}`,
          children: [
            CardText(`Action: ${resolved.grantId}`),
            CardText(`Exact input hash: ${approval.inputHash}`),
            CardText(`Requested by: ${requester}`),
            CardText(`Input preview: ${compact(input)}`),
            Actions([
              Button({ id: "companyos.approve", label: "Approve", style: "primary", value: token }),
              Button({ id: "companyos.reject", label: "Reject", style: "danger", value: token }),
            ]),
          ],
        }));
        return { ok: true, pendingApproval: true, requestId: approval.requestId, inputHash: approval.inputHash };
      },
    });
  }
  if (workflowSession) return output;
  const hasOutgoingHandoff = (artifact.agentRouting.handoffs ?? [])
    .some((rule) => rule.fromAgentId === agent.id && rule.surfaces.includes(conversation.assignmentKey.surface));
  if (hasOutgoingHandoff || conversation.resolution.reason === "assignment") {
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

async function handleMessage(thread: Thread, message: Pick<Message, "id" | "text" | "author" | "metadata"> & Partial<Pick<Message, "attachments">>, builderContinuation = false) {
  if (!builderContinuation && await builderRelease?.receive({ conversation: thread.id, author: message.author,
    messageId: message.id, text: message.text, occurredAt: message.metadata.dateSent.toISOString() })) return;
  let workflowSession: WorkflowConversationSession | undefined;
  if (workflowHostingEnabled()) {
    try {
      const { createWorkflowHost } = await import("./workflow-host.ts");
      const host = await createWorkflowHost();
      const received = await host.conversations.receive({ threadId: thread.id, messageId: message.id, authorId: message.author.userId });
      if (received.kind === "decision") {
        if (await state.setIfNotExists(`workflow-response:${received.runId}:${message.id}`, true, 30 * DAY)) {
          await thread.post(`Your workflow decision was recorded: ${received.decision}.`);
        }
        return;
      }
      if (received.kind === "closed") { await thread.post("This workflow conversation is closed."); return; }
      if (received.kind === "conversation") {
        workflowSession = received.session;
        message = { ...message, text: workflowSession.text };
      }
    } catch (error) {
      const reference = sha256(error instanceof Error ? error.message : String(error));
      console.error(JSON.stringify({ event: "workflow.conversation.failed", reference }));
      await thread.post(`Your workflow message could not be verified or processed. No decision was inferred. Evidence reference: ${reference}`);
      return;
    }
  }
  const member = workflowSession?.member ?? rosterMember(message.author);
  if (!member) {
    await thread.post("This Slack identity is not an active human in the Company Workspace roster. The message was blocked before model invocation.");
    return;
  }
  if (!builderContinuation && !await state.setIfNotExists(`message:${thread.id}:${message.id}`, true, 30 * DAY)) return;
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
  if (builderContinuation && (agent.id !== "builder" || conversation.resolution.reason !== "assignment")) {
    throw new Error("Builder handoff changed before the current request could be continued.");
  }
  const sessionThreadId = resolveSlackAgentSessionThreadId(thread.id, message.id, slackAgentExperience);
  const deliveryThread = sessionThreadId === thread.id ? thread : botInstance!.thread(sessionThreadId);
  await rememberSlackAgentSessionConversation(
    state,
    sessionThreadId,
    thread.id,
    slackAgentExperience,
  );
  await showSlackAgentWorking(deliveryThread, slackAgentExperience);
  const sprintBindings = (workflowSession ? [] : artifact.sprints ?? []).filter((candidate) => candidate.agentId === agent.id);
  if (sprintBindings.length > 1) throw new Error(`Agent '${agent.id}' has ambiguous Sprint runtime bindings.`);
  if (sprintBindings.length === 1 && isFridaySprintUpdate(message.text)) {
    let sprintMode: "disabled" | "shadow" | "active" = "disabled";
    try {
      const { currentSprintRuntimeMode, ingestFridaySprintUpdate } = await import("./sprint-runtime.ts");
      sprintMode = currentSprintRuntimeMode();
      const ingestion = await ingestFridaySprintUpdate({
        agentId: agent.id,
        messageId: message.id,
        occurredAt: message.metadata.dateSent.toISOString(),
        principal: requester,
        threadReference: thread.id,
        text: message.text,
      });
      if (!ingestion.accepted && sprintMode !== "shadow") {
        await deliveryThread.post(`Your Friday Sprint update was not recorded (${ingestion.reason}).`);
      }
      return;
    } catch (error) {
      if (sprintMode !== "shadow") {
        const reference = sha256(error instanceof Error ? error.message : String(error));
        await deliveryThread.post(`Your Friday Sprint update could not be recorded. Evidence reference: ${reference}`);
      }
      return;
    }
  }
  const conversationKey = `conversation:${thread.id}:${agent.id}`;
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
  await state.appendToList(conversationKey, { role: "user", content: `${member.name}: ${message.text}`, message_id: message.id, principal: requester, artifact_hash: artifact.artifactHash } satisfies ConversationEntry, {
    maxLength: 40,
    ttlMs: 30 * DAY,
  });
  const verificationResponse = setupVerificationResponse(message.text);
  if (verificationResponse) {
    const resolved = resolveModelExecution({ profile: "utility", task: "setup.verification", requiredCapability: "language" });
    const probe = await generateText({
      model: resolved.model,
      prompt: setupVerificationPrompt(verificationResponse),
      temperature: 0,
      maxOutputTokens: 48,
      ...(resolved.selection.retries === undefined ? {} : { maxRetries: resolved.selection.retries }),
      abortSignal: resolveSlackTurnAbortSignal(thread.signal, resolved.selection.timeoutMs),
    });
    thread.signal.throwIfAborted();
    const generated = probe.text.trim();
    if (generated !== verificationResponse) throw new Error("The selected model did not return the exact CompanyOS setup proof response.");
    await state.appendToList(conversationKey, { role: "assistant", content: generated, in_reply_to: message.id, artifact_hash: artifact.artifactHash, model_execution: modelExecutionEvidence(resolved.selection, probe) } satisfies ConversationEntry, {
      maxLength: 40,
      ttlMs: 30 * DAY,
    });
    await deliveryThread.post(generated);
    await recordSetupExchange(modelExecutionEvidence(resolved.selection, probe));
    return;
  }
  const history = await state.getList<ConversationEntry>(conversationKey);
  const runId = workflowSession?.runId ?? `slack-${sha256(`${thread.id}:${agent.id}`).slice(0, 24)}`;
  const visibleGrantIds = new Set(workflowSession?.allowedTools ?? modelVisibleToolGrantIds(agent, sprintBindings[0]));
  let builderIntent: BuilderTurnIntent | undefined;
  if (agent.id === "builder") {
    const current = await state.get<BuilderRequestReference>(builderCurrentRequestKey(artifact.instance.id, requester, deliveryThread.id));
    const classification = await classifyBuilderTurn({ messageId: message.id, currentMessage: message.text,
      currentBuild: current ?? null, recentConversation: history.slice(-8).map(({ role, content }) => ({ role, content })) }, thread.signal);
    builderIntent = classification.intent;
    const reference = sha256([artifact.artifactHash, conversationKey, message.id]);
    await state.set(`builder:intake:${reference}`, { artifactHash: artifact.artifactHash, messageId: message.id,
      kind: builderIntent.kind, attempts: classification.attempts, failures: classification.failures, executions: classification.executions }, 30 * DAY);
    console.info(JSON.stringify({ event: "builder.intake", reference, kind: builderIntent.kind, attempts: classification.attempts, failures: classification.failures }));
    if (builderIntent.kind === "unavailable") {
      const response = `I could not process your build request because the request check failed. No build was started. Your conversation is retained; please retry in this thread with an app mention. Reference: ${reference.slice(0, 12)}`;
      await state.appendToList(conversationKey, { role: "assistant", content: response, in_reply_to: message.id, artifact_hash: artifact.artifactHash } satisfies ConversationEntry, { maxLength: 40, ttlMs: 30 * DAY });
      await deliveryThread.post(response);
      return;
    }
  }
  const tools = resolvedTools(agent, deliveryThread, requester, runId, message.id, conversation, visibleGrantIds, workflowSession, builderIntent);
  const knowledgeRoute = resolveKnowledgeTurnRoute({
    text: message.text,
    tools: agent.toolSet.tools
      .filter((entry) => visibleGrantIds.has(entry.grantId))
      .map((entry) => ({ grantId: entry.grantId, toolName: toolName(entry.grantId) })),
  });
  const modelTask = sprintBindings.length === 1
    ? { profile: "reasoning" as const, task: sprintBindings[0].modelTask, configuration: "default" as const }
    : knowledgeTurnModelTask(knowledgeRoute);
  const resolved = resolveModelExecution({
    profile: modelTask.profile,
    task: modelTask.task,
    requiredCapability: "tools",
    ...(modelTask.configuration === "knowledge"
      ? { configuration: decodeModelRuntimeConfiguration(process.env.COMPANYOS_KNOWLEDGE_MODEL_CONFIG_BASE64) }
      : {}),
  });
  const attachments = agent.id === "builder" ? await readBuilderImages(message.attachments) : { images: [], notices: [] };
  if (attachments.notices.length) await deliveryThread.post([...new Set(attachments.notices)].join("\n"));
  const modelAgent = new ToolLoopAgent({
    id: `${artifact.company}-${agent.id}`,
    model: resolved.model,
    instructions: [systemInstructions(agent, knowledgeRoute, tools), ...(agent.id === "builder" ? [BUILDER_INTAKE_INSTRUCTIONS, `Current message intent: ${builderIntent?.kind ?? "question"}. Only tools allowed for this intent are exposed.`, ...attachments.notices] : [])].join("\n\n"),
    tools,
    stopWhen: [stepCountIs(20), ({ steps }) => continuesInBuilder(steps.at(-1)?.toolResults ?? [])],
    prepareStep: ({ stepNumber }) => knowledgeStepChoice(knowledgeRoute, stepNumber),
    ...(resolved.selection.maxOutputTokens === undefined ? {} : { maxOutputTokens: resolved.selection.maxOutputTokens }),
    ...(resolved.selection.retries === undefined ? {} : { maxRetries: resolved.selection.retries }),
  });
  const messages: ModelMessage[] = history.map((entry) => ({ role: entry.role, content: entry.content }));
  if (attachments.images.length) messages[messages.length - 1] = { role: "user", content: [{ type: "text", text: `${member.name}: ${message.text}` }, ...attachments.images] };
  const abortSignal = resolveSlackTurnAbortSignal(thread.signal, resolved.selection.timeoutMs);
  if (!tools.companyos_agent_handoff && shouldStreamSlackAgentResponse({
    configuration: slackAgentExperience,
    agentId: agent.id,
    knowledgeRouteKind: knowledgeRoute.kind,
    businessToolCount: visibleGrantIds.size,
  })) {
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
      in_reply_to: message.id, artifact_hash: artifact.artifactHash,
      model_execution: modelExecutionEvidence(resolved.selection, { response: responseMetadata, usage }),
    } satisfies ConversationEntry, {
      maxLength: 40,
      ttlMs: 30 * DAY,
    });
    await recordSetupExchange(modelExecutionEvidence(resolved.selection, { response: responseMetadata, usage }));
    return;
  }
  const toolProgress = createSlackToolProgressReporter(deliveryThread, slackAgentExperience);
  let waitingForHuman = false;
  let result: Awaited<ReturnType<typeof modelAgent.generate>>;
  try {
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
  const response = renderKnowledgeTurnResponse({
    route: knowledgeRoute,
    modelText: result.text,
    toolResults: result.toolResults,
    toolFailures: result.content
      .filter((part) => part.type === "tool-error")
      .map((part) => ({ toolName: part.toolName, error: part.error })),
  });
  const presentation = agent.id === "builder"
    ? builderChat.presentTurn(response, result.toolResults)
    : { historyResponse: response, visibleResponse: response };
  waitingForHuman ||= result.toolResults.some((entry) => toolResultNeedsHumanInput(entry.output));
  await toolProgress.complete({ waitingForHuman });
  await state.appendToList(conversationKey, { role: "assistant", content: presentation.historyResponse, in_reply_to: message.id, artifact_hash: artifact.artifactHash, model_execution: modelExecutionEvidence(resolved.selection, result) } satisfies ConversationEntry, {
    maxLength: 40,
    ttlMs: 30 * DAY,
  });
  if (presentation.visibleResponse) {
    await deliveryThread.post(slackAgentExperience.streamingEnabled
      ? validatedSlackResponsePlan(presentation.visibleResponse, { suspended: waitingForHuman })
      : presentation.visibleResponse);
    await recordSetupExchange(modelExecutionEvidence(resolved.selection, result));
  } else if (waitingForHuman && slackAgentExperience.streamingEnabled) {
    await deliveryThread.post(validatedSlackResponsePlan(
      "Waiting for your confirmation in the card above.",
      { suspended: true },
    ));
  }
}

function registerHandlers(bot: Chat) {
  bot.onDirectMessage((thread, message) => handleMessage(thread, message));
  bot.onNewMention((thread, message) => handleMessage(thread, message));
  bot.onSubscribedMessage((thread, message) => handleMessage(thread, message));
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
      beforeSlackDirectPublish: createSprintDirectAssignmentHook({ artifact, service: handoffService }),
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

export function createSprintDirectAssignmentHook(args: {
  artifact: CompanyOSArtifact;
  service: AgentHandoffService;
  now?: () => Date;
}): BeforeSlackDirectPublish {
  return async ({ binding, threadReference, context }) => {
    const matches = (args.artifact.sprints ?? []).filter((candidate) => candidate.agentId === context.agentId);
    if (matches.length === 0) return;
    if (matches.length > 1) throw new Error(`Agent '${context.agentId}' has ambiguous Sprint runtime bindings.`);
    const sprint = matches[0]!;
    if (!context.idempotencyKey) throw new Error("Sprint direct-message assignment requires the claimed message effect identity.");
    if (context.subject?.status !== "active" || context.subject.principalId !== sprint.servicePrincipal) {
      throw new Error("Sprint direct-message assignment requires the exact active Sprint service principal.");
    }
    if (!binding.userId) throw new Error("Sprint direct-message assignment requires one exact Slack user binding.");
    const principal = `slack:${binding.accountId}:${binding.userId}`;
    if (sprint.directDestinations[principal] !== binding.id) {
      throw new Error("Sprint direct-message assignment does not match the compiled participant destination.");
    }
    const policy = sprint.directAssignments[principal];
    if (!policy) throw new Error("Sprint direct-message assignment policy is not compiled for this participant.");
    const [surface, channelId] = threadReference.split(":");
    if (surface !== "slack" || !channelId) throw new Error("Sprint direct-message thread identity is invalid.");
    await args.service.assignFromWorkflow({
      instanceId: args.artifact.instance.id,
      surface,
      accountId: binding.accountId,
      channelId,
      subjectPrincipal: principal,
      activeAgentId: policy.fromAgentId,
      targetAgentId: sprint.agentId,
      purpose: policy.purpose,
      transitionKey: `sprint-direct:${sha256([context.idempotencyKey, threadReference])}`,
      artifactHash: args.artifact.artifactHash,
      requestedAt: (args.now ?? (() => new Date()))().toISOString(),
      initiatedByPrincipal: sprint.servicePrincipal,
    });
  };
}
