import assert from "node:assert/strict";
import test from "node:test";
import { createSlackAdapter } from "@chat-adapter/slack";
import {
  abortRememberedSlackAgentSessionConversation,
  createSlackToolProgressReporter,
  coordinatorSlackMessage,
  rememberSlackAgentSessionConversation,
  resolveSlackAgentExperience,
  resolveSlackAgentSessionThreadId,
  resolveSlackTurnAbortSignal,
  shouldStreamSlackAgentResponse,
  showSlackAgentWorking,
  withSlackAgentWorking,
  toolResultNeedsHumanInput,
  validatedSlackResponsePlan,
} from "./slack-agent-experience.ts";
import type { CompiledAgent } from "../../../companyos-builder/types.ts";

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

test("validated streams preserve Unicode at chunk boundaries through the actual adapter", async t => {
  const adapter = createSlackAdapter({ botToken: "synthetic", signingSecret: "synthetic", agentView: true });
  const requests: string[] = [];
  const transport = (adapter as any)._client;
  t.mock.method(adapter as any, "resolveOutgoingMentions", async (text: string) => text);
  t.mock.method(transport, "chatStream", () => ({
    append: async (args: { markdown_text?: string }) => {
      if (args.markdown_text) requests.push(args.markdown_text);
      return { ok: true, ts: "1893492001.000001" };
    },
    stop: async () => ({ ok: true, ts: "1893492001.000001" }),
  }));
  for (const icon of ["📊", "🔴", "🟡", "👩🏽‍💻", "𠮷"]) {
    for (const offset of [318, 319, 320, 638, 639, 640]) {
      const prefix = "Review this draft:\n\n```text\n";
      const response = prefix + "x".repeat(offset - prefix.length) + icon + " result\n```\n\nIs this correct?";
      requests.length = 0;
      const plan = validatedSlackResponsePlan(response);
      const stream = (async function* () {
        for await (const chunk of plan.getPostData().stream) {
          if (typeof chunk === "string") yield chunk;
          else if (chunk.type === "markdown_text" && "text" in chunk && typeof chunk.text === "string")
            yield { type: "markdown_text" as const, text: chunk.text };
          else assert.fail("A validated response must contain only text chunks");
        }
      })();
      await adapter.stream("slack:D12345:1893492000.000001", stream);
      assert.equal(requests.join(""), response);
      for (const request of requests) {
        assert.equal(Buffer.from(request, "utf8").toString("utf8"), request,
          `Every provider request must be valid Unicode: ${icon} at ${offset}`);
      }
    }
  }
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

test("collection controls cannot bypass buffered presentation when business grants are empty", () => {
  assert.equal(shouldStreamSlackAgentResponse({ configuration: { enabled: true, streamingEnabled: true, workingStatus: "Working" }, agentId: "synthetic-agent", knowledgeRouteKind: "auto", businessToolCount: 0, hasCollectionControl: true }), false);
});

const coordinatorConfiguration = { enabled: true, streamingEnabled: true, workingStatus: "Working" } as const;

for (const kind of ["answer", "clarification"] as const) {
  test(`coordinator ${kind} uses native Markdown and completes the exact working session`, async t => {
    const adapter = createSlackAdapter({ botToken: "xoxb-synthetic", signingSecret: "synthetic", agentView: true });
    const events: unknown[] = [];
    // The pinned adapter sends via _client; webClient is a separate token client.
    const transport = (adapter as any)._client;
    t.mock.method(transport, "apiCall", async (method: string, args: unknown) => {
      assert.equal(method, "agents.sessions.setStatus"); events.push(args); return { ok: true };
    });
    t.mock.method(transport.chat, "postMessage", async (args: unknown) => {
      events.push(args); return { ok: true, ts: "1893492001.000001" };
    });
    const id = resolveSlackAgentSessionThreadId("slack:D12345:", "1893492000.000001", coordinatorConfiguration);
    const thread = { id, adapter, startTyping: (status?: string) => adapter.startTyping(id, status) };
    const text = kind === "answer"
      ? String.raw`Open work:\n\n1. **Sales brief** — Scope is missing.\n2. **Onboarding** — Review the first day.\n\nWhich one?`
      : "Which topic do you mean?\n\n1. **Sales brief**\n2. **Onboarding**";
    const expected = "Open work:\n\n1. **Sales brief** — Scope is missing.\n2. **Onboarding** — Review the first day.\n\nWhich one?";
    const result = await withSlackAgentWorking(thread, coordinatorConfiguration, async () => {
      await adapter.postMessage(id, coordinatorSlackMessage(text)); return "delivered";
    });
    assert.equal(result, "delivered");
    assert.equal(events.length, 3);
    assert.equal((events[0] as any).status, "processing");
    assert.equal((events[1] as any).markdown_text, kind === "answer" ? expected : text);
    assert.equal((events[1] as any).text, undefined);
    assert.equal((events[1] as any).thread_ts, "1893492000.000001");
    assert.equal((events[2] as any).status, "active");
    assert.equal((events[2] as any).thread_ts, "1893492000.000001");
  });
}

test("coordinator clears working on replay, model/delivery failure and cancellation", async () => {
  for (const outcome of ["replay", "model", "delivery", "aborted"]) {
    const statuses: string[] = [];
    const thread = { id: "slack:D12345:1893492000.000001", startTyping: async () => { statuses.push("processing"); },
      adapter: { endTyping: async (_id: string, status?: string) => { statuses.push(status!); } } };
    const failure = new Error(outcome);
    const operation = withSlackAgentWorking(thread as any, coordinatorConfiguration, async () => {
      if (outcome !== "replay") throw failure;
      return "already delivered";
    });
    if (outcome === "replay") assert.equal(await operation, "already delivered");
    else await assert.rejects(operation, error => error === failure);
    assert.deepEqual(statuses, ["processing", "active"]);
  }
});

test("coordinator completion cannot overwrite the delegated Agent's suspended approval status", async () => {
  for (const destination of ["source", "other-thread"]) {
    const statuses: string[] = [];
    const thread = { id: "source", startTyping: async () => { statuses.push("source:processing"); },
      adapter: { endTyping: async (id: string, status?: string) => { statuses.push(`${id}:${status}`); } } };
    await withSlackAgentWorking(thread as any, coordinatorConfiguration, async finish => {
      await finish();
      statuses.push(`${destination}:processing`);
      statuses.push(`${destination}:suspended`);
    });
    assert.deepEqual(statuses, ["source:processing", "source:active", `${destination}:processing`, `${destination}:suspended`]);
  }
});

test("optional status failure or disabled Agent View cannot veto a coordinator response", async () => {
  let calls = 0;
  const thread = { id: "source", startTyping: async () => { calls++; throw new Error("start unavailable"); },
    adapter: { endTyping: async () => { calls++; throw new Error("end unavailable"); } } };
  assert.equal(await withSlackAgentWorking(thread as any, { ...coordinatorConfiguration, enabled: false }, async () => "ok"), "ok");
  assert.equal(calls, 0);
  assert.equal(await withSlackAgentWorking(thread as any, coordinatorConfiguration, async () => "ok"), "ok");
  assert.equal(calls, 2);
  const failure = new Error("model failed");
  await assert.rejects(withSlackAgentWorking(thread as any, coordinatorConfiguration, async () => { throw failure; }), error => error === failure);
});

test("coordinator layout repair preserves code, literal paths and already-correct Markdown", () => {
  const literal = "Code: `\\n\\n` and C:\\new\\notes\\file.txt\n\n```json\n{\"text\":\"\\n\\n\"}\n```\n\n[Continue](https://example.com/thread)";
  assert.deepEqual(coordinatorSlackMessage(literal), { markdown: literal });
  assert.equal(coordinatorSlackMessage(String.raw`Intro.\r\n\r\n1. One\r\n2. Two`).markdown, "Intro.\n\n1. One\n2. Two");
});

test('specialist turns finish after tool-owned delivery, missing-input questions and terminal failures', async () => {
  for (const outcome of ['workflow-copy', 'needs-input', 'review', 'failure', 'cancelled']) {
    const events: string[] = [];
    const adapter = { endTyping: async (_id: string, status?: string) => { events.push(status!); } };
    const thread = { id: 'specialist-thread', adapter, startTyping: async () => { events.push('processing'); } };
    const operation = withSlackAgentWorking(thread as any, coordinatorConfiguration, async finish => {
      if (outcome === 'failure' || outcome === 'cancelled') throw new Error(outcome);
      if (outcome === 'review') await finish('suspended');
      return { visibleResponse: outcome === 'needs-input' ? 'What did you learn?' : '' };
    });
    if (outcome === 'failure' || outcome === 'cancelled') await assert.rejects(operation);
    else await operation;
    assert.deepEqual(events, ['processing', outcome === 'review' ? 'suspended' : 'active']);
  }
});
