import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256 } from "../../../runtime/canonical.ts";
import { KNOWLEDGE_MODEL_EXECUTION_CONTRACT_VERSION, type KnowledgeModelProfileBinding } from "../../../knowledge/knowledge-model-execution.ts";
import {
  decodeKnowledgeModelRuntimeConfiguration,
  knowledgeModelAdapterDigest,
  KNOWLEDGE_EXTRACTION_JSON_SCHEMA,
  KNOWLEDGE_SMOKE_TEST_JSON_SCHEMA,
} from "./knowledge-model-runtime.ts";

const qualifiedAt = "2026-08-26T18:00:00.000Z";
const route = "vercel-ai-gateway";
const model = "openai/gpt-5.4-nano";
const adapterDigest = knowledgeModelAdapterDigest(route, model);
const profile = (name: "utility" | "reasoning"): KnowledgeModelProfileBinding => ({
  contractVersion: KNOWLEDGE_MODEL_EXECUTION_CONTRACT_VERSION,
  profile: name,
  profileVersion: "1.0.0",
  route,
  model,
  secretRefs: [],
  allowedDataClasses: ["business", "confidential", "restricted", "personal"],
  maxInputTokens: 200_000,
  maxOutputTokens: 16_000,
  maxCostUsd: 5,
  state: "active",
  qualification: { qualifiedAt, receiptId: sha256(`${name}:qualification`), adapterDigest },
});

test("Knowledge model runtime accepts independent utility and reasoning recipe bindings", () => {
  const configuration = { version: 1 as const, utility: profile("utility"), reasoning: profile("reasoning") };
  const encoded = Buffer.from(JSON.stringify(configuration)).toString("base64");
  assert.deepEqual(decodeKnowledgeModelRuntimeConfiguration(encoded), configuration);
  assert.throws(() => decodeKnowledgeModelRuntimeConfiguration(Buffer.from(JSON.stringify({ ...configuration, token: "forbidden" })).toString("base64")), /unsupported shape/);
  const split = { ...configuration, reasoning: { ...configuration.reasoning, route: "anthropic-direct", model: "anthropic/claude-sonnet-4-6" } };
  assert.deepEqual(decodeKnowledgeModelRuntimeConfiguration(Buffer.from(JSON.stringify(split)).toString("base64")), split);
  assert.equal(adapterDigest, sha256({ adapter: "oregano/model-recipe-knowledge", version: "1.0.0", route, model }));
});

test("Knowledge model runtime derives simple profiles from the shared CompanyOS model configuration", () => {
  const shared = Buffer.from(JSON.stringify({
    version: 1,
    profiles: {
      utility: { route: "anthropic-direct", model: "anthropic/claude-haiku-4-5", maxOutputTokens: 2_000 },
      reasoning: { route: "openai-direct", model: "openai/gpt-5.4-mini", maxOutputTokens: 8_000 },
    },
  })).toString("base64");
  const configuration = decodeKnowledgeModelRuntimeConfiguration(undefined, {
    COMPANYOS_MODEL_CONFIG_BASE64: shared,
    ANTHROPIC_API_KEY: "synthetic-anthropic-key",
    OPENAI_API_KEY: "synthetic-openai-key",
  });
  assert.equal(configuration.utility.route, "anthropic-direct");
  assert.equal(configuration.utility.maxOutputTokens, 2_000);
  assert.equal(configuration.reasoning.route, "openai-direct");
  assert.equal(configuration.reasoning.maxOutputTokens, 8_000);
  assert.equal(configuration.utility.qualification, undefined);
});

test("Knowledge structured-output schemas type every constant for strict provider validation", () => {
  const constantNodes: Array<Record<string, unknown>> = [];
  const enumNodes: Array<Record<string, unknown>> = [];
  const forbiddenOneOfNodes: Array<Record<string, unknown>> = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (Object.hasOwn(node, "const")) constantNodes.push(node);
    if (Object.hasOwn(node, "enum")) enumNodes.push(node);
    if (Object.hasOwn(node, "oneOf")) forbiddenOneOfNodes.push(node);
    Object.values(node).forEach(visit);
  };
  visit(KNOWLEDGE_EXTRACTION_JSON_SCHEMA);
  visit(KNOWLEDGE_SMOKE_TEST_JSON_SCHEMA);
  assert.equal(constantNodes.length, 7);
  assert.ok(constantNodes.every((node) => node.type === "string"));
  assert.equal(enumNodes.length, 5);
  assert.ok(enumNodes.every((node) => node.type === "string"));
  assert.deepEqual(forbiddenOneOfNodes, []);
});
