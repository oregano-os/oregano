import assert from "node:assert/strict";
import { test } from "node:test";
import YAML from "yaml";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { engineArtifact, engineFixture, ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";
import { compileWorkflows } from "../../companyos-builder/workflow-compiler.ts";
import { readWorkspaceFiles } from "../../companyos-builder/workspace-files.ts";
import { sha256, jsonDigest } from "../../runtime/canonical.ts";
import { validateWorkflowState } from "../../runtime/workflow-engine/state-validation.ts";
import { guardWorkflowInvocation } from "../../runtime/workflow-engine/guard.ts";
import { workflowContext } from "../../runtime/workflow-engine/readers.ts";
import { AGENT_FINISH_TOOL, agentToolName, type WorkflowAgentGenerator } from "../../runtime/workflow-engine/agent-contract.ts";
import { parseWorkflowOperatorRequest } from "../../runner-vercel/src/lib/workflow-http.ts";
import { LanguageGenerationError } from "../../language/contracts.ts";
import { readLanguageAttempts } from "../../language/attempts.ts";
import type { ModelExecutionSelection } from "../../runner/model-execution.ts";
import { resolveModelExecutionSelection } from "../../runner/model-execution.ts";
import { WorkflowWorkers } from "../../runtime/workflow-engine/workers.ts";
import { advanceWorkflowAgent } from "../../runtime/workflow-engine/agent-execution.ts";

const selection = { profile: "reasoning", model: "synthetic/test", route: "openai-compatible" } as ModelExecutionSelection;
function fixture(change: (data: any, files: Record<string, string>, agent: any) => void = () => {}) {
  const artifact = structuredClone(engineArtifact()), agent = artifact.agents.find(agent => agent.id === "sprint")!;
  const files = { ...readWorkspaceFiles(resolve(import.meta.dirname, "../fixtures/lindenhof-studio")) };
  for (const path of Object.keys(files)) if (path.startsWith("workflows/")) delete files[path];
  const instruction = Object.keys(agent.materials).find(path => path.startsWith("agents/sprint/skills/"))!;
  assert.ok(instruction);
  const declaration = { type: "workflow", id: "agent-task", owner: "agents/sprint", version: 1, execution_mode: "unattended", trigger: "operator",
    steps: [{ work: "agent", failure_policy: "stop", context: { source: "Synthetic transcript", identity: "source-1" }, instructions: [instruction], profile: "reasoning", task: "sprint.test",
      tools: [{ tool: "oregano:directory/members", bind: {} }], output_schema: { type: "object", additionalProperties: false, required: ["verified"], properties: { verified: { const: true } } },
      budget: { turns: 8, tool_calls: 16, output_tokens: 8000 } }] };
  // Use the actual directory grant spelling resolved by the fixture.
  declaration.steps[0]!.tools[0]!.tool = agent.toolSet.tools.find(tool => tool.runtimeId.includes("directory"))!.grantId;
  change(declaration, files, agent);
  files["workflows/agent-task.md"] = `---\n${YAML.stringify(declaration)}---\n## Steps\n${declaration.steps.map((step, i) => `${i + 1}. [sprint, R0] Continue the task. <!-- step:${Object.keys(step)[0]} -->`).join("\n")}\n`;
  artifact.workflows = compileWorkflows({ files, agents: artifact.agents, provenance: artifact.workflows![0]!.provenance });
  const { artifactHash, ...content } = artifact;
  artifact.artifactHash = sha256({ ...content, provenance: { ...content.provenance, builtAt: undefined } });
  return artifact;
}
const open = (h: ReturnType<typeof engineFixture>, fields: Record<string, string> = {}) => h.engine().openOperator({ workflowId: "agent-task", requestId: randomUUID(), principal: ENGINE_OPERATOR, fields });
function model(rounds: Array<Array<{ name: string; input: any }>>) {
  let calls = 0; const requests: any[] = [];
  const generate: WorkflowAgentGenerator = async request => {
    requests.push(structuredClone({ context: request.context, turns: request.turns }));
    await request.beforeDispatch(selection, { system_prompt_digest: "a".repeat(64), system_instruction_characters: 12 }, { inputBytes: 1000, outputTokens: request.outputTokens });
    const round = rounds[calls++]!; assert.ok(round, "unexpected model dispatch");
    return { response: { messages: [], text: "", finishReason: "tool-calls", calls: round.map((call, i) => ({ ...call, id: `call-${calls}-${i}` })) },
      evidence: { model_execution: { ...selection, inputTokens: 100, outputTokens: 20 } } };
  };
  return { generate, requests, get calls() { return calls; } };
}

test("compiler binds an Agent step to scoped Skills, finite budgets and exact R0/R1 grants", () => {
  const artifact = fixture(), step = artifact.workflows![0]!.steps[0]!;
  assert.equal(step.kind, "agent"); assert.equal(step.agent?.budget.outputTokens, 8000);
  assert.throws(() => fixture(data => data.steps[0].budget.turns = 65), /budget/);
  assert.throws(() => fixture(data => data.steps[0].instructions = ["company.md"]), /Skill/);
  assert.throws(() => fixture(data => data.steps[0].tools = [{ tool: "oregano:communications/publish" }]), /R0.R1/);
  assert.throws(() => fixture(data => data.steps[0].tools.push(data.steps[0].tools[0])), /unique/);
});

test("a referenced model task reaches task-specific resolution and durable attempt evidence", async () => {
  for (const role of ["reasoning", "deep"] as const) {
    const modelTask = role === "deep" ? "analyst.ingest.deep" : "analyst.ingest";
    const artifact = fixture(data => {
      const work = data.steps[0];
      const { work: tool, ...options } = structuredClone(work);
      data.steps.unshift({ select: tool, ...options, output_schema: { type: "object", required: ["model_task"],
        properties: { model_task: { type: "string", enum: ["analyst.ingest", "analyst.ingest.deep"] } } } });
      work.task = "$steps.select.result.model_task"; work.profile = role;
    });
    assert.ok(artifact.workflows![0]!.steps[0]!.requiredOutputPaths.some(path => path.join(".") === "result.model_task"));
    const m = model([[{ name: AGENT_FINISH_TOOL, input: { model_task: modelTask } }], [{ name: AGENT_FINISH_TOOL, input: { verified: true } }]]);
    const h = engineFixture({ artifact, agentGenerator: async request => {
      if (request.task !== "sprint.test") {
        assert.equal(request.task, modelTask); assert.equal(request.profile, role);
        const binding = resolveModelExecutionSelection({ task: request.task, profile: request.profile, environment: {}, configuration: {
          version: 1, tasks: {
            "analyst.ingest": { route: "vercel-ai-gateway", model: "synthetic/reasoning" },
            "analyst.ingest.deep": { route: "vercel-ai-gateway", model: "synthetic/deep" },
          },
        } });
        assert.equal(binding.model, `synthetic/${role}`);
      }
      return m.generate(request);
    } });
    const run = (await h.engine().advance((await open(h)).runId))!;
    assert.equal(run.state.status, "done", JSON.stringify(run.state.blocked)); assert.equal(m.calls, 2);
    const attempt = (await readLanguageAttempts(h.control, [run.runId])).find(attempt => attempt.step_id === "work")!;
    assert.equal(attempt.evidence.model_task, modelTask);
  }
  assert.throws(() => fixture(data => data.steps[0].task = "$steps.missing.model_task"), /missing|unknown/);
});

test("invalid or changed task references stop before paid dispatch and literals retain resume identity", async () => {
  const referenced = () => fixture(data => { data.instance = { fields: ["model_task"] }; data.steps[0].task = "$instance.model_task"; });
  const m = model([[{ name: AGENT_FINISH_TOOL, input: { verified: true } }]]);
  for (const value of ["$instance.injected", "not a task", "x".repeat(257)]) {
    const h = engineFixture({ artifact: referenced(), agentGenerator: m.generate });
    const run = (await h.engine().advance((await open(h, { model_task: value })).runId))!;
    assert.equal(run.state.status, "waiting"); assert.equal(m.calls, 0);
    assert.equal((await readLanguageAttempts(h.control, [run.runId])).length, 0);
  }
  const h = engineFixture({ artifact: referenced(), agentGenerator: m.generate });
  await assert.rejects(open(h), /model_task/);
  const run = (await h.engine().step((await open(h, { model_task: "analyst.ingest" })).runId))!;
  const changed = structuredClone(run); changed.fields.model_task = "analyst.ingest.deep";
  await assert.rejects(advanceWorkflowAgent({ run: changed, artifact: h.artifact, workflow: h.artifact.workflows![0]!,
    step: h.artifact.workflows![0]!.steps[0]!, now: h.now,
    options: { agentGenerator: m.generate, currentRoster: async () => h.roster } as any }), /input changed/);
  assert.equal(m.calls, 0);
  const literal = engineFixture({ artifact: fixture(), agentGenerator: m.generate });
  const prepared = (await literal.engine().step((await open(literal)).runId))!;
  assert.equal(prepared.state.steps.work!.inputDigest, jsonDigest({ context: { source: "Synthetic transcript", identity: "source-1" }, profile: "reasoning" }));
  assert.equal((await literal.engine().advance(prepared.runId))!.state.status, "done"); assert.equal(m.calls, 1);
});

test("cumulative input budget stops before another paid dispatch and survives resume", async () => {
  const artifact = fixture(data => { data.steps[0].budget.total_input_bytes = 1000; data.steps[0].budget.total_output_tokens = 8000; });
  const name = agentToolName(artifact.workflows![0]!.steps[0]!.agent!.tools[0]!.tool.grantId);
  const m = model([[{ name, input: {} }], [{ name: AGENT_FINISH_TOOL, input: { verified: true } }]]);
  const h = engineFixture({ artifact, agentGenerator: m.generate });
  let run = (await h.engine().advance((await open(h)).runId))!;
  assert.equal(m.calls, 1); assert.equal(run.state.status, "waiting");
  assert.deepEqual(run.state.steps.work!.agent!.turns[0]!.requestBudget, { inputBytes: 1000, outputTokens: 8000 });
  assert.equal(run.state.steps.work!.agent!.turns[0]!.outputTokensUsed, 20);
  await h.engine().resume(run.runId, ENGINE_OPERATOR); run = (await h.engine().advance(run.runId))!;
  assert.equal(m.calls, 1); assert.equal(run.state.status, "waiting");
  const attempts = await readLanguageAttempts(h.control, [run.runId]);
  assert.equal(attempts.filter(a => a.dispatched_at).length, 1);
  assert.ok(attempts.some(a => a.status === "failed" && !a.dispatched_at));
});

test("omitting cumulative input limits permits larger totals while preserving accounting and output limits", async () => {
  for (const usedOutput of [20, 8000]) {
    const artifact = fixture(data => { data.steps[0].budget.total_output_tokens = 8000; });
    assert.equal(artifact.workflows![0]!.steps[0]!.agent!.budget.totalInputBytes, undefined);
    const name = agentToolName(artifact.workflows![0]!.steps[0]!.agent!.tools[0]!.tool.grantId);
    const m = model([[{ name, input: {} }], [{ name: AGENT_FINISH_TOOL, input: { verified: true } }]]);
    const h = engineFixture({ artifact, agentGenerator: async request => {
      const result = await m.generate({ ...request, beforeDispatch: (selection, evidence, reservation) =>
        request.beforeDispatch(selection, evidence, { ...reservation!, inputBytes: 1_100_000 }) });
      return { ...result, evidence: { ...result.evidence,
        model_execution: { ...selection, inputTokens: 100, outputTokens: usedOutput } } };
    } });
    const run = (await h.engine().advance((await open(h)).runId))!;
    const turns = run.state.steps.work!.agent!.turns;
    assert.equal(m.calls, usedOutput === 20 ? 2 : 1);
    assert.equal(run.state.status, usedOutput === 20 ? "done" : "waiting");
    assert.equal(turns.reduce((sum, turn) => sum + (turn.requestBudget?.inputBytes ?? 0), 0), m.calls * 1_100_000);
    assert.equal(turns[0]!.outputTokensUsed, usedOutput);
    if (usedOutput === 20) assert.equal(turns[1]!.requestBudget!.outputTokens, 7980);
  }
});

test("repeated rejected finishes stop without a new paid turn", async () => {
  const m = model(Array.from({ length: 3 }, () => [{ name: AGENT_FINISH_TOOL, input: { verified: false } }]));
  const h = engineFixture({ artifact: fixture(data => { data.steps[0].budget.no_progress_turns = 2; }), agentGenerator: m.generate });
  let run = (await h.engine().advance((await open(h)).runId))!;
  assert.equal(m.calls, 2); assert.equal(run.state.status, "waiting");
  await h.engine().resume(run.runId, ENGINE_OPERATOR); run = (await h.engine().advance(run.runId))!;
  assert.equal(m.calls, 2); assert.equal(run.state.steps.work!.agent!.turns.length, 2);
});

test("selected instructions cannot escape the declared owning Agent Skill scope", async () => {
  const artifact = fixture(data => { data.steps[0].skills = data.steps[0].instructions; data.steps[0].instruction_selection = ["agents/other/skills/injected/SKILL.md"]; });
  let calls = 0;
  const h = engineFixture({ artifact, agentGenerator: async () => { calls++; throw Error("Must not dispatch"); } });
  const run = (await h.engine().advance((await open(h)).runId))!;
  assert.equal(calls, 0); assert.equal(run.state.status, "waiting");
  assert.equal((await readLanguageAttempts(h.control, [run.runId])).length, 0);
});

test("routing eagerly delivers the selected Skill and excludes other scoped procedures", async () => {
  const selected = "agents/sprint/skills/selected/SKILL.md", unrelated = "agents/sprint/skills/unrelated/SKILL.md";
  const retired = "agents/sprint/skills/retired/SKILL.md";
  const artifact = fixture((data, files, agent) => {
    files[selected] = agent.materials[selected] = "Selected meeting procedure";
    files[unrelated] = agent.materials[unrelated] = "Unrelated media procedure";
    files[retired] = agent.materials[retired] = "Retired procedure still readable by the Agent";
    agent.materials["handbook/company.md"] = "Company reference context";
    data.steps[0].skills = [selected, unrelated]; data.steps[0].instruction_selection = [selected];
  });
  const m = model([[{ name: AGENT_FINISH_TOOL, input: { verified: true } }]]);
  const h = engineFixture({ artifact, agentGenerator: async request => {
    assert.ok(request.instructions.includes("Selected meeting procedure"));
    assert.ok(!request.instructions.includes("Unrelated media procedure"));
    assert.equal(request.agent.materials[unrelated], undefined);
    assert.equal(request.agent.materials[retired], undefined);
    assert.equal(request.agent.materials["handbook/company.md"], "Company reference context");
    assert.deepEqual(request.skills, []);
    return m.generate(request);
  } });
  const run = (await h.engine().advance((await open(h)).runId))!;
  assert.equal(run.state.status, "done", JSON.stringify(run.state.blocked)); assert.equal(m.calls, 1);
});

test("model response is durable before ordered Tool dispatch, with one continuing conversation", async () => {
  const artifact = fixture(), name = agentToolName(artifact.workflows![0]!.steps[0]!.agent!.tools[0]!.tool.grantId);
  const m = model([[{ name, input: {} }], [{ name: AGENT_FINISH_TOOL, input: { verified: true } }]]);
  const h = engineFixture({ artifact, agentGenerator: m.generate }); let run = await open(h);
  run = (await h.engine().step(run.runId))!; assert.equal(m.calls, 0);
  run = (await h.engine().step(run.runId))!; assert.equal(m.calls, 1); assert.equal(h.calls.length, 0);
  assert.equal(run.state.steps.work!.agent!.turns[0]!.response!.calls.length, 1);
  run = (await h.engine().step(run.runId))!; assert.equal(h.calls.length, 1); assert.equal(run.state.status, "running");
  run = (await h.engine().advance(run.runId))!;
  assert.equal(run.state.status, "done", JSON.stringify(run.state.blocked)); assert.equal(m.calls, 2);
  assert.equal(m.requests[1].turns[0].results.length, 1); assert.equal(m.requests[1].context.source, "Synthetic transcript");
  assert.deepEqual((run.state.steps.work!.output as any).result, { verified: true });
  const attempts = await readLanguageAttempts(h.control, [run.runId]); assert.equal(attempts.length, 2);
  assert.ok(attempts.every(a => a.status === "succeeded" && (a.evidence.model_execution as any).profile === "reasoning"));
  const tampered = structuredClone(run.state); tampered.steps.work!.agent!.turns[0]!.response!.calls[0]!.input = { injected: true };
  assert.throws(() => validateWorkflowState(tampered, run.workflowId, artifact, run.state), /immutable/);
});

test("invalid calls and completion schema return feedback without finishing or executing a Tool", async () => {
  const m = model([[{ name: "ungranted_tool", input: {} }, { name: AGENT_FINISH_TOOL, input: { verified: false } }], [{ name: AGENT_FINISH_TOOL, input: { verified: true } }]]);
  const h = engineFixture({ artifact: fixture(), agentGenerator: m.generate });
  const run = (await h.engine().advance((await open(h)).runId))!;
  assert.equal(run.state.status, "done", JSON.stringify(run.state.blocked)); assert.equal(h.calls.length, 0);
  assert.ok(m.requests[1].turns[0].results.every((r: any) => typeof r.error === "string"));
});

test("a lost read snapshot repeats only the read and retains the same model response", async () => {
  const artifact = fixture(), name = agentToolName(artifact.workflows![0]!.steps[0]!.agent!.tools[0]!.tool.grantId);
  const m = model([[{ name, input: {} }], [{ name: AGENT_FINISH_TOOL, input: { verified: true } }]]);
  const h = engineFixture({ artifact, agentGenerator: m.generate }); let run = await open(h);
  await h.engine().step(run.runId); await h.engine().step(run.runId);
  const commit = h.store.commit.bind(h.store); let drop = true;
  h.store.commit = async args => { if (drop && args.event.name === "workflow.agent-tool-completed") { drop = false; return undefined; } return commit(args); };
  run = (await h.engine().step(run.runId))!; assert.equal(h.calls.length, 1);
  h.now = "2030-01-04T14:41:00.000Z";
  run = (await h.engine().advance(run.runId))!;
  assert.equal(run.state.status, "done", JSON.stringify(run.state.blocked)); assert.equal(h.calls.length, 2); assert.equal(m.calls, 2);
});

test("unknown model outcomes stay stopped with charge evidence and no automatic paid retry", async () => {
  let calls = 0;
  const h = engineFixture({ artifact: fixture(), agentGenerator: async request => {
    calls++; await request.beforeDispatch(selection, { system_prompt_digest: "b".repeat(64), system_instruction_characters: 10 });
    throw new LanguageGenerationError("Synthetic unavailable result", "provider-error", { model_execution: { ...selection, inputTokens: null, outputTokens: null } });
  } });
  let run = (await h.engine().advance((await open(h)).runId))!;
  assert.equal(run.state.status, "waiting"); assert.equal(run.state.blocked?.code, "effect-needs-review");
  await h.engine().resume(run.runId, ENGINE_OPERATOR); run = (await h.engine().advance(run.runId))!;
  assert.equal(calls, 1); assert.ok(run.state.blocked); assert.equal((await readLanguageAttempts(h.control, [run.runId]))[0]!.status, "unknown");
});

test("incomplete known responses retain costs and stop until an explicit bounded retry", async () => {
  let calls = 0; const m = model([[{ name: AGENT_FINISH_TOOL, input: { verified: true } }]]);
  const h = engineFixture({ artifact: fixture(), agentGenerator: async request => {
    if (calls++ === 0) { await request.beforeDispatch(selection, { system_prompt_digest: "b".repeat(64), system_instruction_characters: 10 });
      throw new LanguageGenerationError("Length", "incomplete", { model_execution: { ...selection, inputTokens: 100, outputTokens: 8000 } }); }
    return m.generate(request);
  } });
  let run = (await h.engine().advance((await open(h)).runId))!;
  assert.equal(run.state.status, "waiting"); assert.equal(calls, 1);
  await h.engine().resume(run.runId, ENGINE_OPERATOR);
  run = (await h.engine().advance(run.runId))!; assert.equal(calls, 1);
  run = await h.engine().retryAgentModel(run.runId, ENGINE_OPERATOR, run.revision, run.state.steps.work!.agent!.turns.at(-1)!.attemptId, "Reviewed incomplete output retry");
  run = (await h.engine().advance(run.runId))!;
  assert.equal(run.state.status, "done", JSON.stringify(run.state.blocked));
  assert.deepEqual((await readLanguageAttempts(h.control, [run.runId])).map(a => a.status).sort(), ["failed", "succeeded"]);
});

test("an explicit exact retry continues the same Agent journal while keeping the unavailable attempt and charge", async () => {
  let count=0;const m=model([[{name:AGENT_FINISH_TOOL,input:{verified:true}}]]);
  const h=engineFixture({artifact:fixture(),agentGenerator:async request=>{
    if(count++===0){await request.beforeDispatch(selection,{system_prompt_digest:'b'.repeat(64),system_instruction_characters:10});
      throw new LanguageGenerationError('Synthetic timeout','provider-error',{model_execution:{...selection,inputTokens:null,outputTokens:null}});}
    return m.generate(request);
  }});
  let run=(await h.engine().advance((await open(h)).runId))!;
  const before=structuredClone(run),attemptId=run.state.steps.work!.agent!.turns.at(-1)!.attemptId;
  const attempts=await readLanguageAttempts(h.control,[run.runId]);
  await assert.rejects(h.engine().retryAgentModel(run.runId,'slack:T10001:U99999',run.revision,attemptId,'Reviewed retry'),/operator/);
  await assert.rejects(h.engine().retryAgentModel(run.runId,ENGINE_OPERATOR,run.revision+1,attemptId,'Reviewed retry'),/stale/);
  await assert.rejects(h.engine().retryAgentModel(run.runId,ENGINE_OPERATOR,run.revision,'language-attempt:'+randomUUID(),'Reviewed retry'),/blocked unavailable/);
  run=await h.engine().retryAgentModel(run.runId,ENGINE_OPERATOR,run.revision,attemptId,'Reviewed retry');
  assert.equal(run.runId,before.runId);assert.equal(run.artifactHash,before.artifactHash);assert.deepEqual(run.fields,before.fields);
  assert.deepEqual(run.state.steps.work!.agent!.turns[0]!.failure,before.state.steps.work!.agent!.turns[0]!.failure);
  assert.equal(run.state.steps.work!.agent!.turns[0]!.retryAuthorization!.principal,ENGINE_OPERATOR);
  assert.deepEqual(await readLanguageAttempts(h.control,[run.runId]),attempts);assert.equal(count,1);assert.equal(h.calls.length,0);
  const authorized=structuredClone(run.state);
  assert.deepEqual((await h.engine().retryAgentModel(run.runId,ENGINE_OPERATOR,before.revision,attemptId,'Reviewed retry')).state,authorized);
  await assert.rejects(h.engine().retryAgentModel(run.runId,ENGINE_OPERATOR,run.revision,attemptId,'Different reason'),/different authority/);
  run=(await h.engine().advance(run.runId))!;assert.equal(run.state.status,'done',JSON.stringify(run.state.blocked));assert.equal(count,2);
  assert.equal(run.state.steps.work!.agent!.turns.length,2);assert.equal(h.calls.length,0);
  assert.equal((await h.engine().retryAgentModel(run.runId,ENGINE_OPERATOR,before.revision,attemptId,'Reviewed retry')).revision,run.revision);
  assert.deepEqual((await readLanguageAttempts(h.control,[run.runId])).map(a=>a.status).sort(),['succeeded','unknown']);
  const changed=structuredClone(run.state);changed.steps.work!.agent!.turns[0]!.retryAuthorization!.principal='slack:T10001:U99999';
  assert.throws(()=>validateWorkflowState(changed,run.workflowId,h.artifact,run.state),/immutable/);
});

test("a retained model response cannot be discarded as an unavailable turn",async()=>{
 const artifact=fixture(),name=agentToolName(artifact.workflows![0]!.steps[0]!.agent!.tools[0]!.tool.grantId);
 const m=model([[{name,input:{}}]]),h=engineFixture({artifact,agentGenerator:m.generate});let run=await open(h);
 run=(await h.engine().step(run.runId))!;run=(await h.engine().step(run.runId))!;
 const attempt=run.state.steps.work!.agent!.turns[0]!.attemptId;
 await assert.rejects(h.engine().retryAgentModel(run.runId,ENGINE_OPERATOR,run.revision,attempt,'Cannot discard response'),/blocked unavailable/);
 assert.equal(m.calls,1);assert.equal(h.calls.length,0);
});

test("model retry is an exact operator action, never a replacement response or source reset",()=>{
 const request={action:'retry-agent-model',runId:'workflow:'+'a'.repeat(64),expectedRevision:7,attemptId:'language-attempt:'+randomUUID(),reason:'Authorized bounded retry'};
 assert.deepEqual(parseWorkflowOperatorRequest(request),request);
 for(const fields of [{expectedRevision:-1},{attemptId:'arbitrary'},{response:{}},{source_version:'v2'},{reason:''}])assert.throws(()=>parseWorkflowOperatorRequest({...request,...fields}));
});


test("Agent-step grants remain available to ordinary contexts while active assignments stay exact", async () => {
  const artifact = fixture(), workflow = artifact.workflows![0]!, selected = workflow.steps[0]!.agent!.tools[0]!.tool;
  const tool = artifact.agents.find(agent => agent.id === workflow.agentId)!.tools.find(tool => tool.contract.runtimeId === selected.runtimeId)!;
  const request = { runId: "ordinary-tool-invocation", stepId: "lookup", agentId: workflow.agentId, grantId: selected.grantId, input: {}, subjectPrincipal: ENGINE_OPERATOR };
  assert.deepEqual(workflow.reservedEffects, []);
  assert.equal(await guardWorkflowInvocation({ artifact, tool, risk: "R0", request, reader: { read: async () => undefined } }), undefined);
  await assert.rejects(guardWorkflowInvocation({ artifact, tool, risk: "R0", request }), /trusted workflow context/);
  const h = engineFixture({ artifact }); const run = await open(h);
  await h.engine().step(run.runId);
  const context = { ...workflowContext(run, artifact.roster), agentCall: { name: agentToolName(selected.grantId), input: {} } };
  const reader = { read: async () => context };
  await assert.rejects(guardWorkflowInvocation({ artifact, tool, risk: "R0", request, reader }), /assignment/);
  const assigned = { ...request, runId: run.runId, stepId: "work" };
  assert.ok(await guardWorkflowInvocation({ artifact, tool, risk: "R0", request: assigned, reader }));
  await assert.rejects(guardWorkflowInvocation({ artifact, tool, risk: "R0", request: { ...assigned, input: { injected: true } }, reader }), /persisted input/);
  // Reservations owned by another declared effect are not removed by Agent reuse.
  const retained = structuredClone(artifact); retained.workflows![0]!.reservedEffects = [selected.runtimeId];
  await assert.rejects(guardWorkflowInvocation({ artifact: retained, tool, risk: "R0", request, reader: { read: async () => undefined } }), /reserved/);
});

test("text completion is explicit, resumes a retained final response and never calls the model again", async () => {
  const configure = (data: any) => { data.steps[0].completion = "text"; delete data.steps[0].output_schema; };
  assert.throws(() => fixture(data => { data.steps[0].completion = "text"; }), /output_schema/);
  assert.throws(() => fixture(data => { configure(data); data.steps[0].validate = "company:unknown"; }), /validator/);
  const artifact = fixture(configure), step = artifact.workflows![0]!.steps[0]!;
  assert.equal(step.agent!.completion, "text");
  const name = agentToolName(step.agent!.tools[0]!.tool.grantId);
  const m = model([[{ name, input: {} }], []]);
  const h = engineFixture({ artifact, agentGenerator: async request => {
    assert.equal(request.completion, "text");
    const value = await m.generate(request);
    if (!value.response.calls.length) { value.response.text = "Finished the requested check. Remaining uncertainty is described here."; value.response.finishReason = "stop"; }
    return value;
  } });
  let run = await open(h);
  for (let i = 0; i < 20 && run.state.steps.work?.agent?.turns.at(-1)?.response?.finishReason !== "stop"; i++) run = (await h.engine().step(run.runId))!;
  assert.equal(m.calls, 2); assert.equal(run.state.steps.work!.status, "running");
  // Re-enter through a fresh engine after the terminal response was persisted.
  run = (await h.engine().advance(run.runId))!;
  assert.equal(run.state.status, "done", JSON.stringify(run.state.blocked)); assert.equal(m.calls, 2);
  const output = run.state.steps.work!.output as any;
  assert.match(output.result.text, /Remaining uncertainty/); assert.equal(output.calls.length, 1);
  await h.engine().advance(run.runId); assert.equal(m.calls, 2);
});

test("empty text and ordinary prose in structured mode cannot silently complete a task", async () => {
  for (const textMode of [true, false]) {
    const artifact = fixture(data => { data.steps[0].budget.no_progress_turns = 2;
      if (textMode) { data.steps[0].completion = "text"; delete data.steps[0].output_schema; } });
    const m = model([[], []]);
    const h = engineFixture({ artifact, agentGenerator: async request => {
      const value = await m.generate(request); value.response.finishReason = "stop";
      value.response.text = textMode ? "  " : "I claim this is complete."; return value;
    } });
    const run = (await h.engine().advance((await open(h)).runId))!;
    assert.equal(run.state.status, "waiting"); assert.equal(m.calls, 2);
    assert.notEqual(run.state.steps.work!.status, "succeeded");
  }
});

test("output-cutoff recovery preserves saved writes, charges the failed turn and survives worker restart", async () => {
  const artifact = fixture((data, _files, agent) => {
    const step = data.steps[0]; step.failure_policy = "continue-output-limit";
    step.budget = { turns: 12, tool_calls: 48, output_tokens: 32000, total_output_tokens: 48000, no_progress_turns: 3 };
    // Synthetic R1 Tool: the connector counts every invocation and has no deduplication.
    const grant = step.tools[0].tool;
    agent.tools.find((tool: any) => tool.contract.grantId === grant).contract.risk = "R1";
    const resolved = agent.toolSet.tools.find((tool: any) => tool.grantId === grant);
    resolved.risk = "R1"; resolved.contractDigest = sha256(agent.tools.find((tool: any) => tool.contract.grantId === grant).contract);
  });
  const name = agentToolName(artifact.workflows![0]!.steps[0]!.agent!.tools[0]!.tool.grantId);
  const m = model([[{ name, input: {} }], [{ name, input: {} }], [{ name: AGENT_FINISH_TOOL, input: { verified: true } }]]);
  let calls = 0;
  const h = engineFixture({ artifact, agentGenerator: async request => {
    if (calls++ === 1) {
      await request.beforeDispatch(selection, { system_prompt_digest: "a".repeat(64), system_instruction_characters: 12 }, { inputBytes: 1000, outputTokens: request.outputTokens });
      throw new LanguageGenerationError("Synthetic cutoff", "incomplete", { finish_reason: "length", model_execution: { outputTokens: 32000 } });
    }
    if (calls === 3) {
      assert.equal(request.outputTokens, 15980);
      assert.equal(request.turns[0]!.results.length, 1);
      assert.equal(request.turns[1]!.failure?.reason, "output-limit");
    }
    if (calls === 4) assert.match(request.turns[2]!.results[0]!.error!, /already succeeded/);
    return m.generate(request);
  } });
  let run = await open(h);
  while (!run.state.steps.work?.agent?.turns.at(-1)?.failure) run = (await h.engine().step(run.runId))!;
  const prior = structuredClone(run), paid = await readLanguageAttempts(h.control, [run.runId]);
  assert.equal(run.state.status, "running"); assert.equal(h.calls.length, 1);
  run = (await h.engine().advance(run.runId))!;
  assert.equal(run.state.status, "done", JSON.stringify(run.state.blocked)); assert.equal(calls, 4);
  assert.equal(run.runId, prior.runId); assert.equal(run.artifactHash, prior.artifactHash);
  assert.deepEqual(run.fields, prior.fields);
  assert.deepEqual(run.state.steps.work!.agent!.turns.slice(0, 2), prior.state.steps.work!.agent!.turns);
  assert.equal(h.calls.length, 1, "An exact repeated confirmed R1 write must not dispatch");
  const attempts = await readLanguageAttempts(h.control, [run.runId]);
  assert.equal(attempts.length, 4); assert.equal(attempts.filter(a => a.status === "failed").length, 1);
  for (const earlier of paid) assert.deepEqual(attempts.find(a => a.attempt_id === earlier.attempt_id), earlier);
  await h.engine().advance(run.runId); assert.equal(calls, 4); assert.equal(h.calls.length, 1);
});

test("output recovery permits only confirmed length failures; stop and unknown outcomes remain blocked", async () => {
  for (const [policy, kind, finish] of [
    ["stop", "incomplete", "length"], ["continue-output-limit", "provider-error", "length"],
    ["continue-output-limit", "incomplete", "content-filter"], ["continue-output-limit", "incomplete", undefined],
  ] as const) {
    let calls = 0;
    const h = engineFixture({ artifact: fixture(data => { data.steps[0].failure_policy = policy; }), agentGenerator: async request => {
      calls++; await request.beforeDispatch(selection, { system_prompt_digest: "a".repeat(64), system_instruction_characters: 12 });
      throw new LanguageGenerationError("Synthetic incomplete outcome", kind, { finish_reason: finish });
    } });
    let run = (await h.engine().advance((await open(h)).runId))!;
    assert.equal(run.state.status, "waiting"); assert.equal(calls, 1);
    await h.engine().resume(run.runId, ENGINE_OPERATOR); run = (await h.engine().advance(run.runId))!;
    assert.equal(run.state.status, "waiting"); assert.equal(calls, 1);
  }
});

test("consecutive cutoffs exhaust no-progress, cumulative output or turn bounds without resets", async () => {
  for (const limit of ["no-progress", "output", "turns", "missing-usage"]) {
    let calls = 0;
    const artifact = fixture(data => {
      data.steps[0].failure_policy = "continue-output-limit";
      data.steps[0].budget = { turns: limit === "turns" ? 1 : 12, tool_calls: 48, output_tokens: 32000,
        total_output_tokens: 48000, no_progress_turns: limit === "no-progress" ? 2 : 8 };
    });
    const h = engineFixture({ artifact, agentGenerator: async request => {
      calls++; await request.beforeDispatch(selection, { system_prompt_digest: "a".repeat(64), system_instruction_characters: 12 }, { inputBytes: 1000, outputTokens: request.outputTokens });
      if (calls === 2 && ["output", "missing-usage"].includes(limit)) assert.equal(request.outputTokens, 16000);
      throw new LanguageGenerationError("Synthetic cutoff", "incomplete", { finish_reason: "length",
        model_execution: limit === "missing-usage" ? {} : { outputTokens: limit === "no-progress" ? 100 : request.outputTokens } });
    } });
    let run = (await h.engine().advance((await open(h)).runId))!;
    assert.equal(run.state.status, "waiting"); assert.equal(calls, limit === "turns" ? 1 : 2);
    assert.equal(h.calls.length, 0);
    await h.engine().resume(run.runId, ENGINE_OPERATOR); run = (await h.engine().advance(run.runId))!;
    assert.equal(calls, limit === "turns" ? 1 : 2); assert.equal(run.state.status, "waiting");
  }
});

test("recovery rejects oversized operation batches before dispatch and then accepts one operation", async () => {
  const artifact = fixture(data => { data.steps[0].failure_policy = "continue-output-limit"; });
  const name = agentToolName(artifact.workflows![0]!.steps[0]!.agent!.tools[0]!.tool.grantId);
  const m = model([[{ name, input: {} }, { name, input: {} }], [{ name, input: {} }], [{ name: AGENT_FINISH_TOOL, input: { verified: true } }]]);
  let calls = 0;
  const h = engineFixture({ artifact, agentGenerator: async request => {
    if (calls++ === 0) {
      await request.beforeDispatch(selection, { system_prompt_digest: "a".repeat(64), system_instruction_characters: 12 });
      throw new LanguageGenerationError("Synthetic cutoff", "incomplete", { finish_reason: "length" });
    }
    return m.generate(request);
  } });
  const run = (await h.engine().advance((await open(h)).runId))!;
  assert.equal(run.state.status, "done", JSON.stringify(run.state.blocked)); assert.equal(h.calls.length, 1);
  assert.ok(run.state.steps.work!.agent!.turns[1]!.results.every(r => /exactly one small/.test(r.error!)));
});

test("Agent response persists after the old five-minute lease boundary", async () => {
  const m = model([[{ name: AGENT_FINISH_TOOL, input: { verified: true } }]]);
  const h = engineFixture({ artifact: fixture(), agentGenerator: async request => {
    const value = await m.generate(request);
    h.now = new Date(Date.parse(h.now) + 350_000).toISOString();
    return value;
  } });
  const run = (await h.engine().advance((await open(h)).runId))!;
  assert.equal(run.state.status, "done", JSON.stringify(run.state.blocked)); assert.equal(m.calls, 1);
});


test("the steps worker retains its timer lease while a long Agent response is saved", async () => {
  const m = model([[{ name: AGENT_FINISH_TOOL, input: { verified: true } }]]);
  const h = engineFixture({ artifact: fixture(), agentGenerator: async request => {
    const value = await m.generate(request);
    h.now = new Date(Date.parse(h.now) + 350_000).toISOString();
    return value;
  } });
  const run = await open(h);
  const workers = new WorkflowWorkers({ artifact: h.artifact, engine: h.engine(), store: h.store, timers: h.timers, clock: () => h.now,
    configuration: { enabledWorkflowIds: [run.workflowId], autoOpenWorkflowIds: [], schedulePrincipal: ENGINE_OPERATOR, activatedAt: h.now, maxLatenessMinutes: 5 } });
  const result = await workers.run("steps");
  assert.equal(result.ok, true, JSON.stringify(result.errors)); assert.equal(m.calls, 1);
  assert.equal((await h.store.read(run.instanceId, run.runId))!.state.status, "done");
  assert.equal((await h.timers.list("workflow-host-steps"))[0]!.state, "completed");
});
