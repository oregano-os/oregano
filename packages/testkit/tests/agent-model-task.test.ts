import assert from "node:assert/strict";
import test from "node:test";
import { agentModelTask } from "../../runner-vercel/src/lib/agent-model-task.ts";
import { agentInstructions } from "../../runner-vercel/src/lib/agent-instructions.ts";
import { resolveModelExecutionSelection } from "../../runner/model-execution.ts";

test("a workflow-assigned Agent uses its declared task without a legacy runtime", () => {
  const agent = { modelTask: "planning.conversation" };
  const task = agentModelTask(agent);
  const normal = agentModelTask(agent, { kind: "auto" });
  assert.deepEqual(normal, task);
  const selected = resolveModelExecutionSelection({
    profile: task.profile, task: task.task, environment: {},
    configuration: { version: 1,
      default: { route: "vercel-ai-gateway", model: "openai/gpt-5.4-nano" },
      tasks: { "planning.conversation": { route: "anthropic-direct", model: "anthropic/claude-sonnet-5" } } },
  });
  assert.equal(selected.model, "anthropic/claude-sonnet-5");
  assert.equal(selected.route, "anthropic-direct");
  assert.equal(selected.task, "planning.conversation");
  assert.equal(selected.profile, "agent");
});

test("absent declarations retain general chat and knowledge model routing", () => {
  assert.deepEqual(agentModelTask({}), { profile: "agent", task: "agent.chat", configuration: "shared" });
  const knowledge = { kind: "required-search" as const, grantId: "oregano:knowledge/search" as const,
    toolName: "knowledge_search", reason: "explicit-search" as const };
  assert.deepEqual(agentModelTask({}, knowledge), { profile: "deep", task: "knowledge.cited-synthesis", configuration: "knowledge" });
  assert.equal(agentModelTask({ modelTask: "review.conversation" }, knowledge).task, "review.conversation");
});

test("qualification and runtime prompt assembly retain Skills and collection safeguards", () => {
  const prompt = agentInstructions({ instructions: "Ask about unsupported facts.",
    materials: { "agents/reviewer/skills/review/SKILL.md": "Never invent a deadline." } },
  { kind: "auto" }, ["companyos_collect_facts"], { title: "Synthetic task" });
  assert.match(prompt, /Ask about unsupported facts/);
  assert.match(prompt, /Never invent a deadline/);
  assert.match(prompt, /Synthetic task/);
  assert.match(prompt, /collection is never authorization/);
  assert.match(prompt, /follow the Agent's wording and language/);
  assert.doesNotMatch(prompt, /A separate human decision will be delivered/);
  assert.match(prompt, /never infer approval from conversational text/);
});
