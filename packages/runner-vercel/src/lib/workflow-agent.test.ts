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

test("trusted scoped effort reaches the provider and dispatch evidence without increasing the turn cap", async () => {
  for (const configured of [undefined, "medium", "high"] as const) {
    const effort = configured ?? "low";
    const generate = createWorkflowAgentGenerator({ resolve: (() => ({ model: "test", selection: {
      reasoningEffort: configured, maxOutputTokens: 12000,
    } })) as typeof resolveModelExecution, generate: (async (options: any) => {
      assert.equal(options.reasoning, effort); assert.equal(options.maxOutputTokens, 12000); assert.equal(options.maxRetries, 0);
      return { text: "", finishReason: "stop", toolCalls: [], response: { id: "effort", modelId: "test", messages: [] }, usage: {} };
    }) as unknown as typeof generateText });
    const input = request();
    input.beforeDispatch = async (selection, instructions, budget) => {
      assert.equal(selection.reasoningEffort, effort); assert.ok(budget); assert.equal(budget.outputTokens, 12000);
      assert.deepEqual(Object.keys(instructions).sort(), ["system_instruction_characters", "system_prompt_digest"]);
    };
    const result = await generate(input); assert.equal(result.evidence.reasoning, effort);
  }
});

test("text completion exposes no finish Tool or structured-completion instructions", async () => {
  const generate = createWorkflowAgentGenerator({ resolve: (() => ({ model: "test", selection: {} })) as typeof resolveModelExecution,
    generate: (async (options: any) => {
      assert.equal(options.tools.companyos_finish_task, undefined);
      assert.ok(options.tools.read_page); assert.match(options.system, /non-empty text report/);
      assert.ok(!options.system.includes("Finish by calling companyos_finish_task"));
      return { text: "Completed the Skill checks; uncertainty remains explicit.", finishReason: "stop", toolCalls: [],
        response: { id: "text-final", modelId: "test", messages: [{ role: "assistant", content: "Completed the Skill checks; uncertainty remains explicit." }] }, usage: {} };
    }) as unknown as typeof generateText });
  const value = await generate({ ...request(), completion: "text" });
  assert.equal(value.response.calls.length, 0); assert.equal(value.response.finishReason, "stop");
  assert.match(value.response.text, /uncertainty/);
});

test("known cutoff feedback preserves completed receipts and asks for one small remaining operation", async () => {
  const generate = createWorkflowAgentGenerator({ resolve: (() => ({ model: "test", selection: {} })) as typeof resolveModelExecution,
    generate: (async (options: any) => {
      assert.deepEqual(options.messages[2].content[0].output, { type: "json", value: { saved_commit: "synthetic-saved-commit" } });
      const feedback = options.messages[3].content;
      assert.match(feedback, /output-token limit/); assert.match(feedback, /one small Tool operation/);
      assert.match(feedback, /do not repeat/); assert.match(feedback, /one page at a time/);
      return { text: "Done", finishReason: "stop", toolCalls: [], response: { id: "after-cutoff", modelId: "test", messages: [] }, usage: {} };
    }) as unknown as typeof generateText });
  const input = request(); input.turns = [
    { attemptId: "saved", response: { messages: [{ role: "assistant", content: "Saving" }], text: "", finishReason: "tool-calls", calls: [{ id: "saved-call", name: "write_page", input: {} }] }, results: [{ callId: "saved-call", output: { saved_commit: "synthetic-saved-commit" } }] },
    { attemptId: "cutoff", failure: { outcome: "failed", digest: "a".repeat(64), reason: "output-limit" }, results: [] },
  ];
  await generate(input);
});

test("reviewed output and timeout bounds reach the provider while smaller reservations still win", async t => {
  const timeouts: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => { timeouts.push(ms); return new AbortController().signal; });
  for (const remaining of [32000, 16000]) {
    const generate = createWorkflowAgentGenerator({ resolve: (() => ({ model: "test", selection: { maxOutputTokens: 32000, timeoutMs: 360000 } })) as typeof resolveModelExecution,
      generate: (async (options: any) => {
        assert.equal(options.maxOutputTokens, remaining); assert.equal(options.maxRetries, 0);
        return { text: "Done", finishReason: "stop", toolCalls: [], response: { id: "bounded", modelId: "test", messages: [] }, usage: {} };
      }) as unknown as typeof generateText });
    const input = { ...request(), outputTokens: remaining };
    input.beforeDispatch = async (selection, _evidence, reservation) => {
      assert.equal(selection.timeoutMs, 360000); assert.equal(reservation!.outputTokens, remaining);
    };
    await generate(input);
  }
  assert.deepEqual(timeouts, [360000, 360000]);
});
