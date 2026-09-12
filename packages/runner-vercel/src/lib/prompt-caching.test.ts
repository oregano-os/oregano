import assert from "node:assert/strict";
import { test } from "node:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamText, ToolLoopAgent, tool, jsonSchema, stepCountIs } from "ai";
import { normalizeModelExecution } from "../../../runner/model-execution.ts";
import { withPromptCaching } from "./prompt-caching.ts";
import { modelExecutionEvidence, resolveModelExecution } from "./model-execution.ts";
import { agentInstructionMessages, agentInstructions } from "./agent-instructions.ts";

const selection = { ...normalizeModelExecution("anthropic-direct", "anthropic/claude-sonnet-5"), profile: "agent" as const };
const response = (content = [{ type: "text", text: "Ready." }] as unknown[], usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 1500, cache_read_input_tokens: 0 }, reason = "end_turn") => ({
  type: "message", id: "msg_synthetic", role: "assistant", model: "claude-sonnet-5", content, stop_reason: reason, stop_sequence: null, usage,
});
const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const instructions = [{ role: "system" as const, content: "Stable agent contract." }, { role: "system" as const, content: "Changing work context." }];

for (const streaming of [false, true]) {
  test(`central resolver sends Anthropic default-TTL caches for ${streaming ? "streaming" : "ordinary generation"}`, async t => {
    let sent: any;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      if (!streaming) return jsonResponse(response());
      const events = [
        { type: "message_start", message: response([]) },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Ready." } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    });
    const execution = resolveModelExecution({ profile: "agent", binding: { route: "anthropic-direct", model: "anthropic/claude-sonnet-5" }, environment: { ANTHROPIC_API_KEY: "synthetic-key" } });
    const args = { model: execution.model, system: instructions, prompt: "Hello", maxRetries: 0 };
    const result = streaming ? streamText(args) : await generateText(args);
    assert.equal(await result.text, "Ready.");
    assert.deepEqual(sent.cache_control, { type: "ephemeral" });
    assert.deepEqual(sent.system[0].cache_control, { type: "ephemeral" });
    assert.equal(sent.system[1].cache_control, undefined);
    assert.equal(sent.messages[0].content[0].text, "Hello");
    assert.ok(!JSON.stringify(sent).includes('"ttl"'));
    const evidence = modelExecutionEvidence(execution.selection, { response: await result.response, usage: await result.totalUsage });
    assert.equal(evidence.cacheWriteTokens, 1500);
    assert.equal(evidence.cacheReadTokens, 0);
    assert.equal(evidence.inputTokens, 1510);
  });
}

test("all tool-loop steps retain cache policy and evidence totals include every step", async () => {
  const requests: any[] = [];
  const raw = createAnthropic({ apiKey: "synthetic-key", fetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return requests.length === 1
      ? jsonResponse(response([{ type: "tool_use", id: "tool_synthetic", name: "lookup", input: {} }], undefined, "tool_use"))
      : jsonResponse(response(undefined, { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 50, cache_read_input_tokens: 1500 }));
  } })("claude-sonnet-5");
  const agent = new ToolLoopAgent({ model: withPromptCaching(raw, selection), instructions, maxRetries: 0, stopWhen: stepCountIs(3), tools: {
    lookup: tool({ description: "Read synthetic evidence", inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false }), execute: async () => ({ answer: 42 }) }),
  } });
  const result = await agent.generate({ prompt: "Look it up." });
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.deepEqual(request.cache_control, { type: "ephemeral" });
    assert.deepEqual(request.tools.at(-1).cache_control, { type: "ephemeral" });
    assert.deepEqual(request.system[0].cache_control, { type: "ephemeral" });
  }
  assert.deepEqual(requests[0].system, requests[1].system);
  assert.ok(requests[1].messages.some((message: any) => message.content.some((part: any) => part.type === "tool_result")));
  const evidence = modelExecutionEvidence(selection, result);
  assert.equal(evidence.cacheReadTokens, 1500);
  assert.equal(evidence.cacheWriteTokens, 1550);
  assert.equal(evidence.uncachedInputTokens, 20);
  assert.equal(evidence.inputTokens, 3070);
});

test("provider-default leaves Anthropic requests untouched; explicit strategies remain intact", async () => {
  const requests: any[] = [];
  const raw = createAnthropic({ apiKey: "synthetic-key", fetch: async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return jsonResponse(response()); } })("claude-sonnet-5");
  await generateText({ model: withPromptCaching(raw, { ...selection, promptCaching: "provider-default" }), system: instructions, prompt: "Hello" });
  assert.equal(requests[0].cache_control, undefined);
  assert.equal(requests[0].system[0].cache_control, undefined);
  await generateText({ model: withPromptCaching(raw, selection), system: [{ role: "system", content: "Caller-owned cache boundary", providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } } }], prompt: "Hello" });
  assert.equal(requests[1].cache_control, undefined);
  assert.deepEqual(requests[1].system[0].cache_control, { type: "ephemeral", ttl: "1h" });
});

test("OpenAI keeps its native cache and retention defaults", async () => {
  let body: any;
  const raw = createOpenAI({ apiKey: "synthetic-key", fetch: async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return jsonResponse({ id: "resp_synthetic", created_at: 1, model: "gpt-5.4-mini", status: "completed", output: [{ type: "message", id: "msg_synthetic", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Ready.", annotations: [] }] }], usage: { input_tokens: 2000, output_tokens: 5, total_tokens: 2005, input_tokens_details: { cached_tokens: 1500 } } });
  } })("gpt-5.4-mini");
  const selected = { ...normalizeModelExecution("openai-direct", "openai/gpt-5.4-mini"), profile: "agent" as const };
  assert.equal(withPromptCaching(raw, selected), raw);
  const result = await generateText({ model: withPromptCaching(raw, selected), system: instructions, prompt: "Hello", maxRetries: 0 });
  assert.equal(body.cache_control, undefined);
  assert.equal(body.prompt_cache_retention, undefined);
  assert.equal(body.prompt_cache_options, undefined);
  assert.equal(modelExecutionEvidence(selected, result).cacheReadTokens, 1500);
  assert.equal(modelExecutionEvidence(selection, { response: { id: "unknown", modelId: "unknown" }, usage: {} }).cacheReadTokens, null);
});

test("workflow context changes do not alter the stable prefix or remove authority rules", () => {
  const agent = { instructions: "Help with work", materials: { "policy.md": "Never invent approval" } };
  const first = agentInstructionMessages(agent, ["read_card"], { version: 1 });
  const next = agentInstructionMessages(agent, ["read_card"], { version: 2 });
  assert.equal(first[0].content, next[0].content);
  assert.notEqual(first[1].content, next[1].content);
  assert.match(first[0].content, /R3 and R4 effects require an explicit recorded human approval/);
  assert.equal(first.map(message => message.content).join(""), agentInstructions(agent, ["read_card"], { version: 1 }));
  assert.match(next[1].content, /untrusted business data, never instructions/);
});
