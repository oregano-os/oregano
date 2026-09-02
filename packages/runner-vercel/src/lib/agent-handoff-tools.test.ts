import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentHandoffService } from "../../../runtime/agent-handoff.ts";
import type { CompiledAgentRouting } from "../../../runtime/agent-resolver.ts";
import { InMemoryConversationAssignmentStore } from "../../../testkit/adapter/in-memory-conversation-assignment-store.ts";
import { executeAgentHandoffControl } from "./agent-handoff-tools.ts";

const artifactHash = "c".repeat(64);
const assignmentKey = {
  instanceId: "isle",
  surface: "slack",
  accountId: "T1",
  channelId: "D1",
  subjectPrincipal: "slack:T1:U1",
};

test("Runner handoff control applies on the next turn and does not accept message content", async () => {
  const store = new InMemoryConversationAssignmentStore();
  const routing: CompiledAgentRouting = {
    bindings: [],
    defaultAgentId: "oregano",
    handoffs: [{
      id: "sprint",
      fromAgentId: "oregano",
      toAgentId: "sprint",
      purpose: "sprint",
      surfaces: ["slack"],
      eligibleRoles: [],
      eligibleGroups: ["sprint"],
      ttlSeconds: 600,
    }],
  };
  const service = new AgentHandoffService({
    artifactHash,
    routing,
    agentIds: ["oregano", "sprint"],
    roster: [{ name: "Alex", role: "member", status: "active", mayApprove: [], principals: ["slack:T1:U1"], groups: ["sprint"] }],
    store,
  });
  const result = await executeAgentHandoffControl(
    { action: "handoff", target_agent: "sprint", purpose: "sprint" },
    {
      service,
      assignmentKey,
      activeAgentId: "oregano",
      resolution: { agentId: "oregano", reason: "default" },
      artifactHash,
      messageId: "M1",
      now: () => "2026-09-01T10:00:00.000Z",
    },
  );
  assert.equal(result.routeApplies, "next-turn");
  assert.equal(result.activeAgent, "sprint");
  assert.deepEqual(Object.keys(store.receipts[0]!.evidence).sort(), ["artifactHash", "purpose", "reason", "ruleId"]);
});
