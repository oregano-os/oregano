import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveSlackAgentExperience,
  resolveSlackAgentSessionThreadId,
  showSlackAgentWorking,
} from "./slack-agent-experience.ts";

test("Slack Agent View is opt-in and requires the exact true value", () => {
  assert.deepEqual(resolveSlackAgentExperience({}), { enabled: false, workingStatus: "Working" });
  assert.equal(resolveSlackAgentExperience({ COMPANYOS_SLACK_AGENT_VIEW: "false" }).enabled, false);
  assert.equal(resolveSlackAgentExperience({ COMPANYOS_SLACK_AGENT_VIEW: "1" }).enabled, false);
  assert.equal(resolveSlackAgentExperience({ COMPANYOS_SLACK_AGENT_VIEW: "true" }).enabled, true);
});

test("legacy subscribed Slack DMs use the accepted message root for Agent Session presentation", () => {
  const enabled = { enabled: true, workingStatus: "Working" } as const;
  assert.equal(
    resolveSlackAgentSessionThreadId("slack:D012345:", "1788494042.306000", enabled),
    "slack:D012345:1788494042.306000",
  );
  assert.equal(
    resolveSlackAgentSessionThreadId("slack:D012345:1788494000.100000", "1788494042.306000", enabled),
    "slack:D012345:1788494000.100000",
  );
  assert.equal(
    resolveSlackAgentSessionThreadId("slack:C012345:", "1788494042.306000", enabled),
    "slack:C012345:",
  );
  assert.equal(
    resolveSlackAgentSessionThreadId("slack:D012345:", "not-a-slack-message", enabled),
    "slack:D012345:",
  );
  assert.equal(
    resolveSlackAgentSessionThreadId(
      "slack:D012345:",
      "1788494042.306000",
      { enabled: false, workingStatus: "Working" },
    ),
    "slack:D012345:",
  );
});

test("accepted Agent View turns show one native Working status", async () => {
  const statuses: Array<string | undefined> = [];
  await showSlackAgentWorking(
    { startTyping: async (status?: string) => { statuses.push(status); } },
    { enabled: true, workingStatus: "Working" },
  );
  assert.deepEqual(statuses, ["Working"]);
});

test("disabled presentation and provider status failures do not block a turn", async () => {
  let calls = 0;
  const thread = {
    startTyping: async () => {
      calls += 1;
      throw new Error("provider status unavailable");
    },
  };
  await showSlackAgentWorking(thread, { enabled: false, workingStatus: "Working" });
  assert.equal(calls, 0);
  await assert.doesNotReject(showSlackAgentWorking(thread, { enabled: true, workingStatus: "Working" }));
  assert.equal(calls, 1);
});
