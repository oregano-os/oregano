import assert from "node:assert/strict";
import { test } from "node:test";
import YAML from "yaml";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { engineArtifact, engineFixture, ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";
import { compileWorkflows } from "../../companyos-builder/workflow-compiler.ts";
import { readWorkspaceFiles } from "../../companyos-builder/workspace-files.ts";
import { sha256 } from "../../runtime/canonical.ts";
import { validateWorkflowState } from "../../runtime/workflow-engine/state-validation.ts";
import { guardWorkflowInvocation } from "../../runtime/workflow-engine/guard.ts";
import { WorkflowRunContextReader } from "../../runtime/workflow-engine/readers.ts";
import { AGENT_FINISH_TOOL, agentToolName, type WorkflowAgentGenerator } from "../../runtime/workflow-engine/agent-contract.ts";
import { LanguageGenerationError } from "../../language/contracts.ts";
import { readLanguageAttempts } from "../../language/attempts.ts";
import type { ModelExecutionSelection } from "../../runner/model-execution.ts";

const selection = { profile: "reasoning", model: "synthetic/test", route: "openai-compatible" } as ModelExecutionSelection;
function fixture(change: (data: any) => void = () => {}) {
  const artifact = structuredClone(engineArtifact()), agent = artifact.agents.find(agent => agent.id === "sprint")!;
  const files = { ...readWorkspaceFiles(resolve(import.meta.dirname, "../fixtures/lindenhof-studio")) };
  for (const path of Object.keys(files)) if (path.startsWith("workflows/")) delete files[path];
  const instruction = Object.keys(agent.materials).find(path => path.startsWith("agents/sprint/skills/"))!;
  assert.ok(instruction);
  const declaration = { type: "workflow", id: "agent-task", owner: "agents/sprint", version: 1, execution_mode: "unattended", trigger: "operator",
    steps: [{ work: "agent", context: { source: "Synthetic transcript", identity: "source-1" }, instructions: [instruction], profile: "reasoning", task: "sprint.test",
      tools: [{ tool: "oregano:directory/members", bind: {} }], output_schema: { type: "object", additionalProperties: false, required: ["verified"], properties: { verified: { const: true } } },
      budget: { turns: 8, tool_calls: 16, output_tokens: 8000 } }] };
  // Use the actual directory grant spelling resolved by the fixture.
  declaration.steps[0]!.tools[0]!.tool = agent.toolSet.tools.find(tool => tool.runtimeId.includes("directory"))!.grantId;
  change(declaration);
  files["workflows/agent-task.md"] = `---\n${YAML.stringify(declaration)}---\n## Steps\n1. [sprint, R0] Continue the task. <!-- step:work -->\n`;
  artifact.workflows = compileWorkflows({ files, agents: artifact.agents, provenance: artifact.workflows![0]!.provenance });
  const { artifactHash, ...content } = artifact;
  artifact.artifactHash = sha256({ ...content, provenance: { ...content.provenance, builtAt: undefined } });
  return artifact;
}
const open = (h: ReturnType<typeof engineFixture>) => h.engine().openOperator({ workflowId: "agent-task", requestId: randomUUID(), principal: ENGINE_OPERATOR, fields: {} });
function model(rounds: Array<Array<{ name: string; input: any }>>) {
  let calls = 0; const requests: any[] = [];
  const generate: WorkflowAgentGenerator = async request => {
    requests.push(structuredClone({ context: request.context, turns: request.turns }));
    await request.beforeDispatch(selection, { system_prompt_digest: "a".repeat(64), system_instruction_characters: 12 });
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
  h.now = "2030-01-04T14:36:00.000Z";
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

test("incomplete known responses retain costs and allow a bounded continuation", async () => {
  let calls = 0; const m = model([[{ name: AGENT_FINISH_TOOL, input: { verified: true } }]]);
  const h = engineFixture({ artifact: fixture(), agentGenerator: async request => {
    if (calls++ === 0) { await request.beforeDispatch(selection, { system_prompt_digest: "b".repeat(64), system_instruction_characters: 10 });
      throw new LanguageGenerationError("Length", "incomplete", { model_execution: { ...selection, inputTokens: 100, outputTokens: 8000 } }); }
    return m.generate(request);
  } });
  const run = (await h.engine().advance((await open(h)).runId))!;
  assert.equal(run.state.status, "done", JSON.stringify(run.state.blocked));
  assert.deepEqual((await readLanguageAttempts(h.control, [run.runId])).map(a => a.status).sort(), ["failed", "succeeded"]);
});
