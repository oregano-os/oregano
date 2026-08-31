import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentResolutionError,
  resolveAgent,
  validateAgentRouting,
  type CompiledAgentRouting,
} from "../../runtime/agent-resolver.ts";

const routing: CompiledAgentRouting = {
  bindings: [
    { id: "sales-channel", agentId: "sales", surface: "slack", accountId: "T1", channelId: "C-SALES" },
    { id: "builder-channel", agentId: "builder", surface: "slack", accountId: "T1", channelId: "C-BUILD" },
  ],
  defaultAgentId: "marketing",
};
const agents = ["sales", "marketing", "builder"];

test("AgentResolver selects exact channel bindings and preserves thread routing facts", () => {
  assert.deepEqual(
    resolveAgent(routing, agents, { surface: "slack", accountId: "T1", channelId: "C-BUILD" }),
    { agentId: "builder", reason: "binding", bindingId: "builder-channel" },
  );
  assert.deepEqual(
    resolveAgent(routing, agents, { surface: "slack", accountId: "T1", channelId: "C-BUILD" }),
    { agentId: "builder", reason: "binding", bindingId: "builder-channel" },
  );
});

test("AgentResolver uses only an explicit default in a multi-agent Artifact", () => {
  assert.deepEqual(
    resolveAgent(routing, agents, { surface: "slack", accountId: "T1", channelId: "C-OTHER" }),
    { agentId: "marketing", reason: "default" },
  );
});

test("AgentResolver permits the sole compiled Agent without a routing declaration", () => {
  assert.deepEqual(
    resolveAgent({ bindings: [] }, ["sales"], { surface: "slack", accountId: "T1", channelId: "C1" }),
    { agentId: "sales", reason: "single-agent" },
  );
});

test("AgentResolver fails closed for unknown and ambiguous multi-agent routes", () => {
  assert.throws(
    () => resolveAgent({ bindings: [] }, agents, { surface: "slack", accountId: "T1", channelId: "C1" }),
    (error: unknown) => error instanceof AgentResolutionError && error.code === "invalid-routing",
  );
  assert.throws(
    () => validateAgentRouting({
      bindings: [
        { id: "one", agentId: "sales", surface: "slack", accountId: "T1", channelId: "C1" },
        { id: "two", agentId: "builder", surface: "slack", accountId: "T1", channelId: "C1" },
      ],
    }, agents),
    (error: unknown) => error instanceof AgentResolutionError && error.code === "ambiguous-route",
  );
});
