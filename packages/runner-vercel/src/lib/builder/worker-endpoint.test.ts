import assert from "node:assert/strict";
import test from "node:test";
import { handleBuilderWorkerRequest } from "./worker-endpoint.ts";

test("a disabled Builder worker is an authorized no-op without constructing runtime dependencies", async () => {
  let workerIdCalls = 0;
  let advanceCalls = 0;
  let notificationCalls = 0;
  const response = await handleBuilderWorkerRequest(
    new Request("https://company.invalid/api/builder/worker", {
      headers: { authorization: "Bearer cron-secret" },
    }),
    {
      cronSecret: "cron-secret",
      loadArtifact: () => ({}),
      createWorkerId: () => {
        workerIdCalls += 1;
        return "must-not-be-created";
      },
      advanceOne: async () => {
        advanceCalls += 1;
        throw new Error("must not construct or invoke the Builder service");
      },
      deliverNotification: async () => {
        notificationCalls += 1;
        throw new Error("must not construct or invoke notification dependencies");
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    enabled: false,
    result: { state: "idle", reason: "builder-disabled" },
    notification: { state: "idle", reason: "builder-disabled" },
  });
  assert.equal(workerIdCalls, 0);
  assert.equal(advanceCalls, 0);
  assert.equal(notificationCalls, 0);
});

test("Builder worker authentication fails before the Artifact or runtime is inspected", async () => {
  let artifactCalls = 0;
  const response = await handleBuilderWorkerRequest(
    new Request("https://company.invalid/api/builder/worker"),
    {
      cronSecret: "cron-secret",
      loadArtifact: () => {
        artifactCalls += 1;
        return { builder: {} };
      },
      createWorkerId: () => "worker",
      advanceOne: async () => ({}),
      deliverNotification: async () => ({}),
    },
  );

  assert.equal(response.status, 401);
  assert.equal(artifactCalls, 0);
});
