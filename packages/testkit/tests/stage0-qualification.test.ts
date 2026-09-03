import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import {
  authorizeStage0,
  decodeStage0Configuration,
  executeStage0,
  parseStage0Request,
  Stage0QualificationError,
} from "../../runner-vercel/src/lib/stage0-qualification.ts";

const configuration = {
  version: 1,
  environment: "preview",
  instance_id: "acme-companyos-stage0",
  requester_principal: "slack:T00001:U00001",
  general_agent_id: "oregano",
  sprint_agent_id: "sprint",
  monday: {
    resource_binding: "sprint-test-board",
    status_field: "status",
    candidate_status_labels: ["Working on it", "Done"],
    account_id: "20000001",
    callback_agent_id: "100000001",
    signing_secret_ref: "env:MONDAY_SIGNING_SECRET",
  },
  slack: {
    account_id: "T00001",
    channel_id: "C00001",
    channel_destination_binding: "sprint-test-channel",
    direct_destination_binding: "steward-test-dm",
  },
} as const;

test("Stage-0 configuration is Preview-only, compressed, exact, and carries no credential values", () => {
  const encoded = gzipSync(JSON.stringify(configuration)).toString("base64");
  const parsed = decodeStage0Configuration(encoded);
  assert.deepEqual(parsed, configuration);
  assert.doesNotMatch(JSON.stringify(parsed), /xoxb-|Bearer |api[_-]?key/i);
  const previous = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "production";
  try {
    assert.throws(() => decodeStage0Configuration(encoded), (error: unknown) => error instanceof Stage0QualificationError && error.code === "preview-only");
  } finally {
    if (previous === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previous;
  }
});

test("Stage-0 endpoint authorization uses the exact bearer secret", () => {
  assert.equal(authorizeStage0(new Request("https://preview.example", { headers: { authorization: "Bearer fixture-secret" } }), "fixture-secret"), true);
  assert.equal(authorizeStage0(new Request("https://preview.example", { headers: { authorization: "Bearer wrong" } }), "fixture-secret"), false);
  assert.equal(authorizeStage0(new Request("https://preview.example"), "fixture-secret"), false);
});

test("Stage-0 effect requests require exact confirmation hashes and reject extra fields", () => {
  assert.deepEqual(parseStage0Request({
    action: "test-sprint-workers",
    test_id: "stage0-clock-1",
    at: "2030-02-01T17:00:00.000Z",
  }), {
    action: "test-sprint-workers",
    test_id: "stage0-clock-1",
    at: "2030-02-01T17:00:00.000Z",
  });
  assert.deepEqual(parseStage0Request({
    action: "apply-slack-direct",
    test_id: "stage0-direct-1",
    direct_content: "test",
    confirmation_hash: "b".repeat(64),
  }), {
    action: "apply-slack-direct",
    test_id: "stage0-direct-1",
    direct_content: "test",
    confirmation_hash: "b".repeat(64),
  });
  assert.deepEqual(parseStage0Request({
    action: "apply-monday-reversible",
    test_id: "stage0-test-1",
    work_item_id: "123456",
    confirmation_hash: "a".repeat(64),
  }), {
    action: "apply-monday-reversible",
    test_id: "stage0-test-1",
    work_item_id: "123456",
    confirmation_hash: "a".repeat(64),
  });
  assert.throws(() => parseStage0Request({ action: "inspect", production: true }), (error: unknown) => error instanceof Stage0QualificationError && error.status === 400);
  assert.throws(() => parseStage0Request({ action: "test-sprint-workers", test_id: "stage0-clock-1", at: "not-a-time" }), (error: unknown) => error instanceof Stage0QualificationError && error.status === 400);
  assert.throws(() => parseStage0Request({ action: "apply-slack-delivery", test_id: "stage0-test-1", channel_content: "x", direct_content: "y" }), (error: unknown) => error instanceof Stage0QualificationError && error.status === 400);
  assert.throws(() => parseStage0Request({ action: "plan-slack-direct", test_id: "stage0-direct-1", direct_content: "x", channel_content: "not-allowed" }), (error: unknown) => error instanceof Stage0QualificationError && error.status === 400);
});

test("Stage-0 direct-message qualification executes only as the compiled Sprint service principal", async () => {
  const calls: Record<string, unknown>[] = [];
  const artifact = {
    instance: { id: configuration.instance_id, environment: "preview" },
    agents: [{ id: configuration.general_agent_id }, { id: configuration.sprint_agent_id }],
    sprints: [{ agentId: configuration.sprint_agent_id, servicePrincipal: "agent:sprint" }],
  } as never;
  const runtime = {
    execute: async (request: Record<string, unknown>) => {
      calls.push(request);
      return { output: { message_id: "1", destination_binding: "steward-test-dm" } };
    },
  } as never;
  const planned = await executeStage0({
    action: "plan-slack-direct",
    test_id: "stage0-direct-2",
    direct_content: "test",
  }, configuration, { artifact, runtime, chat: {} as never });
  const confirmationHash = (planned as { plan: { confirmation_hash: string } }).plan.confirmation_hash;
  const applied = await executeStage0({
    action: "apply-slack-direct",
    test_id: "stage0-direct-2",
    direct_content: "test",
    confirmation_hash: confirmationHash,
  }, configuration, { artifact, runtime, chat: {} as never });
  assert.equal(applied.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.subjectPrincipal, "agent:sprint");
  assert.equal(calls[0]!.runId, "stage0-slack-direct-stage0-direct-2");
  assert.equal(calls[1]!.runId, calls[0]!.runId);
});

test("Stage-0 can qualify hosted Sprint workers at a controlled Preview time", async () => {
  const calls: string[] = [];
  const result = await executeStage0({
    action: "test-sprint-workers",
    test_id: "stage0-clock-1",
    at: "2030-02-01T17:00:00.000Z",
  }, configuration, {
    artifact: {
      instance: { id: configuration.instance_id, environment: "preview" },
      agents: [{ id: configuration.general_agent_id }, { id: configuration.sprint_agent_id }],
    } as never,
    runtime: {} as never,
    chat: {} as never,
    runSprintTimerWorker: async (now) => {
      calls.push(`timers:${now}`);
      return { ok: true, processed: 3 };
    },
    runSprintIntentWorker: async (now) => {
      calls.push(`intents:${now}`);
      return { ok: true, processed: 3 };
    },
  });
  assert.deepEqual(calls, ["timers:2030-02-01T17:00:00.000Z", "intents:2030-02-01T17:00:00.000Z"]);
  assert.equal(result.ok, true);
  assert.equal(result.environment, "preview");
  assert.equal(result.production_touched, false);
});
