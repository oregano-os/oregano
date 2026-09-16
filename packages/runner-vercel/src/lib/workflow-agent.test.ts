import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflowAgentGenerator } from "./workflow-agent.ts";
import type { WorkflowAgentRequest } from "../../../runtime/workflow-engine/agent-contract.ts";
import type { CompiledAgent } from "../../../companyos-builder/types.ts";
import type { resolveModelExecution } from "./model-execution.ts";
import type { generateText } from "ai";
import { LanguageGenerationError } from "../../../language/contracts.ts";
import { modelToolResult } from "./workflow-agent-context.ts";

const request = (): WorkflowAgentRequest => ({ agent: { id: "analyst", instructions: "Use only supported facts", materials: {} } as CompiledAgent,
  instructions: ["Complete the synthetic task"], context: { source: "Full original evidence" }, profile: "deep", task: "analyst.ingest", outputTokens: 12000,
  outputSchema: { type: "object", properties: { verified: { const: true } }, required: ["verified"] },
  tools: [{ name: "read_page", description: "Read a page", inputSchema: { type: "object" } }], turns: [], beforeDispatch: async () => {} });

test("Brain model context contains Markdown once while preserving the full verification receipt", () => {
  const text = "Supported knowledge. ".repeat(1000), markdown = `---\ntype: concept\ntitle: Example\n---\n\n${text}`;
  const receipt = { found: true, status: "found", page: { slug: "concepts/example", markdown, compiled_truth: text, search_text: text,
    timeline: "", takes: [], links: [{ target: "people/example", context: text }], content_hash: "a".repeat(64) },
    outgoing: [{ target: "people/example", resolved: "people/example", context: text }],
    backlinks: [{ from: "meetings/other", context: "Independent evidence from another page" }], indexed_revision: { git_commit: "b".repeat(40) } };
  const original = structuredClone(receipt), projected = modelToolResult("oregano_brain_entity", receipt) as any;
  assert.deepEqual(receipt, original); assert.equal(projected.page.markdown, markdown);
  assert.equal(projected.page.content_hash, receipt.page.content_hash);
  assert.deepEqual(projected.outgoing, [{ target: "people/example", resolved: "people/example" }]);
  assert.deepEqual(projected.page.links, [{ target: "people/example" }]);assert.deepEqual(projected.backlinks,receipt.backlinks);
  assert.deepEqual(projected.indexed_revision, receipt.indexed_revision);
  assert.ok(JSON.stringify(projected).length < JSON.stringify(receipt).length / 2);
  assert.equal(modelToolResult("another_tool", receipt), receipt);
});

test("one hosted model turn exposes declarations without executing Tools and retains usage and messages", async () => {
  let dispatched = false;
  const generate = createWorkflowAgentGenerator({ resolve: ((input: unknown) => {
    assert.deepEqual(input, { profile: "deep", task: "analyst.ingest", requiredCapability: "tools" });
    return { model: "test", selection: { model: "synthetic/model", maxOutputTokens: 12000 } };
  }) as typeof resolveModelExecution, generate: (async (input: any) => {
    assert.ok(dispatched); assert.equal(input.tools.read_page.execute, undefined); assert.equal(input.tools.companyos_finish_task.execute, undefined);
    assert.equal(input.maxRetries, 0); assert.equal(input.maxOutputTokens, 12000); assert.match(input.messages[0].content, /Full original evidence/);
    return { text: "", finishReason: "tool-calls", toolCalls: [{ toolCallId: "c1", toolName: "read_page", input: { slug: "people/example" } }],
      response: { id: "response-1", modelId: "synthetic/model", messages: [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "read_page", input: { slug: "people/example" } }] }] },
      usage: { inputTokens: 100, outputTokens: 30 } };
  }) as unknown as typeof generateText });
  const input = request(); input.beforeDispatch = async (_selection, evidence) => { assert.equal(evidence.system_prompt_digest.length, 64); dispatched = true; };
  const result = await generate(input); assert.equal(result.response.calls[0]!.id, "c1"); assert.equal(result.response.messages.length, 1);
  assert.equal((result.evidence.model_execution as any).inputTokens, 100);
});

test("continuation replays the saved assistant call and exact Tool result, including validation feedback", async () => {
  const generate = createWorkflowAgentGenerator({ resolve: (() => ({ model: "test", selection: {} })) as typeof resolveModelExecution,
    generate: (async (input: any) => {
      assert.equal(input.messages[1].role, "assistant"); assert.deepEqual(input.messages[2].content[0].output, { type: "error-text", value: "Read the saved page first" });
      return { text: "", finishReason: "stop", toolCalls: [], response: { id: "r2", modelId: "test", messages: [] }, usage: {} };
    }) as unknown as typeof generateText });
  const input = request(); input.turns = [{ attemptId: "unused-synthetic", response: { messages: [{ role: "assistant", content: "Verifying" }],
    text: "Verifying", finishReason: "tool-calls", calls: [{ id: "c1", name: "read_page", input: {} }] }, results: [{ callId: "c1", error: "Read the saved page first" }] }];
  await generate(input);
});

test("output exhaustion exposes actual usage but never dispatches partial Tool calls", async () => {
  const generate = createWorkflowAgentGenerator({ resolve: (() => ({ model: "test", selection: {} })) as typeof resolveModelExecution,
    generate: (async () => ({ text: "private partial", finishReason: "length", response: { id: "r1", modelId: "test" }, usage: { inputTokens: 100, outputTokens: 12000 } })) as unknown as typeof generateText });
  await assert.rejects(generate(request()), error => error instanceof LanguageGenerationError && error.kind === "incomplete"
    && (error.evidence.model_execution as any).outputTokens === 12000 && !JSON.stringify(error.evidence).includes("private partial"));
});
