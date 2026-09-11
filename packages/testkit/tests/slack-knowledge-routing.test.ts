import assert from "node:assert/strict";
import { test } from "node:test";
import {
  knowledgeStepChoice,
  knowledgeTurnInstructions,
  knowledgeTurnModelTask,
  renderKnowledgeTurnResponse,
  resolveKnowledgeTurnRoute,
} from "../../runner-vercel/src/lib/knowledge-turn-routing.ts";
import { decodeModelRuntimeConfiguration, resolveModelExecutionSelection } from "../../runner/model-execution.ts";

const searchTool = {
  grantId: "oregano:knowledge/search",
  toolName: "oregano_knowledge_search",
};

test("keyword phrases do not force search; the Agent can select a knowledge turn", () => {
  for (const text of ["Search Company Knowledge for Project Cedar", "Welche Entscheidungen wurden besprochen?", "ordinary message"] ) {
    const automatic = resolveKnowledgeTurnRoute({ text, tools: [searchTool] });
    assert.deepEqual(automatic, { kind: "auto", searchToolName: searchTool.toolName });
    assert.deepEqual(knowledgeStepChoice(automatic, 0), { toolChoice: "auto" });
    const selected = resolveKnowledgeTurnRoute({ text, tools: [searchTool], requiresKnowledge: true });
    assert.deepEqual(selected, { kind: "required-search", grantId: searchTool.grantId, toolName: searchTool.toolName, reason: "agent-selected" });
    assert.deepEqual(knowledgeStepChoice(selected, 0), { toolChoice: { type: "tool", toolName: searchTool.toolName }, activeTools: [searchTool.toolName] });
    assert.deepEqual(knowledgeStepChoice(selected, 1), { toolChoice: "auto" });
  }
});

test("required Knowledge turns use deep cited synthesis and receive the answer contract", () => {
  const route = resolveKnowledgeTurnRoute({
    text: "Fasse die CompanyOS-Entscheidungen aus den letzten Meetings zusammen.",
    tools: [searchTool], requiresKnowledge: true,
  });
  assert.deepEqual(knowledgeTurnModelTask(route), {
    profile: "deep",
    task: "knowledge.cited-synthesis",
    configuration: "knowledge",
  });
  const instructions = knowledgeTurnInstructions(route);
  assert.match(instructions, /Lead with the synthesized answer/u);
  assert.match(instructions, /do not answer from search snippets alone/u);
  assert.match(instructions, /traverse relevant Claim or Synthesis hits/u);
  assert.match(instructions, /3-5 most relevant full items/u);
  assert.match(instructions, /exact returned source path and fragment_id/u);
  assert.match(instructions, /Conflicts|conflicts/u);
  assert.match(instructions, /not policy/u);
  assert.match(instructions, /never make the source list the answer itself/u);

  const ordinary = { kind: "auto" } as const;
  assert.deepEqual(knowledgeTurnModelTask(ordinary), {
    profile: "agent",
    task: "agent.chat",
    configuration: "shared",
  });
  assert.equal(knowledgeTurnInstructions(ordinary), "");
});

test("the Knowledge-only task binding can select Opus without changing ordinary Agent chat", () => {
  const encoded = Buffer.from(JSON.stringify({
    version: 1,
    tasks: {
      "knowledge.cited-synthesis": {
        route: "anthropic-direct",
        model: "anthropic/claude-opus-4-7",
        maxOutputTokens: 8_000,
        timeoutMs: 240_000,
        retries: 0,
      },
    },
  }), "utf8").toString("base64");
  const configuration = decodeModelRuntimeConfiguration(encoded);
  const selected = resolveModelExecutionSelection({
    profile: "deep",
    task: "knowledge.cited-synthesis",
    configuration,
    requiredCapability: "tools",
    environment: { ANTHROPIC_API_KEY: "fixture-key" },
  });
  assert.deepEqual([selected.route, selected.model, selected.maxOutputTokens], [
    "anthropic-direct",
    "anthropic/claude-opus-4-7",
    8_000,
  ]);

  const ordinary = resolveModelExecutionSelection({
    profile: "agent",
    task: "agent.chat",
    environment: { OPENAI_API_KEY: "fixture-key" },
  });
  assert.deepEqual([ordinary.route, ordinary.model], ["openai-direct", "openai/gpt-5.4-nano"]);
});

test("ordinary conversation and an Agent without the search grant retain automatic Tool choice", () => {
  assert.deepEqual(resolveKnowledgeTurnRoute({ text: "Hallo Oregano, wie geht es dir?", tools: [searchTool] }), { kind: "auto", searchToolName: searchTool.toolName });
  assert.deepEqual(resolveKnowledgeTurnRoute({
    text: "Durchsuche das Company Knowledge nach Company Brain.",
    tools: [{ grantId: "oregano:knowledge/get", toolName: "oregano_knowledge_get" }],
  }), { kind: "auto" });
});

test("a required search must have a successful Tool result before rendering", () => {
  const route = resolveKnowledgeTurnRoute({
    text: "Search Company Knowledge for Company Brain.",
    tools: [searchTool], requiresKnowledge: true,
  });
  assert.match(renderKnowledgeTurnResponse({ route, modelText: "I cannot search.", toolResults: [] }), /Diagnosecode: missing-tool-result/u);
  assert.match(renderKnowledgeTurnResponse({
    route,
    modelText: "",
    toolResults: [],
    toolFailures: [{ toolName: "oregano_knowledge_search", error: new DOMException("The operation timed out", "TimeoutError") }],
  }), /Diagnosecode: execution-timeout/u);
  assert.match(renderKnowledgeTurnResponse({
    route,
    modelText: "",
    toolResults: [],
    toolFailures: [{ toolName: "oregano_knowledge_search", error: new Error("Company Tool exceeded 5000 ms.") }],
  }), /Diagnosecode: execution-timeout/u);
  assert.match(renderKnowledgeTurnResponse({
    route,
    modelText: "",
    toolResults: [],
    toolFailures: [{ toolName: "oregano_knowledge_search", error: { name: "PostgresError", code: "42703", message: "database query failed" } }],
  }), /Diagnosecode: database-42703/u);
  assert.match(renderKnowledgeTurnResponse({
    route,
    modelText: "I used a different Tool.",
    toolResults: [{ toolName: "oregano_knowledge_get", output: { output: { found: false } } }],
  }), /nicht erfolgreich ausgeführt/u);
  assert.equal(renderKnowledgeTurnResponse({ route: { kind: "auto" }, modelText: "Hallo!", toolResults: [] }), "Hallo!");
});

test("a grounded model answer with a returned citation is retained", () => {
  const route = resolveKnowledgeTurnRoute({
    text: "Search Company Knowledge for Company Brain.",
    tools: [searchTool], requiresKnowledge: true,
  });
  const response = renderKnowledgeTurnResponse({
    route,
    modelText: "The policy is documented in handbook/brain.md, fragment brain-1.",
    toolResults: [{
      toolName: "oregano_knowledge_search",
      output: { output: {
        query: "Company Brain",
        hits: [{ excerpt: "The Company Brain compounds working knowledge.", citation: { path: "handbook/brain.md", fragment_id: "brain-1" } }],
        gaps: [],
        degradations: [],
      } },
    }],
  });
  assert.equal(response, "The policy is documented in handbook/brain.md, fragment brain-1.");
});

test("a false Tool-unavailable answer is replaced with authorized cited excerpts", () => {
  const route = resolveKnowledgeTurnRoute({
    text: "Durchsuche das Company Knowledge nach Company Brain.",
    tools: [searchTool], requiresKnowledge: true,
  });
  const response = renderKnowledgeTurnResponse({
    route,
    modelText: "Ich kann die Wissenssuche nicht ausführen, weil keine Such-Funktionalität verfügbar ist.",
    toolResults: [{
      toolName: "oregano_knowledge_search",
      output: { output: {
        query: "Company Brain",
        hits: [{
          excerpt: "Working knowledge is reviewed before promotion.",
          citation: { path: "knowledge/review.md", fragment_id: "review-7", heading: "Review" },
        }],
        gaps: [],
        degradations: [],
      } },
    }],
  });
  assert.match(response, /Working knowledge is reviewed before promotion\./u);
  assert.match(response, /knowledge\/review\.md · Review · Fragment-ID: review-7/u);
  assert.doesNotMatch(response, /keine Such-Funktionalität/u);
});

test("a completed search without hits returns an explicit grounded no-result response", () => {
  const route = resolveKnowledgeTurnRoute({
    text: "Search Company Knowledge for absent topic.",
    tools: [searchTool], requiresKnowledge: true,
  });
  const response = renderKnowledgeTurnResponse({
    route,
    modelText: "I found the answer elsewhere.",
    toolResults: [{
      toolName: "oregano_knowledge_search",
      output: { output: { query: "absent topic", hits: [], gaps: ["no lexical match"], degradations: [] } },
    }],
  });
  assert.match(response, /keine autorisierten Treffer/u);
  assert.match(response, /no lexical match/u);
});

test("autonomous search still validates returned evidence", () => {
  const route = resolveKnowledgeTurnRoute({ text: "No keyword", tools: [searchTool] });
  assert.match(renderKnowledgeTurnResponse({ route, modelText: "Unsupported claim", toolResults: [
    { toolName: searchTool.toolName, output: { query: "policy", hits: [] } },
  ] }), /keine autorisierten Treffer/);
});
