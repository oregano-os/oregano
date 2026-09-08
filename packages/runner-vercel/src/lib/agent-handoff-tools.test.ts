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

test("Runner can continue a governed Builder handoff with the original request in the same turn", async () => {
  const { continuesInBuilder } = await import("./agent-handoff-tools.ts");
  const store = new InMemoryConversationAssignmentStore();
  const service = new AgentHandoffService({
    artifactHash,
    routing: { bindings: [], defaultAgentId: "oregano", handoffs: [{ id: "build", fromAgentId: "oregano", toAgentId: "builder", purpose: "workspace-change", surfaces: ["slack"], eligibleRoles: ["member"], eligibleGroups: [], ttlSeconds: 600 }] },
    agentIds: ["oregano", "builder"],
    roster: [{ name: "Alex", role: "member", status: "active", mayApprove: [], principals: [assignmentKey.subjectPrincipal] }], store,
  });
  const context = { service, assignmentKey, activeAgentId: "oregano", resolution: { agentId: "oregano", reason: "default" as const }, artifactHash, messageId: "M2", now: () => "2026-09-08T10:00:00.000Z", continueBuilderInTurn: true };
  const result = await executeAgentHandoffControl({ action: "handoff", target_agent: "builder", purpose: "workspace-change" }, context);
  assert.equal(result.routeApplies, "current-request");
  assert.equal(continuesInBuilder([{ toolName: "companyos_agent_handoff", output: result }]), true);
  assert.equal(continuesInBuilder([{ toolName: "other_tool", output: result }]), false);
  assert.equal(continuesInBuilder([{ toolName: "companyos_agent_handoff", output: { ...result, ok: false } }]), false);
  await assert.rejects(executeAgentHandoffControl({ action: "handoff", target_agent: "builder", purpose: "grant-admin" }, context), /No compiled handoff rule/);
});
