import test from "node:test";
import assert from "node:assert/strict";
import { ToolLoopAgent, tool, jsonSchema, stepCountIs } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { CONVERSATION_CONTROL_TOOL, CONVERSATION_PARTICIPATION_INSTRUCTIONS, ConversationParticipation, conversationContext } from "../../../runtime/conversation-participation.ts";
import { participationCases, participationMessage } from "../../../testkit/adapter/conversation-participation.ts";
import { withConversationParticipation, participationStep } from "./conversation-model-tools.ts";
import { slackConversationMessage } from "./conversation-participation.ts";

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const call = (toolName: string, input: unknown) => ({ type: "tool-call" as const, toolCallId: toolName, toolName, input: JSON.stringify(input) });
const step = (content: any[], tools = true) => ({ content, finishReason: { unified: tools ? "tool-calls" as const : "stop" as const, raw: undefined }, usage, warnings: [] });

for (const fixture of participationCases) test(`Slack facts conform: ${fixture.title}`, () => {
  const message = slackConversationMessage({ id: "slack:C10001:1.0", isDM: !fixture.shared },
    { id: "2.0", text: "Question", isMention: fixture.mentioned, author: {} as any, metadata: { dateSent: new Date("2026-09-11T10:00:00Z") } as any },
    { id: "person:alice", name: "Alice" });
  assert.equal(new ConversationParticipation(message).ambient, fixture.ambient);
  assert.equal(message.replyToId, "1.0");
  assert.equal(message.senderId, "person:alice");
});

test("the existing Agent can stay quiet in one invocation with no work or emitted progress", async () => {
  let effects = 0;
  const turn = new ConversationParticipation(participationMessage({ text: "Bob, can you review my draft?" }));
  const model = new MockLanguageModelV3({ doGenerate: step([call(CONVERSATION_CONTROL_TOOL, { participation: "context-only" })]) });
  const agent = new ToolLoopAgent({ model, instructions: CONVERSATION_PARTICIPATION_INSTRUCTIONS,
    tools: withConversationParticipation({ build: tool({ inputSchema: jsonSchema<Record<string, never>>({ type: "object" }), execute: async () => ++effects }) }, turn),
    prepareStep: () => participationStep(turn), stopWhen: [() => turn.complete, stepCountIs(3)] });
  const result = await agent.generate({ prompt: conversationContext(turn.message, []) });
  assert.equal(model.doGenerateCalls.length, 1);
  assert.deepEqual(model.doGenerateCalls[0].tools?.map(t => t.type === "function" ? t.name : undefined), [CONVERSATION_CONTROL_TOOL]);
  assert.equal(effects, 0);
  assert.equal(turn.finish(result.text).text, undefined);
});

test("an unmentioned follow-up can use existing Tools after the same Agent chooses to respond", async () => {
  let reads = 0;
  const turn = new ConversationParticipation(participationMessage());
  const model = new MockLanguageModelV3({ doGenerate: [
    step([call(CONVERSATION_CONTROL_TOOL, { participation: "respond" })]),
    step([call("read_status", {})]), step([{ type: "text", text: "The build is ready to test." }], false),
  ] });
  const tools = withConversationParticipation({ read_status: tool({ inputSchema: jsonSchema<Record<string, never>>({ type: "object" }), execute: async () => { reads++; return "ready"; } }) }, turn);
  const agent = new ToolLoopAgent({ model, instructions: CONVERSATION_PARTICIPATION_INSTRUCTIONS, tools,
    prepareStep: () => participationStep(turn), stopWhen: [() => turn.complete, stepCountIs(4)] });
  const result = await agent.generate({ prompt: conversationContext(turn.message, []) });
  assert.equal(reads, 1);
  assert.equal(turn.finish(result.text).text, "The build is ready to test.");
});

test("guarded Tools reject model attempts to work before or after a silent choice", async () => {
  let writes = 0;
  const turn = new ConversationParticipation(participationMessage());
  const tools = withConversationParticipation({ build: tool({ inputSchema: jsonSchema<Record<string, never>>({ type: "object" }), execute: async () => ++writes }) }, turn);
  const execute = () => tools.build.execute!({} as never, { toolCallId: "bad", messages: [], context: {} });
  assert.throws(execute);
  turn.choose("context-only");
  assert.throws(execute);
  assert.equal(writes, 0);
});

test("a no-Tool follow-up answer is delivered once without a second generation", async () => {
  const turn = new ConversationParticipation(participationMessage());
  const model = new MockLanguageModelV3({ doGenerate: step([call(CONVERSATION_CONTROL_TOOL, { participation: "respond", text: "Yes, including similar questions." })]) });
  const agent = new ToolLoopAgent({ model, tools: withConversationParticipation({}, turn),
    prepareStep: () => participationStep(turn), stopWhen: [() => turn.complete, stepCountIs(3)] });
  const result = await agent.generate({ prompt: turn.message.text });
  assert.equal(turn.finish(result.text).text, "Yes, including similar questions.");
  assert.equal(model.doGenerateCalls.length, 1);
});
