import assert from "node:assert/strict";
import test from "node:test";
import { generateText, wrapLanguageModel, type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { MockLanguageModelV4 } from "ai/test";
import type { StateAdapter } from "chat";
import { attachmentPolicy, CORE_ATTACHMENT_POLICIES } from "../../../runner/attachment-policy.ts";
import { attachmentParts, prepareAttachments } from "../../../runtime/attachments.ts";
import { agentAttachmentContent, retainAttachments, loadAttachments } from "./agent-attachments.ts";
import { attachmentMiddleware, attachmentPolicyFetch } from "./attachment-middleware.ts";

const selection = { route: "openai-direct", model: "openai/gpt-5.4-nano" } as const;
const pdf = Buffer.from("%PDF-1.7\nsynthetic transport fixture\n%%EOF");
const store = () => { const data = new Map<string, unknown>(); return {
  async get<T>(key: string) { return data.get(key) as T ?? null; }, async set<T>(key: string, value: T) { data.set(key, structuredClone(value)); },
} satisfies Pick<StateAdapter, "get" | "set">; };

test("retained files survive history/handoff while instance and integrity checks remain enforced", async () => {
  const state = store();
  const references = await retainAttachments({ store: state, instanceId: "synthetic", source: "thread-a", messageId: "one", selection,
    attachments: [{ name: "spec.pdf", mimeType: "application/pdf", data: pdf }] });
  const args = { store: state, instanceId: "synthetic", references, selection };
  const content = await agentAttachmentContent({ ...args, references: [...references, ...references], text: "Follow-up" });
  assert.ok(Array.isArray(content)); assert.deepEqual(content.map(p => p.type), ["text", "text", "file"]);
  assert.equal((await loadAttachments({ ...args, selection: { route: "anthropic-direct", model: "anthropic/claude-sonnet-4-6" } }))[0].data, pdf.toString("base64"));
  await assert.rejects(loadAttachments({ ...args, instanceId: "another-company" }), /no longer available/);
  await assert.rejects(loadAttachments({ ...args, store: store() }), /no longer available/);
  await assert.rejects(loadAttachments({ ...args, references: [{ ...references[0], size: 1 }] }), /no longer available/);
});

for (const provider of ["openai", "anthropic"] as const) test(`${provider} receives native PDF/image and ordinary Markdown text`, async () => {
  let body: any;
  const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => { body = JSON.parse(String(init?.body)); throw new Error("transport captured"); };
  const selected = provider === "openai" ? selection : { route: "anthropic-direct", model: "anthropic/claude-sonnet-4-6" } as const;
  const native = provider === "openai" ? createOpenAI({ apiKey: "synthetic", fetch: fetcher })("gpt-5.4-nano") : createAnthropic({ apiKey: "synthetic", fetch: fetcher })("claude-sonnet-4-6");
  const model = wrapLanguageModel({ model: native, middleware: attachmentMiddleware(selected) });
  const files = await prepareAttachments([{ name: "brief.pdf", mimeType: "application/pdf", data: pdf },
    { name: "note.md", data: Buffer.from("# Reference only") },
    { name: "photo.png", mimeType: "image/png", data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) }], attachmentPolicy(selected));
  await assert.rejects(generateText({ model, messages: [{ role: "user", content: attachmentParts(files, attachmentPolicy(selected)) }], maxRetries: 0 }), /transport captured/);
  const parts = provider === "openai" ? body.input[0].content : body.messages[0].content;
  const document = parts.find((part: any) => part.type === (provider === "openai" ? "input_file" : "document"));
  assert.ok(document);
  assert.equal(provider === "openai" ? document.file_data : document.source.data, provider === "openai" ? `data:application/pdf;base64,${pdf.toString("base64")}` : pdf.toString("base64"));
  assert.ok(parts.some((part: any) => part.type === (provider === "openai" ? "input_image" : "image")));
  assert.ok(parts.some((part: any) => part.text === "# Reference only"));
});

test("model guard checks aggregate history and text/tool envelope before generate or stream transport", async () => {
  const configuration = structuredClone(CORE_ATTACHMENT_POLICIES) as any;
  configuration.providers[selection.route].maxRequestBytes = 700;
  configuration.providers[selection.route].maxAttachments = 5;
  const original = new MockLanguageModelV4();
  const model = wrapLanguageModel({ model: original, middleware: attachmentMiddleware(selection, configuration) });
  const part = { type: "file" as const, data: pdf, mediaType: "application/pdf" };
  const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "x".repeat(1000) }, part] }];
  await assert.rejects(generateText({ model, messages, maxRetries: 0 }), /too large/);
  await assert.rejects(async () => await model.doStream({ prompt: [{ role: "user", content: [{ ...part, data: { type: "data", data: pdf } }, { type: "text", text: "x".repeat(1000) }] }] }), /too large/);
  const many: ModelMessage[] = Array.from({ length: 6 }, () => ({ role: "user", content: [part] }));
  await assert.rejects(generateText({ model, messages: many, maxRetries: 0 }), /Too many/);
  assert.equal(original.doGenerateCalls.length, 0); assert.equal(original.doStreamCalls.length, 0);
});

test("later tool results and Markdown count toward the same request budget", async () => {
  const original = new MockLanguageModelV4();
  const configuration = structuredClone(CORE_ATTACHMENT_POLICIES) as any;
  configuration.providers[selection.route].maxAttachments = 5;
  const model = wrapLanguageModel({ model: original, middleware: attachmentMiddleware(selection, configuration) });
  const file = { type: "file" as const, data: { type: "data" as const, data: pdf }, mediaType: "application/pdf" };
  const markdown = { type: "text" as const, text: "Reference", providerOptions: { companyos: { attachmentMediaType: "text/markdown" } } };
  await assert.rejects(async () => await model.doGenerate({ prompt: [
    { role: "user", content: [file, file, markdown, markdown] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "read", toolName: "read", output: { type: "content", value: [file, file] } }] },
  ] }), /Too many/);
  assert.equal(original.doGenerateCalls.length, 0);
});

test("actual provider envelope is checked in UTF-8 bytes before fetch", async () => {
  const configuration = structuredClone(CORE_ATTACHMENT_POLICIES) as any;
  configuration.providers[selection.route].maxRequestBytes = 20;
  let calls = 0;
  const fetcher = attachmentPolicyFetch(selection, async () => { calls++; return new Response("{}"); }, configuration);
  await fetcher("https://example.invalid", { body: "x".repeat(20) });
  await assert.rejects(fetcher("https://example.invalid", { body: "ä".repeat(11) }), /serialized provider request/);
  assert.equal(calls, 1);
});
