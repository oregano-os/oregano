#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const VERSION = "1.6.2";
if (process.argv.includes("--version")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const sessions = new Map();

const app = acp
  .agent({ name: "companyos-builder-test-agent" })
  .onRequest(acp.methods.agent.initialize, ({ params }) => ({
    protocolVersion: params.protocolVersion,
    agentInfo: { name: "companyos-builder-test-agent", version: VERSION },
    agentCapabilities: { loadSession: false },
  }))
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    const sessionId = randomUUID();
    sessions.set(sessionId, { cwd: params.cwd, controller: undefined, mode: "read-only" });
    return {
      sessionId,
      modes: {
        currentModeId: "read-only",
        availableModes: [
          { id: "read-only", name: "Read-only" },
          { id: "agent", name: "Agent" },
        ],
      },
      configOptions: [{
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "fake-model-v1",
        options: [{ value: "fake-model-v1", name: "Fake Model v1" }],
      }],
    };
  })
  .onRequest(acp.methods.agent.session.setMode, ({ params }) => {
    const session = sessions.get(params.sessionId);
    if (!session || params.modeId !== "agent") throw new Error("Unsupported test session mode.");
    session.mode = params.modeId;
    return {};
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown test session '${params.sessionId}'.`);
    const controller = new AbortController();
    session.controller = controller;
    const prompt = params.prompt
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "fixture-started" },
      },
    });

    if (prompt.includes("crash-after-prompt")) {
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => undefined);
    }

    if (prompt.includes("hang-until-cancelled")) {
      await new Promise((resolve) => controller.signal.addEventListener("abort", resolve, { once: true }));
      return { stopReason: "cancelled" };
    }
    if (prompt.includes("omit-usage")) return { stopReason: "end_turn" };

    const target = join(session.cwd, "fixture.txt");
    const genericExecute = prompt.includes("generic-execute");
    const toolKind = genericExecute ? "execute" : "edit";
    const locations = genericExecute ? undefined : [{ path: target }];
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "write-fixture",
        title: "Write fixture",
        kind: toolKind,
        status: "pending",
        locations,
      },
    });
    const permission = await client.request(acp.methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: "write-fixture",
        title: "Write fixture",
        kind: toolKind,
        status: "pending",
        locations,
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    const allowed = session.mode === "agent"
      && permission.outcome.outcome === "selected"
      && permission.outcome.optionId === "allow-once";
    if (allowed) await writeFile(target, "changed-by-fake-acp-agent\n", "utf8");
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "write-fixture",
        status: allowed ? "completed" : "failed",
      },
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "usage_update",
        used: 18,
        size: 200_000,
        ...(prompt.includes("omit-cost") ? {} : { cost: { amount: 0.00042, currency: "USD" } }),
      },
    });
    return {
      stopReason: "end_turn",
      usage: {
        totalTokens: 18,
        inputTokens: 10,
        outputTokens: 4,
        cachedReadTokens: 4,
        cachedWriteTokens: 0,
      },
    };
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    sessions.get(params.sessionId)?.controller?.abort();
  });

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);
app.connect(stream);
