import { agentBudgetUsed, agentNoProgressTurns } from "./agent-budgets.ts";
import { randomUUID } from "node:crypto";
import type { JsonValue } from "../../capabilities/contracts.ts";
import { validateJsonSchemaValue } from "../../capabilities/validation.ts";
import type { CompanyOSArtifact } from "../../companyos-builder/types.ts";
import type { CompiledWorkflow, CompiledWorkflowStep } from "../../companyos-builder/workflow-types.ts";
import type { WorkflowRun } from "../../state-store/workflow-engine.ts";
import type { WorkflowEngineOptions } from "./engine.ts";
import { CompanyOSRuntime } from "../companyos-runtime.ts";
import { sha256, jsonDigest } from "../canonical.ts";
import { LanguageAttempt, languageFailureDigest } from "../../language/attempts.ts";
import { LanguageGenerationError } from "../../language/contracts.ts";
import { CollectionNeedsInput, validateCollectionCandidate } from "./collection.ts";
import { resolveWorkflowValue } from "./references.ts";
import { workflowContext, WorkflowRunContextReader } from "./readers.ts";
import { workflowEffectKey, workflowExecutionStepId } from "./guard.ts";
import { BrainError } from "../../brain/contracts.ts";
import { AGENT_SKILL_TOOL, AGENT_FINISH_TOOL, agentCallKey, agentToolName } from "./agent-contract.ts";

/** One durable quantum: prepare a model turn, retain its response, or execute one saved call. */
export async function advanceWorkflowAgent(args: {
  run: WorkflowRun; artifact: CompanyOSArtifact; workflow: CompiledWorkflow; step: CompiledWorkflowStep;
  options: WorkflowEngineOptions; now: string;
}) {
  const { run, artifact, workflow, step, options, now } = args, definition = step.agent!;
  if (!options.agentGenerator) throw new Error("Tool-enabled Agent execution is unavailable on this host");
  const state = structuredClone(run.state), context = workflowContext(run, await options.currentRoster());
  const task = resolveWorkflowValue(definition.context, workflow, context), profile = resolveWorkflowValue(definition.profile, workflow, context);
  if (profile !== "utility" && profile !== "reasoning" && profile !== "deep") throw new Error("Invalid Agent model role");
  const modelTask = resolveWorkflowValue(definition.task, workflow, context);
  if (typeof modelTask !== "string" || !/^[a-z][a-z0-9._-]{0,255}$/.test(modelTask)) throw new Error("Invalid Agent model task");
  // Static tasks remain frozen by the Artifact. Preserve their historical digest
  // so existing journals resume unchanged; bind newly supported references too.
  const inputDigest = jsonDigest({ context: task, profile, ...(definition.task.startsWith("$") ? { modelTask } : {}) });
  const stored = state.steps[step.id] ??= { status: "running", startedAt: now, inputDigest, agent: { turns: [] } };
  if (stored.inputDigest !== inputDigest || !stored.agent) throw new Error("Agent task input changed after preparation");
  stored.status = "running";
  const turns = stored.agent.turns, last = turns.at(-1);
  const result = (event: string, evidence: JsonValue = {}, output?: JsonValue) => ({ state, event, evidence, output });
  if (last?.failure && (last.failure.outcome === "unknown" || definition.failurePolicy === "stop") && !last.retryAuthorization) throw new Error("Agent model outcome requires reconciliation; no automatic paid retry");
  if (!last || last.failure || (last.response && last.results.length === last.response.calls.length)) {
    if (definition.budget.noProgressTurns !== undefined && agentNoProgressTurns(turns) >= definition.budget.noProgressTurns) throw new Error("Agent stopped after repeated turns without new evidence or successful operations");
    if (turns.length >= definition.budget.turns) throw new Error("Agent model-turn budget exhausted");
    turns.push({ attemptId: `language-attempt:${randomUUID()}`, results: [] });
    return result("workflow.agent-turn-prepared", { turn: turns.length - 1 });
  }
  const agent = artifact.agents.find(entry => entry.id === workflow.agentId)!;
  const reader = new WorkflowRunContextReader({ store: options.store, instanceId: run.instanceId, runId: run.runId,
    leaseToken: run.lease!.token, roster: options.currentRoster, clock: () => options.clock?.() ?? new Date().toISOString(),
    ...(last.response ? { itemKey: agentCallKey(turns.length - 1, last.results.length) } : {}) });
  if (!last.response) {
    // A lost response must never become a silent second paid dispatch.
    if (await options.control.getEffect(last.attemptId)) throw new Error("Persisted Agent attempt has no retained response; reconciliation required");
    const fence = (await reader.read()).dispatchFence;
    const attempt = new LanguageAttempt(options.control, { runId: run.runId, stepId: step.id,
      inputHash: sha256({ inputDigest, turns }), fence,
      evidence: { workflow_id: workflow.id, artifact_hash: artifact.artifactHash, model_profile: profile, model_task: modelTask, agent_turn: turns.length - 1 } }, last.attemptId);
    const previous = turns.slice(0, -1), used = agentBudgetUsed(previous);
    if ((definition.budget.totalInputBytes !== undefined || definition.budget.totalOutputTokens !== undefined)
      && previous.some(turn => !turn.requestBudget)) throw new Error("Cumulative Agent budget evidence is missing");
    const outputTokens = Math.min(definition.budget.outputTokens, (definition.budget.totalOutputTokens ?? Infinity) - used.outputTokens);
    if (outputTokens < 1) throw new Error("Agent cumulative output-token budget exhausted");
    const chosen = definition.instructionSelection === undefined ? [] : resolveWorkflowValue(definition.instructionSelection, workflow, context);
    if (!Array.isArray(chosen) || chosen.some(path => typeof path !== "string" || !definition.skills?.includes(path))
      || new Set(chosen).size !== chosen.length) throw new Error("Agent instruction selection exceeds its compiled Skill scope");
    const selected = chosen as string[];
    const instructions = [...new Set([...definition.instructions, ...selected])];
    const scopedAgent = definition.instructionSelection === undefined ? agent : { ...agent,
      // Explicit routing also excludes retired or unrelated Skills present in a
      // broad Agent read scope but absent from this step's declared choices.
      materials: Object.fromEntries(Object.entries(agent.materials).filter(([path]) =>
        !/^agents\/[^/]+\/skills\//.test(path) || instructions.includes(path))) };
    await attempt.prepare();
    let received = false;
    try {
      const generated = await options.agentGenerator({ agent: scopedAgent, instructions: instructions.map(path => agent.materials[path]!),
        context: task, skills: definition.instructionSelection === undefined ? definition.skills : [], profile, task: modelTask, outputTokens,
        outputSchema: definition.outputSchema, turns: turns.slice(0, -1),
        tools: definition.tools.map(entry => {
          const tool = agent.tools.find(tool => tool.contract.runtimeId === entry.tool.runtimeId)!;
          const inputSchema = structuredClone(tool.contract.inputSchema);
          for (const key of Object.keys(entry.bind)) delete (inputSchema.properties as Record<string, unknown> | undefined)?.[key];
          if (Array.isArray(inputSchema.required)) inputSchema.required = inputSchema.required.filter(key => !Object.hasOwn(entry.bind, String(key)));
          return { name: agentToolName(entry.tool.grantId), description: tool.contract.description ?? entry.tool.grantId, inputSchema };
        }), beforeDispatch: async (selection, evidence, reservation) => {
          if (reservation && (!Number.isSafeInteger(reservation.inputBytes) || reservation.inputBytes < 1
            || !Number.isSafeInteger(reservation.outputTokens) || reservation.outputTokens < 1 || reservation.outputTokens > outputTokens)) throw new Error("Invalid host Agent budget reservation");
          if ((definition.budget.totalInputBytes !== undefined || definition.budget.totalOutputTokens !== undefined) && !reservation) throw new Error("Host must provide cumulative Agent budget evidence before dispatch");
          if (reservation && used.inputBytes + reservation.inputBytes > (definition.budget.totalInputBytes ?? Infinity)) throw new Error("Agent cumulative input-byte budget exhausted before model dispatch");
          if (reservation) { last.requestBudget = reservation; attempt.context.evidence.agent_request_budget = reservation; }
          await attempt.dispatch(selection, evidence);
        } });
      const usage = (generated.evidence.model_execution as { outputTokens?: unknown } | undefined)?.outputTokens;
      if (last.requestBudget && typeof usage === "number" && Number.isSafeInteger(usage) && usage >= 0) last.outputTokensUsed = usage;
      last.response = structuredClone(generated.response);
      received = true;
      await attempt.finish("succeeded", generated.evidence);
      return result("workflow.agent-response-retained", { turn: turns.length - 1, response_digest: sha256(last.response) });
    } catch (error) {
      if (received) throw error; // Never downgrade a known response if receipt/event persistence fails.
      const outcome = !attempt.dispatched || error instanceof LanguageGenerationError && error.kind === "incomplete" ? "failed" : "unknown";
      const usage = error instanceof LanguageGenerationError ? (error.evidence.model_execution as { outputTokens?: unknown } | undefined)?.outputTokens : undefined;
      if (last.requestBudget && typeof usage === "number" && Number.isSafeInteger(usage) && usage >= 0) last.outputTokensUsed = usage;
      await attempt.finish(outcome, { ...(error instanceof LanguageGenerationError ? error.evidence : {}), error_digest: languageFailureDigest(error) });
      last.failure = { outcome, digest: languageFailureDigest(error) };
      delete last.response;
      if (outcome === "unknown" || definition.failurePolicy === "stop") { state.status = "waiting"; state.blocked = { stepId: step.id, code: "effect-needs-review", errorDigest: last.failure.digest }; }
      return result("workflow.agent-attempt-failed", { turn: turns.length - 1, outcome });
    }
  }
  const callIndex = last.results.length, call = last.response.calls[callIndex]!, key = agentCallKey(turns.length - 1, callIndex);
  if (turns.reduce((n, turn) => n + (turn.response?.calls.length ?? 0), 0) > definition.budget.toolCalls) throw new Error("Agent Tool-call budget exhausted");
  const reject = (feedback: string) => {
    last.results.push({ callId: call.id, error: feedback.slice(0, 2000) });
    return result("workflow.agent-tool-feedback", { call_key: key, feedback_digest: sha256(feedback) });
  };
  if (call.name === AGENT_SKILL_TOOL) {
    const input = call.input as Record<string, JsonValue>;
    if (!input || Object.keys(input).join(",") !== "path" || typeof input.path !== "string" || !definition.skills?.includes(input.path)) return reject("Skill is not in this task's declared scope.");
    last.results.push({ callId: call.id, output: { path: input.path, instructions: agent.materials[input.path]! } });
    return result("workflow.agent-skill-read", { call_key: key, path: input.path });
  }
  if (call.name === AGENT_FINISH_TOOL) {
    if (callIndex !== last.response.calls.length - 1) return reject("Finish must be the last Tool call of a turn.");
    const errors = validateJsonSchemaValue(definition.outputSchema, call.input);
    if (errors.length) return reject(errors.join("; "));
    const calls = turns.flatMap(turn => turn.results.map((entry, i) => ({ ...turn.response!.calls[i]!, ...entry })));
    try { await validateCollectionCandidate({ artifact, agentId: agent.id, runId: run.runId, step, validator: definition.validator,
      context: { task, calls }, facts: call.input }); }
    catch (error) { if (error instanceof CollectionNeedsInput) return reject(error.feedback); throw error; }
    last.results.push({ callId: call.id, output: { accepted: true } });
    return result("workflow.agent-completed", { turns: turns.length, tool_calls: calls.length }, { result: call.input, calls });
  }
  const entry = definition.tools.find(entry => agentToolName(entry.tool.grantId) === call.name);
  if (!entry) return reject("Tool is not in this task's registered allowlist.");
  if (!call.input || typeof call.input !== "object" || Array.isArray(call.input)) return reject("Tool input must be an object.");
  const input = { ...call.input, ...resolveWorkflowValue(entry.bind, workflow, context) as Record<string, JsonValue> };
  const tool = agent.tools.find(tool => tool.contract.runtimeId === entry.tool.runtimeId)!;
  const errors = validateJsonSchemaValue(tool.contract.inputSchema, input);
  if (errors.length) return reject(errors.join("; "));
  const runtime = new CompanyOSRuntime({ artifact, state: options.control, connectors: await options.connectors(artifact), workflowContext: reader });
  let output: unknown;
  try { output = await runtime.execute({ runId: run.runId, stepId: workflowExecutionStepId(step.id, key), agentId: workflow.agentId,
    grantId: entry.tool.grantId, input, subjectPrincipal: run.subjectPrincipal }); }
  catch (error) {
    const effect = await options.control.getEffect(workflowEffectKey(artifact, { ...context, itemKey: key }));
    if (entry.tool.risk === "R0" || effect?.status === "failed") return reject(error instanceof BrainError ? `${error.code}: ${error.message}` : `Tool failed (${languageFailureDigest(error)}). Read current evidence and correct the request before retrying.`);
    throw error;
  }
  if (!output || typeof output !== "object" || !Object.hasOwn(output, "output")) throw new Error("Agent Tool has no verified outcome; reconciliation required");
  last.results.push({ callId: call.id, input, output: (output as { output: JsonValue }).output });
  return result("workflow.agent-tool-completed", { call_key: key, output_digest: jsonDigest(last.results.at(-1)!.output) });
}
