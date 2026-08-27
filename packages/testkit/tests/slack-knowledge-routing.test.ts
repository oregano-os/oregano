import assert from "node:assert/strict";
import { test } from "node:test";
import {
  knowledgeStepChoice,
  renderKnowledgeTurnResponse,
  resolveKnowledgeTurnRoute,
} from "../../runner-vercel/src/lib/knowledge-turn-routing.ts";

const searchTool = {
  grantId: "oregano:knowledge/search",
  toolName: "oregano_knowledge_search",
};

test("the failed German Slack request requires Knowledge search on the first model step", () => {
  const route = resolveKnowledgeTurnRoute({
    text: "@Oregano Durchsuche das Company Knowledge nach „Company Brain“. Nutze dafür die Wissenssuche.",
    tools: [searchTool],
  });
  assert.deepEqual(route, {
    kind: "required-search",
    grantId: "oregano:knowledge/search",
    toolName: "oregano_knowledge_search",
    reason: "explicit-search",
  });
  assert.deepEqual(knowledgeStepChoice(route, 0), {
    toolChoice: { type: "tool", toolName: "oregano_knowledge_search" },
    activeTools: ["oregano_knowledge_search"],
  });
  assert.deepEqual(knowledgeStepChoice(route, 1), { toolChoice: "auto" });
});

test("explicit English lookup and company evidence questions require the granted search Tool", () => {
  const explicit = resolveKnowledgeTurnRoute({
    text: "Search Company Knowledge for Project Cedar and cite the results.",
    tools: [searchTool],
  });
  assert.equal(explicit.kind, "required-search");

  const evidenceQuestion = resolveKnowledgeTurnRoute({
    text: "Welche Entscheidungen wurden in unseren Granola-Gesprächen festgehalten?",
    tools: [searchTool],
  });
  assert.equal(evidenceQuestion.kind, "required-search");
  if (evidenceQuestion.kind === "required-search") assert.equal(evidenceQuestion.reason, "company-evidence-question");
});

test("ordinary conversation and an Agent without the search grant retain automatic Tool choice", () => {
  assert.deepEqual(resolveKnowledgeTurnRoute({ text: "Hallo Oregano, wie geht es dir?", tools: [searchTool] }), { kind: "auto" });
  assert.deepEqual(resolveKnowledgeTurnRoute({
    text: "Durchsuche das Company Knowledge nach Company Brain.",
    tools: [{ grantId: "oregano:knowledge/get", toolName: "oregano_knowledge_get" }],
  }), { kind: "auto" });
});

test("a required search must have a successful Tool result before rendering", () => {
  const route = resolveKnowledgeTurnRoute({
    text: "Search Company Knowledge for Company Brain.",
    tools: [searchTool],
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
    tools: [searchTool],
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
    tools: [searchTool],
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
    tools: [searchTool],
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
