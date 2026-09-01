import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import type { CompanyOSArtifact } from "../../companyos-builder/types.ts";
import { InMemoryMondayReplayStore } from "../../connectors/monday/webhook.ts";
import {
  handleMondayAgentWebhook,
  StateAdapterMondayReplayStore,
} from "../../runner-vercel/src/lib/monday-agent-webhook.ts";

const NOW = 1_782_326_623_754;
const SIGNING_SECRET = "fixture-signing-secret";
const EXTERNAL_AGENT_ID = "900001";

function artifact(args?: { multiAgent?: boolean; boardBinding?: boolean }): CompanyOSArtifact {
  const agents = args?.multiAgent
    ? [{ id: "general" }, { id: "sprint-agent" }]
    : [{ id: "oregano" }];
  return {
    schemaVersion: 1,
    company: "Synthetic Company",
    instance: { id: "fixture-instance", environment: "production" },
    provenance: {} as CompanyOSArtifact["provenance"],
    capabilityCatalog: [],
    bindings: [],
    roster: [],
    agents: agents.map((agent) => ({
      ...agent,
      instructions: "PRIVATE-INSTRUCTION-MARKER",
      materials: { "company.md": "PRIVATE-MATERIAL-MARKER" },
      toolSet: { resolverVersion: "1", agentId: agent.id, tools: [], hash: "fixture" },
      tools: [],
    })) as CompanyOSArtifact["agents"],
    agentRouting: {
      bindings: args?.boardBinding
        ? [{ id: "sprint-board", agentId: "sprint-agent", surface: "monday", accountId: "account-1", channelId: "board:700001" }]
        : [],
      ...(args?.multiAgent && !args.boardBinding ? { defaultAgentId: "general" } : {}),
    },
    artifactHash: "fixture",
  };
}

function request(body: Record<string, unknown>, args?: { agentId?: string; signature?: string; method?: string }): Request {
  const rawBody = JSON.stringify(body);
  const agentId = args?.agentId ?? EXTERNAL_AGENT_ID;
  const signature = args?.signature
    ?? `sha256=${createHmac("sha256", SIGNING_SECRET).update(`${NOW}.${rawBody}`).digest("hex")}`;
  return new Request("https://company.example/api/webhooks/monday", {
    method: args?.method ?? "POST",
    headers: {
      "content-type": "application/json",
      "x-monday-agent-id": agentId,
      "x-monday-signature": signature,
      "x-monday-timestamp": String(NOW),
    },
    ...(args?.method === "GET" ? {} : { body: rawBody }),
  });
}

function dependencies(overrides?: Partial<Parameters<typeof handleMondayAgentWebhook>[1]>) {
  return {
    artifact: artifact(),
    accountId: "account-1",
    expectedAgentId: EXTERNAL_AGENT_ID,
    signingSecret: SIGNING_SECRET,
    replayStore: new InMemoryMondayReplayStore(),
    now: () => NOW,
    ...overrides,
  };
}

test("Monday setup probes resolve the compiled Agent and return the exact SSE contract", async () => {
  const response = await handleMondayAgentWebhook(request({
    event: "agent_triggered",
    triggerType: "chat",
    payload: { text: "Setup-Test oregano-0123456789ab" },
    timestamp: new Date(NOW).toISOString(),
    stream: true,
  }), dependencies());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.equal(
    await response.text(),
    `data: ${JSON.stringify({ type: "text", content: "Setup-Test oregano-0123456789ab successful." })}\n\ndata: [DONE]\n\n`,
  );
});

test("ordinary Monday chat fails closed without exposing Artifact material or invoking Tools", async () => {
  const response = await handleMondayAgentWebhook(request({
    event: "agent_triggered",
    triggerType: "chat",
    payload: { text: "Tell me about the company" },
    timestamp: new Date(NOW).toISOString(),
    stream: false,
  }), dependencies());
  assert.equal(response.status, 200);
  const body = await response.json() as { message: string };
  assert.match(body.message, /does not identify the person/i);
  assert.doesNotMatch(body.message, /PRIVATE-(?:INSTRUCTION|MATERIAL)-MARKER/);
});

test("wrong Agent identity, invalid signatures, and replay fail before dispatch", async () => {
  const body = {
    event: "agent_triggered",
    triggerType: "chat",
    payload: { text: "Setup-Test oregano-0123456789ab" },
    timestamp: new Date(NOW).toISOString(),
    stream: false,
  };
  const wrongAgent = await handleMondayAgentWebhook(request(body, { agentId: "different-agent" }), dependencies());
  assert.equal(wrongAgent.status, 401);
  const invalidSignature = await handleMondayAgentWebhook(request(body, { signature: "sha256=invalid" }), dependencies());
  assert.equal(invalidSignature.status, 401);

  const replayStore = new InMemoryMondayReplayStore();
  const first = await handleMondayAgentWebhook(request(body), dependencies({ replayStore }));
  const second = await handleMondayAgentWebhook(request(body), dependencies({ replayStore }));
  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
});

test("current mention and assigned aliases resolve exact board routes and only acknowledge", async () => {
  const mentionResponse = await handleMondayAgentWebhook(request({
    event: "agent_triggered",
    triggerType: "mentioned",
    payload: { text: "monday instruction", updateBody: "status?", boardId: "700001", itemId: "800001", updateId: "800002" },
    timestamp: new Date(NOW).toISOString(),
  }), dependencies({ artifact: artifact({ multiAgent: true, boardBinding: true }) }));
  assert.equal(mentionResponse.status, 200);
  assert.equal(await mentionResponse.text(), "data: [DONE]\n\n");

  const assignedResponse = await handleMondayAgentWebhook(request({
    event: "agent_triggered",
    triggerType: "assign",
    payload: { text: "assigned", boardId: "700001", itemId: "800001" },
    timestamp: new Date(NOW).toISOString(),
    stream: false,
  }), dependencies({ artifact: artifact({ multiAgent: true, boardBinding: true }), replayStore: new InMemoryMondayReplayStore() }));
  assert.equal(assignedResponse.status, 200);
  assert.deepEqual(await assignedResponse.json(), { message: "" });
});

test("Monday ingress accepts POST only and durable replay keys retain no signature", async () => {
  const methodResponse = await handleMondayAgentWebhook(request({}, { method: "GET" }), dependencies());
  assert.equal(methodResponse.status, 405);
  assert.equal(methodResponse.headers.get("allow"), "POST");

  const keys: string[] = [];
  const replayStore = new StateAdapterMondayReplayStore({
    async setIfNotExists(key: string) {
      keys.push(key);
      return true;
    },
  } as any, () => NOW);
  const rawReplayKey = "agent:timestamp:sha256=raw-signature";
  assert.equal(await replayStore.claim(rawReplayKey, new Date(NOW + 60_000).toISOString()), true);
  assert.equal(keys.length, 1);
  assert.doesNotMatch(keys[0] ?? "", /raw-signature|sha256=/);
});
