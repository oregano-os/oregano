import assert from "node:assert/strict";
import { test } from "node:test";
import {
  knowledgeStepChoice,
  requiredKnowledgeToolExecuted,
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

test("a required search must be present in the completed Tool calls before rendering", () => {
  const route = resolveKnowledgeTurnRoute({
    text: "Search Company Knowledge for Company Brain.",
    tools: [searchTool],
  });
  assert.equal(requiredKnowledgeToolExecuted(route, []), false);
  assert.equal(requiredKnowledgeToolExecuted(route, [{ toolName: "oregano_knowledge_get" }]), false);
  assert.equal(requiredKnowledgeToolExecuted(route, [{ toolName: "oregano_knowledge_search" }]), true);
  assert.equal(requiredKnowledgeToolExecuted({ kind: "auto" }, []), true);
});
