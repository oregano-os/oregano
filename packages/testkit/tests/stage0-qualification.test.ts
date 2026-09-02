import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import {
  authorizeStage0,
  decodeStage0Configuration,
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
};

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
  assert.throws(() => parseStage0Request({ action: "apply-slack-delivery", test_id: "stage0-test-1", channel_content: "x", direct_content: "y" }), (error: unknown) => error instanceof Stage0QualificationError && error.status === 400);
});
