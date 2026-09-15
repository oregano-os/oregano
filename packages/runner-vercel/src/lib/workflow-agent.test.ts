import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflowAgentGenerator } from "./workflow-agent.ts";
import type { WorkflowAgentRequest } from "../../../runtime/workflow-engine/agent-contract.ts";
import type { CompiledAgent } from "../../../companyos-builder/types.ts";
import type { resolveModelExecution } from "./model-execution.ts";
import type { generateText } from "ai";
import { LanguageGenerationError } from "../../../language/contracts.ts";

const request = (): WorkflowAgentRequest => ({ agent: { id: "analyst", instructions: "Use only supported facts", materials: {} } as CompiledAgent,
  instructions: ["Complete the synthetic task"], context: { source: "Full original evidence" }, profile: "deep", task: "analyst.ingest", outputTokens: 12000,
  outputSchema: { type: "object", properties: { verified: { const: true } }, required: ["verified"] },
  tools: [{ name: "read_page", description: "Read a page", inputSchema: { type: "object" } }], turns: [], beforeDispatch: async () => {} });

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
