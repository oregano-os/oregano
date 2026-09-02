import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AgentHandoffError, AgentHandoffService } from "../../runtime/agent-handoff.ts";
import { resolveAgent, type CompiledAgentRouting } from "../../runtime/agent-resolver.ts";
import type { RosterMember } from "../../state-store/roster.ts";
import { InMemoryConversationAssignmentStore } from "../adapter/in-memory-conversation-assignment-store.ts";

const artifactHash = "a".repeat(64);
const routing: CompiledAgentRouting = {
  bindings: [
    { id: "sprint-channel", agentId: "sprint", surface: "slack", accountId: "T1", channelId: "C-SPRINT" },
  ],
  handoffs: [{
    id: "oregano-to-sprint",
    fromAgentId: "oregano",
    toAgentId: "sprint",
    purpose: "sprint",
    surfaces: ["slack"],
    eligibleRoles: ["contributor"],
    eligibleGroups: ["sprint-participant"],
    ttlSeconds: 3_600,
  }],
  defaultAgentId: "oregano",
};
const agents = ["oregano", "sprint"];
const roster: RosterMember[] = [{
  name: "Alex",
  role: "contributor",
  status: "active",
  mayApprove: [],
  principals: ["slack:T1:U1"],
  groups: ["sprint-participant"],
}];
const key = {
  instanceId: "instance-1",
  surface: "slack",
  accountId: "T1",
  channelId: "D1",
  subjectPrincipal: "slack:T1:U1",
};
const at = "2026-09-01T10:00:00.000Z";

const createService = () => {
  const store = new InMemoryConversationAssignmentStore();
  const service = new AgentHandoffService({ artifactHash, routing, agentIds: agents, roster, store });
  return { service, store };
};

test("governed handoff creates a sticky assignment without copying messages or ToolSets", async () => {
  const { service, store } = createService();
  const result = await service.handoff({
    ...key,
    activeAgentId: "oregano",
    targetAgentId: "sprint",
    purpose: "sprint",
    transitionKey: "turn-1",
    artifactHash,
    requestedAt: at,
  });
  assert.equal(result.outcome, "applied");
  assert.equal(result.assignment?.agentId, "sprint");
  assert.deepEqual(
    resolveAgent(routing, agents, {
      surface: key.surface,
      accountId: key.accountId,
      channelId: key.channelId,
      assignment: { assignmentId: result.assignment!.assignmentId, agentId: result.assignment!.agentId },
    }),
    { agentId: "sprint", reason: "assignment", assignmentId: result.assignment!.assignmentId },
  );
  const serialized = JSON.stringify({ assignment: result.assignment, receipt: store.receipts[0] });
  assert.doesNotMatch(serialized, /message|prompt|toolset|token/i);
});

test("duplicate requests reuse prior assignment and return clears it exactly once", async () => {
  const { service, store } = createService();
  const request = {
    ...key,
    activeAgentId: "oregano",
    targetAgentId: "sprint",
    purpose: "sprint",
    transitionKey: "turn-1",
    artifactHash,
    requestedAt: at,
  } as const;
  const first = await service.handoff(request);
  const duplicate = await service.handoff(request);
  assert.equal(duplicate.outcome, "duplicate");
  assert.equal(store.receipts.length, 1);
  const returned = await service.returnToDefault({
    ...key,
    activeAgentId: "sprint",
    transitionKey: "turn-2",
    artifactHash,
    requestedAt: "2026-09-01T10:10:00.000Z",
  });
  assert.equal(returned.outcome, "applied");
  assert.equal(await store.getActive(key, "2026-09-01T10:11:00.000Z"), undefined);
  assert.equal(store.receipts.length, 2);
  assert.equal(first.assignment?.fromAgentId, "oregano");
});

test("handoffs fail closed for exact bindings, stale Artifacts, and unauthorized principals", async () => {
  const { service } = createService();
  const base = {
    ...key,
    activeAgentId: "oregano",
    targetAgentId: "sprint",
    purpose: "sprint",
    transitionKey: "turn-1",
    artifactHash,
    requestedAt: at,
  };
  await assert.rejects(
    () => service.handoff({ ...base, channelId: "C-SPRINT" }),
    (error: unknown) => error instanceof AgentHandoffError && error.code === "exact-binding",
  );
  await assert.rejects(
    () => service.handoff({ ...base, artifactHash: "b".repeat(64) }),
    (error: unknown) => error instanceof AgentHandoffError && error.code === "stale-artifact",
  );
  await assert.rejects(
    () => service.handoff({ ...base, subjectPrincipal: "slack:T1:UNKNOWN" }),
    (error: unknown) => error instanceof AgentHandoffError && error.code === "unknown-principal",
  );
});

test("expired assignments no longer route and may be replaced safely", async () => {
  const { service, store } = createService();
  const first = await service.handoff({
    ...key,
    activeAgentId: "oregano",
    targetAgentId: "sprint",
    purpose: "sprint",
    transitionKey: "turn-1",
    artifactHash,
    requestedAt: at,
  });
  assert.ok(first.assignment);
  assert.equal(await store.getActive(key, "2026-09-01T11:00:00.000Z"), undefined);
  const replacement = await service.handoff({
    ...key,
    activeAgentId: "oregano",
    targetAgentId: "sprint",
    purpose: "sprint",
    transitionKey: "turn-3",
    artifactHash,
    requestedAt: "2026-09-01T11:00:00.000Z",
  });
  assert.equal(replacement.outcome, "applied");
  assert.notEqual(replacement.assignment?.assignmentId, first.assignment?.assignmentId);
});

test("the assigned subject or an R2 approver can revoke without deleting evidence", async () => {
  const store = new InMemoryConversationAssignmentStore();
  const service = new AgentHandoffService({
    artifactHash,
    routing,
    agentIds: agents,
    roster: [
      ...roster,
      { name: "Steward", role: "workspace-steward", status: "active", mayApprove: ["R2"], principals: ["slack:T1:STEWARD"] },
    ],
    store,
  });
  await service.handoff({
    ...key,
    activeAgentId: "oregano",
    targetAgentId: "sprint",
    purpose: "sprint",
    transitionKey: "turn-1",
    artifactHash,
    requestedAt: at,
  });
  const result = await service.revoke({
    ...key,
    revokedByPrincipal: "slack:T1:STEWARD",
    transitionKey: "operator-revoke-1",
    artifactHash,
    requestedAt: "2026-09-01T10:05:00.000Z",
    reason: "operator requested bounded routing reset",
  });
  assert.equal(result.outcome, "applied");
  assert.equal(await store.getActive(key, "2026-09-01T10:06:00.000Z"), undefined);
  assert.equal(store.receipts.at(-1)?.action, "revoke");
  assert.equal(store.receipts.at(-1)?.initiatedByPrincipal, "slack:T1:STEWARD");
});

test("Conversation Assignment tables are additive, mirrored, and contain no raw transcript column", () => {
  const migration = readFileSync(new URL("../../state-postgres/migrate.ts", import.meta.url), "utf8");
  const schema = readFileSync(new URL("../../state-postgres/schema.sql", import.meta.url), "utf8");
  for (const table of ["conversation_assignments", "conversation_assignment_transitions"]) {
    const expression = new RegExp(`create table if not exists companyos\\.${table}`);
    assert.match(migration, expression);
    assert.match(schema, expression);
  }
  assert.doesNotMatch(`${migration}\n${schema}`, /raw_(?:message|prompt|transcript)|message_body/i);
  assert.doesNotMatch(`${migration}\n${schema}`, /\b(?:drop|truncate)\b/i);
});
