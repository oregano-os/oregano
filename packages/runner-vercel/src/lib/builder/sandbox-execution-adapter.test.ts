import assert from "node:assert/strict";
import test from "node:test";
import { isExpectedBuilderWorkerResult } from "./sandbox-execution-adapter.ts";

const expected = {
  jobId: "builder-job-1",
  requestId: "request-1",
  profileId: "claude-code",
};

test("recognizes a complete job-bound worker result before process exit", () => {
  const output = JSON.stringify({
    schemaVersion: 1,
    ...expected,
    state: "succeeded",
    evidence: { stopReason: "end_turn" },
  });

  assert.equal(isExpectedBuilderWorkerResult(output, expected), true);
});

test("rejects malformed or differently bound worker output", () => {
  assert.equal(isExpectedBuilderWorkerResult("not-json", expected), false);
  assert.equal(isExpectedBuilderWorkerResult(JSON.stringify({
    schemaVersion: 1,
    ...expected,
    jobId: "builder-job-2",
    state: "succeeded",
    evidence: {},
  }), expected), false);
  assert.equal(isExpectedBuilderWorkerResult(JSON.stringify({
    schemaVersion: 1,
    ...expected,
  }), expected), false);
  assert.equal(isExpectedBuilderWorkerResult(JSON.stringify({
    schemaVersion: 1,
    ...expected,
    state: "failed",
    failure: { category: "acp-process-exit" },
  }), expected), true);
});
