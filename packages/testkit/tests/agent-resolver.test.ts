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

test("AgentResolver gives exact bindings precedence over assignments and assignments precedence over defaults", () => {
  assert.deepEqual(
    resolveAgent(routing, agents, {
      surface: "slack",
      accountId: "T1",
      channelId: "C-BUILD",
      assignment: { assignmentId: "ca_1", agentId: "sales" },
    }),
    { agentId: "builder", reason: "binding", bindingId: "builder-channel" },
  );
  assert.deepEqual(
    resolveAgent(routing, agents, {
      surface: "slack",
      accountId: "T1",
      channelId: "D-PERSON",
      assignment: { assignmentId: "ca_1", agentId: "sales" },
    }),
    { agentId: "sales", reason: "assignment", assignmentId: "ca_1" },
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

test("AgentResolver requires exactly one bounded handoff expiry policy", () => {
  const base = {
    id: "handoff",
    fromAgentId: "sales",
    toAgentId: "marketing",
    purpose: "campaign",
    surfaces: ["slack"],
    eligibleRoles: ["contributor"],
    eligibleGroups: [],
  };
  assert.doesNotThrow(() => validateAgentRouting({ ...routing, handoffs: [{ ...base, ttlSeconds: 600 }] }, agents));
  assert.doesNotThrow(() => validateAgentRouting({ ...routing, handoffs: [{ ...base, localDayEndTimeZone: "Europe/Madrid" }] }, agents));
  for (const handoff of [
    base,
    { ...base, ttlSeconds: 600, localDayEndTimeZone: "Europe/Madrid" },
    { ...base, localDayEndTimeZone: "Not/A-Timezone" },
  ]) {
    assert.throws(
      () => validateAgentRouting({ ...routing, handoffs: [handoff] }, agents),
      (error: unknown) => error instanceof AgentResolutionError && error.code === "invalid-routing",
    );
  }
});
