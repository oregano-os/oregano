import assert from "node:assert/strict";
import test from "node:test";
import {
  abortRememberedSlackAgentSessionConversation,
  createSlackToolProgressReporter,
  rememberSlackAgentSessionConversation,
  resolveSlackAgentExperience,
  resolveSlackAgentSessionThreadId,
  resolveSlackTurnAbortSignal,
  shouldStreamSlackAgentResponse,
  showSlackAgentWorking,
  toolResultNeedsHumanInput,
  validatedSlackResponsePlan,
} from "./slack-agent-experience.ts";

test("Slack Agent View is opt-in and requires the exact true value", () => {
  assert.deepEqual(resolveSlackAgentExperience({}), {
    enabled: false,
    streamingEnabled: false,
    workingStatus: "Working",
  });
  assert.equal(resolveSlackAgentExperience({ COMPANYOS_SLACK_AGENT_VIEW: "false" }).enabled, false);
  assert.equal(resolveSlackAgentExperience({ COMPANYOS_SLACK_AGENT_VIEW: "1" }).enabled, false);
  assert.deepEqual(resolveSlackAgentExperience({ COMPANYOS_SLACK_AGENT_VIEW: "true" }), {
    enabled: true,
    streamingEnabled: true,
    workingStatus: "Working",
  });
});

test("native streaming is limited to ordinary replies without Company business Tools", () => {
  const configuration = resolveSlackAgentExperience({ COMPANYOS_SLACK_AGENT_VIEW: "true" });
  assert.equal(shouldStreamSlackAgentResponse({
    configuration,
    agentId: "oregano",
    knowledgeRouteKind: "auto",
    businessToolCount: 0,
  }), true);
  assert.equal(shouldStreamSlackAgentResponse({
    configuration,
    agentId: "sprint",
    knowledgeRouteKind: "auto",
    businessToolCount: 1,
  }), false);
  assert.equal(shouldStreamSlackAgentResponse({
    configuration,
    agentId: "oregano",
    knowledgeRouteKind: "required-search",
    businessToolCount: 0,
  }), false);
  assert.equal(shouldStreamSlackAgentResponse({
    configuration,
    agentId: "builder",
    knowledgeRouteKind: "auto",
    businessToolCount: 0,
  }), false);
  assert.equal(shouldStreamSlackAgentResponse({
    configuration: resolveSlackAgentExperience({}),
    agentId: "oregano",
    knowledgeRouteKind: "auto",
    businessToolCount: 0,
  }), false);
});

test("validated responses stream in exact native chunks and suspend only for human input", async () => {
  const response = `${"x".repeat(319)}\n${"y".repeat(322)}`;
  const active = validatedSlackResponsePlan(response);
  const activeData = active.getPostData();
  const activeText: string[] = [];
  for await (const chunk of activeData.stream) {
    if (typeof chunk === "object" && "type" in chunk && chunk.type === "markdown_text" && "text" in chunk) {
      activeText.push(chunk.text);
    }
  }
  assert.equal(activeText.join(""), response);
  assert.equal(activeText.length, 3);
  assert.equal(activeData.options.sessionStatus, "active");
  assert.equal(validatedSlackResponsePlan("waiting", { suspended: true }).options.sessionStatus, "suspended");
});

test("only explicit approval and confirmation Tool outputs require suspended Agent state", () => {
  assert.equal(toolResultNeedsHumanInput({ pendingApproval: true }), true);
  assert.equal(toolResultNeedsHumanInput({ pendingConfirmation: true }), true);
  assert.equal(toolResultNeedsHumanInput({ pendingApproval: false }), false);
  assert.equal(toolResultNeedsHumanInput({ ok: true }), false);
  assert.equal(toolResultNeedsHumanInput(null), false);
});

test("Tool progress is presentation-only and provider failures remain best effort", async () => {
  let posts = 0;
  const reporter = createSlackToolProgressReporter({
    post: async () => {
      posts += 1;
      throw new Error("provider progress unavailable");
    },
  }, resolveSlackAgentExperience({ COMPANYOS_SLACK_AGENT_VIEW: "true" }));
  await assert.doesNotReject(reporter.start({ id: "call-1", toolName: "oregano_records_query" }));
  await assert.doesNotReject(reporter.finish({ id: "call-1", succeeded: true }));
  await assert.doesNotReject(reporter.complete());
  assert.equal(posts, 1);

  let disabledPosts = 0;
  const disabled = createSlackToolProgressReporter({
    post: async () => { disabledPosts += 1; return undefined as never; },
  }, resolveSlackAgentExperience({}));
  await disabled.start({ id: "call-2", toolName: "oregano_records_query" });
  assert.equal(disabledPosts, 0);
});

test("legacy subscribed Slack DMs use the accepted message root for Agent Session presentation", () => {
  const enabled = { enabled: true, streamingEnabled: true, workingStatus: "Working" } as const;
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
      { enabled: false, streamingEnabled: false, workingStatus: "Working" },
    ),
    "slack:D012345:",
  );
});

test("accepted Agent View turns show one native Working status", async () => {
  const statuses: Array<string | undefined> = [];
  await showSlackAgentWorking(
    { startTyping: async (status?: string) => { statuses.push(status); } },
    { enabled: true, streamingEnabled: true, workingStatus: "Working" },
  );
  assert.deepEqual(statuses, ["Working"]);
});

test("legacy Agent Session stop events abort only the remembered CompanyOS conversation", async () => {
  const values = new Map<string, unknown>();
  const state = {
    set: async (key: string, value: unknown) => { values.set(key, value); },
    get: async <T>(key: string) => (values.get(key) as T | undefined) ?? null,
    delete: async (key: string) => { values.delete(key); },
  };
  const aborted: string[] = [];
  const chat = { abortTurn: async (threadId: string) => { aborted.push(threadId); } };
  const enabled = { enabled: true, streamingEnabled: true, workingStatus: "Working" } as const;

  await rememberSlackAgentSessionConversation(
    state,
    "slack:D012345:1788494042.306000",
    "slack:D012345:",
    enabled,
  );
  assert.equal(await abortRememberedSlackAgentSessionConversation(
    chat,
    state,
    "slack:D012345:1788494042.306000",
    enabled,
  ), true);
  assert.deepEqual(aborted, ["slack:D012345:"]);
  assert.equal(await abortRememberedSlackAgentSessionConversation(
    chat,
    state,
    "slack:D012345:1788494042.306000",
    enabled,
  ), false);
});

test("native per-message sessions need no legacy stop bridge", async () => {
  let writes = 0;
  await rememberSlackAgentSessionConversation(
    { set: async () => { writes += 1; } },
    "slack:D012345:1788494042.306000",
    "slack:D012345:1788494042.306000",
    { enabled: true, streamingEnabled: true, workingStatus: "Working" },
  );
  assert.equal(writes, 0);
});

test("Slack stop aborts the model signal while preserving the timeout boundary", () => {
  const controller = new AbortController();
  const signal = resolveSlackTurnAbortSignal(controller.signal, 60_000);
  assert.equal(signal.aborted, false);
  controller.abort();
  assert.equal(signal.aborted, true);
});

test("disabled presentation and provider status failures do not block a turn", async () => {
  let calls = 0;
  const thread = {
    startTyping: async () => {
      calls += 1;
      throw new Error("provider status unavailable");
    },
  };
  await showSlackAgentWorking(thread, { enabled: false, streamingEnabled: false, workingStatus: "Working" });
  assert.equal(calls, 0);
  await assert.doesNotReject(showSlackAgentWorking(thread, { enabled: true, streamingEnabled: true, workingStatus: "Working" }));
  assert.equal(calls, 1);
});
