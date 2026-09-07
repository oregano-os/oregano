import { ToolLoopAgent, jsonSchema, stepCountIs, tool } from "ai";
import type { CompanyOSArtifact } from "../../../companyos-builder/types.ts";
import { sha256 } from "../../../runtime/canonical.ts";
import { COLLECTION_TOOL_DESCRIPTION, collectionSchema, validateCollection } from "../../../runtime/workflow-engine/collection.ts";
import { agentInstructions } from "./agent-instructions.ts";
import { agentModelTask } from "./agent-model-task.ts";
import { modelExecutionEvidence, resolveModelExecution } from "./model-execution.ts";

export interface ConversationCheck {
  action: "check-conversation";
  workflowId: string;
  stepId: string;
  context: Record<string, unknown>;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

export function parseConversationCheck(value: Record<string, unknown>): ConversationCheck {
  if (Object.keys(value).some((key) => !["action", "workflowId", "stepId", "context", "messages"].includes(key))
    || typeof value.workflowId !== "string" || !/^[a-z][a-z0-9-]{1,62}$/.test(value.workflowId)
    || typeof value.stepId !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(value.stepId)
    || !value.context || typeof value.context !== "object" || Array.isArray(value.context)
    || !Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 10
    || value.messages.some((message) => !message || typeof message !== "object" || Array.isArray(message)
      || Object.keys(message).some((key) => !["role", "content"].includes(key))
      || !["user", "assistant"].includes(message.role) || typeof message.content !== "string"
      || !message.content.trim() || message.content.length > 8000)
    || value.messages.at(-1)?.role !== "user") throw new Error("Invalid bounded conversation check");
  return { action: "check-conversation", workflowId: value.workflowId, stepId: value.stepId,
    context: value.context as Record<string, unknown>, messages: value.messages };
}

export function conversationCheckTarget(artifact: CompanyOSArtifact, input: ConversationCheck, deploymentEnvironment: string | undefined) {
  if (artifact.instance.environment === "production" || deploymentEnvironment !== "preview") {
    throw new Error("Conversation checks require an isolated Preview Instance");
  }
  const workflow = artifact.workflows?.find((candidate) => candidate.id === input.workflowId);
  const step = workflow?.steps.find((candidate) => candidate.id === input.stepId);
  const agent = artifact.agents.find((candidate) => candidate.id === workflow?.agentId);
  if (!agent || step?.kind !== "collect" || !step.collect || step.conversationalTools.length !== 0) {
    throw new Error("Conversation checks support only compiled collection steps without business Tools");
  }
  return { agent, step };
}

/** Model-only evaluation: no workflow state, provider effect, decision or chat write. */
export async function checkWorkflowConversation(artifact: CompanyOSArtifact, input: ConversationCheck) {
  const { agent, step } = conversationCheckTarget(artifact, input, process.env.VERCEL_ENV);
  const task = agentModelTask(agent);
  const resolved = resolveModelExecution({ profile: task.profile, task: task.task, requiredCapability: "tools" });
  const collected: Record<string, string>[] = [];
  const tools = { companyos_collect_facts: tool({ description: COLLECTION_TOOL_DESCRIPTION,
    inputSchema: jsonSchema(collectionSchema(step.collect!.fields)), execute: async (value: unknown) => {
      validateCollection(step, value); collected.push(structuredClone(value));
      return { ok: true, evaluationOnly: true, collected: true, approvalRecorded: false, externalWrite: false };
    } }) };
  const instructions = agentInstructions(agent, { kind: "auto" }, Object.keys(tools), input.context);
  const modelAgent = new ToolLoopAgent({ id: "companyos-conversation-check", model: resolved.model,
    instructions, tools, stopWhen: stepCountIs(3), maxOutputTokens: Math.min(resolved.selection.maxOutputTokens ?? 4096, 8192), maxRetries: 0 });
  const result = await modelAgent.generate({ messages: input.messages,
    abortSignal: AbortSignal.timeout(Math.min(resolved.selection.timeoutMs ?? 90_000, 90_000)) });
  return { ok: true, evaluationOnly: true, artifactHash: artifact.artifactHash, agentId: agent.id,
    workflowId: input.workflowId, stepId: input.stepId, promptHash: sha256(instructions), inputHash: sha256(input),
    modelExecution: modelExecutionEvidence(resolved.selection, result), text: result.text, collected,
    externalEffects: [], humanDecisions: [], workflowStateChanged: false };
}
