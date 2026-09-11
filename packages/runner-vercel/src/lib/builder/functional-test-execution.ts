import { ToolLoopAgent, stepCountIs } from "ai";
import { ConversationParticipation, CONVERSATION_PARTICIPATION_INSTRUCTIONS, conversationContext, type ConversationContextEntry } from "../../../../runtime/conversation-participation.ts";
import { withConversationParticipation, participationStep } from "../conversation-model-tools.ts";
import type { Chat } from "chat";
import type { CompanyOSArtifact } from "../../../../companyos-builder/types.ts";
import type { BuilderTestResult, BuilderTestSession, BuilderTestStore, BuilderTestResource } from "../../../../runtime/builder/functional-tests.ts";
import { scopeBuilderTestConnector } from "../../../../runtime/builder/functional-tests.ts";
import { WorkflowEngine } from "../../../../runtime/workflow-engine/engine.ts";
import { DurableTimerService } from "../../../../runtime/durable-timers.ts";
import { createPostgresWorkflowExecutionStore } from "../../../../state-postgres/workflow-store.ts";
import { createPostgresStateStore } from "../../../../state-postgres/store.ts";
import { createPostgresDurableTimerStore } from "../../../../state-postgres/durable-timer-store.ts";
import { systemInstructions } from "../agent-instructions.ts";
import { resolveKnowledgeTurnRoute } from "../knowledge-turn-routing.ts";
import { modelExecutionEvidence, resolveModelExecution } from "../model-execution.ts";
import { createConfiguredRuntimeConnectors } from "../runtime-connectors.ts";
import { sha256 } from "../../../../runtime/canonical.ts";
import { findByCanonicalPrincipal, isHumanRosterMember } from "../../../../state-store/roster.ts";
import type { Connector } from "../../../../capabilities/contracts.ts";
import type { WorkflowExecutionStore } from "../../../../state-store/workflow-engine.ts";
import type { StateStore } from "../../../../state-store/interface.ts";
import type { DurableTimerStore } from "../../../../state-store/durable-timers.ts";

/** The initial connected profile intentionally admits only bounded synchronous tests. */
export function assertBuilderTestScope(artifact: CompanyOSArtifact, resources: readonly BuilderTestResource[]): void {
  for (const resource of resources) {
    if (!artifact.bindings.some((binding) => binding.capability === resource.capability)) throw new Error("The test requires an unavailable Instance capability.");
    if (resource.capability === "communication.message.publish") {
      if (!resource.match.destination_binding) throw new Error("Test publication needs an exact destination binding.");
    } else if (["work-item.read", "work-item.comment", "work-item.update"].includes(resource.capability)) {
      if (!resource.match.resource_binding || !resource.match.work_item_id) throw new Error("Test work-item access needs an exact resource and item.");
    } else throw new Error("This capability has no qualified connected-test executor yet.");
  }
}
export function assertBuilderTestSupported(artifact: CompanyOSArtifact, session: BuilderTestSession): void {
  if (artifact.provenance.workspaceCommit !== session.candidateCommit || artifact.provenance.coreCommit !== session.coreCommit
    || artifact.instance.id !== session.instanceId) throw new Error("The test does not identify this compiled candidate.");
  assertBuilderTestScope(artifact, session.resources);
  const execution = session.execution;
  if (execution.kind === "agent") {
    const agent = artifact.agents.find((entry) => entry.id === execution.agentId);
    if (!agent || agent.toolSet.tools.length || agent.id === "builder") throw new Error("This Agent test profile requires an existing read-only Agent; tool-using conversations need further qualification.");
    return;
  }
  const workflow = artifact.workflows?.find((entry) => entry.id === execution.workflowId);
  if (!workflow || workflow.trigger.kind !== "operator" || workflow.steps.some((step) => ["wait", "decision", "message"].includes(step.kind) || step.after || step.conversationalTools.length)) {
    throw new Error("This workflow test profile requires an operator-opened graph without timers, messages or intermediate decisions.");
  }
  const agent = artifact.agents.find((entry) => entry.id === workflow.agentId);
  if (!agent) throw new Error("Test workflow Agent is missing.");
  const capabilities = workflow.steps.flatMap((step) => agent.tools.find((tool) => tool.contract.runtimeId === step.tool?.runtimeId)?.contract.capabilities ?? []);
  if (capabilities.some((capability) => !session.resources.some((resource) => resource.capability === capability))) throw new Error("A workflow capability is outside the qualified test resources.");
}

export async function executeBuilderFunctionalTest(args: {
  artifact: CompanyOSArtifact; production: CompanyOSArtifact; session: BuilderTestSession;
  store: BuilderTestStore; chat: Chat;
  workflowExecution?: { store: WorkflowExecutionStore; control: StateStore; timers: DurableTimerStore; connectors: Connector[] };
}): Promise<BuilderTestResult> {
  const { artifact, session } = args;
  assertBuilderTestSupported(artifact, session);
  const member = findByCanonicalPrincipal(args.production.roster, session.requester);
  if (!member || !isHumanRosterMember(member) || !/^(active|aktiv)$/i.test(member.status)) throw new Error("The test requester is no longer an active company human.");
  const assertActive = async () => {
    const current = await args.store.get(session.id);
    if (!current || !["running", "responding"].includes(current.stage) || current.artifactHash !== artifact.artifactHash || current.scopeDigest !== session.scopeDigest
      || current.conversation?.pending?.messageId !== session.conversation?.pending?.messageId
      || current.conversation?.generation !== session.conversation?.generation
      || (current.conversation && Date.parse(current.conversation.expiresAt) <= Date.now())) throw new Error("The candidate test is no longer active.");
  };
  await assertActive();
  const base = { artifactHash: artifact.artifactHash, candidateCommit: session.candidateCommit, executionDigest: session.scopeDigest };
  if (session.execution.kind === "agent") {
    const agentId = session.execution.agentId, agent = artifact.agents.find((entry) => entry.id === agentId)!;
    const resolved = resolveModelExecution({ profile: "utility", task: "chat.response", requiredCapability: "tools" });
    const pending = session.conversation?.pending;
    const participation = new ConversationParticipation(pending?.message ?? {
      id: pending?.messageId ?? "initial", conversationId: session.activeTestConversation ?? session.testConversation!,
      senderId: session.requester, senderName: member.name, sentAt: new Date().toISOString(),
      text: pending?.prompt ?? session.execution.prompt, shared: false, mentioned: true,
    });
    const modelAgent = new ToolLoopAgent({ model: resolved.model,
      tools: withConversationParticipation({}, participation),
      stopWhen: [() => participation.complete, stepCountIs(3)], prepareStep: () => participationStep(participation),
      instructions: [CONVERSATION_PARTICIPATION_INSTRUCTIONS, systemInstructions(agent, resolveKnowledgeTurnRoute({ text: session.conversation?.pending?.prompt ?? session.execution.prompt, tools: [] }), {})].join("\n\n"),
      maxOutputTokens: 1500,
      ...(resolved.selection.retries === undefined ? {} : { maxRetries: resolved.selection.retries }),
    });
    const response = await modelAgent.generate({
      messages: [{ role: "user", content: conversationContext(participation.message, builderAgentTestContext(session)) }],
      abortSignal: AbortSignal.timeout(resolved.selection.timeoutMs ?? 60000),
    });
    const output = participation.finish(response.text);
    if (output.participation === "respond" && !output.text) throw new Error("The candidate Agent returned no test response.");
    await assertActive();
    return { ...base, completedAt: new Date().toISOString(), summary: output.text?.slice(0, 8000) ?? "", participation: output.participation,
      evidence: JSON.parse(JSON.stringify({ kind: "agent", agentId, promptDigest: sha256(session.conversation?.pending?.prompt ?? session.execution.prompt),
        conversationDigest: sha256(builderAgentTestMessages(session)),
        participation: output.participation, participationReason: output.reason, responseDigest: sha256(output.text ?? ""), model: modelExecutionEvidence(resolved.selection, response) })) };
  }
  const executionNamespace = session.id;
  const store = args.workflowExecution?.store ?? createPostgresWorkflowExecutionStore({ prepareArtifactSchema: false, executionNamespace });
  const control = args.workflowExecution?.control ?? createPostgresStateStore({ executionNamespace });
  const timers = new DurableTimerService({ store: args.workflowExecution?.timers ?? createPostgresDurableTimerStore({ executionNamespace }), instanceId: artifact.instance.id });
  const capabilities = session.resources.filter((resource) => resource.capability !== "communication.message.publish").map((resource) => resource.capability);
  const configured = args.workflowExecution?.connectors ?? createConfiguredRuntimeConnectors({ artifact, chat: () => args.chat, onlyCapabilities: capabilities });
  let runId = "";
  const engine = new WorkflowEngine({ artifact, store, control, timers,
    enabledWorkflowIds: [session.execution.workflowId], operatorPrincipals: [session.requester],
    currentRoster: async () => structuredClone(args.production.roster),
    connectors: async () => configured.map((connector) => scopeBuilderTestConnector(connector, { instanceId: session.instanceId,
      runId, resources: session.resources, assertActive })),
    qualifyMessageDestinations: async () => { throw new Error("This test profile does not permit workflow message dispatch."); },
    conversationForReceipt: async () => { throw new Error("This test profile does not create workflow conversations."); },
  });
  const run = await engine.openOperator({ workflowId: session.execution.workflowId, requestId: session.id, principal: session.requester, fields: session.execution.fields });
  runId = run.runId;
  const completed = await engine.advance(runId);
  if (!completed || completed.state.status !== "done" || completed.state.blocked) throw new Error("The actual candidate workflow did not finish successfully; inspect its retained execution evidence.");
  const events = await control.listEvents(runId);
  const evidence = JSON.parse(JSON.stringify({ kind: "workflow", runId, executionNamespace, artifactHash: artifact.artifactHash,
    manifestHash: completed.manifestHash, state: completed.state, events }));
  return { ...base, completedAt: completed.updatedAt, summary: `The candidate workflow ${completed.workflowId} completed. Its exact steps and provider receipts are retained under ${runId}.`, evidence };
}

/** History belongs to one retained candidate session; no live conversation is loaded. */
export function builderAgentTestMessages(session: BuilderTestSession): { role: "user" | "assistant"; content: string }[] {
  if (session.execution.kind !== "agent") throw new Error("Agent test messages require an Agent execution.");
  return [
    ...(session.conversation?.turns ?? []).flatMap((turn) => [
      { role: "user" as const, content: turn.prompt }, ...(turn.result.participation === "context-only" ? [] : [{ role: "assistant" as const, content: turn.result.summary }]),
    ]),
    { role: "user", content: session.conversation?.pending?.prompt ?? session.execution.prompt },
  ];
}

/** Retain silent human contributions with their original sender and time. */
export function builderAgentTestContext(session: BuilderTestSession): ConversationContextEntry[] {
  return (session.conversation?.turns ?? []).flatMap(turn => [
    { role: "user" as const, content: turn.prompt, message_id: turn.messageId, principal: turn.message?.senderId ?? session.requester,
      sender_name: turn.message?.senderName, sent_at: turn.message?.sentAt, in_reply_to: turn.message?.replyToId },
    ...(turn.result.participation === "context-only" ? [] : [{ role: "assistant" as const, content: turn.result.summary,
      in_reply_to: turn.messageId, sent_at: turn.result.completedAt }]),
  ]);
}
