import type { StateAdapter } from "chat";
import type { CompanyOSArtifact } from "../../../companyos-builder/types.ts";
import {
  routeMondayAgentCallback,
  type MondayAgentTrigger,
  type MondayReplayStore,
} from "../../../connectors/monday/webhook.ts";
import { sha256 } from "../../../runtime/canonical.ts";
import { loadArtifact } from "./artifact.ts";
import { createPostgresChatState } from "./postgres-chat-state.ts";
import { setupVerificationResponse } from "./setup-verification.ts";

const MAX_CALLBACK_BYTES = 1024 * 1024;
const MONDAY_IDENTITY_UNAVAILABLE = "Oregano is connected to monday.com. This callback does not identify the person who sent the message, so CompanyOS did not open company material, invoke a model, or run any Tools. Use an authenticated CompanyOS surface for interactive questions.";

export interface MondayAgentWebhookDependencies {
  artifact: CompanyOSArtifact;
  accountId: string;
  expectedAgentId: string;
  signingSecret: string;
  replayStore: MondayReplayStore;
  now?: () => number;
}

export class StateAdapterMondayReplayStore implements MondayReplayStore {
  private readonly state: Pick<StateAdapter, "setIfNotExists">;
  private readonly now: () => number;

  constructor(
    state: Pick<StateAdapter, "setIfNotExists">,
    now: () => number = Date.now,
  ) {
    this.state = state;
    this.now = now;
  }

  async claim(key: string, expiresAt: string): Promise<boolean> {
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry)) throw new Error("Monday callback replay expiry is invalid");
    const ttlMs = Math.max(1, expiry - this.now());
    return await this.state.setIfNotExists(
      `monday:callback-replay:${sha256(key)}`,
      { claimedAt: new Date(this.now()).toISOString() },
      ttlMs,
    );
  }
}

function mondayResponse(message: string, stream: boolean): Response {
  if (!stream) return Response.json({ message });
  const body = message
    ? `data: ${JSON.stringify({ type: "text", content: message })}\n\ndata: [DONE]\n\n`
    : "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/event-stream; charset=utf-8",
    },
  });
}

function headerRecord(request: Request): Record<string, string | undefined> {
  return {
    "x-monday-agent-id": request.headers.get("x-monday-agent-id") ?? undefined,
    "x-monday-signature": request.headers.get("x-monday-signature") ?? undefined,
    "x-monday-timestamp": request.headers.get("x-monday-timestamp") ?? undefined,
  };
}

function invalidDelivery(error: unknown): Response {
  const message = error instanceof Error ? error.message : "unknown Monday callback error";
  const status = /replay/i.test(message)
    ? 409
    : /signature|Agent identity|missing 'x-monday/i.test(message)
      ? 401
      : 400;
  return Response.json({ ok: false, error: "invalid-delivery", errorDigest: sha256(message).slice(0, 16) }, { status });
}

export async function handleMondayAgentWebhook(
  request: Request,
  dependencies: MondayAgentWebhookDependencies,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  }
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_CALLBACK_BYTES) {
    return Response.json({ ok: false, error: "delivery-too-large" }, { status: 413 });
  }
  try {
    const routed = await routeMondayAgentCallback({
      rawBody,
      headers: headerRecord(request),
      signingSecret: dependencies.signingSecret,
      expectedAgentId: dependencies.expectedAgentId,
      now: (dependencies.now ?? Date.now)(),
      replayStore: dependencies.replayStore,
      accountId: dependencies.accountId,
      routing: dependencies.artifact.agentRouting,
      agentIds: dependencies.artifact.agents.map((agent) => agent.id),
    });
    const agent = dependencies.artifact.agents.find((candidate) => candidate.id === routed.resolution.agentId);
    if (!agent) throw new Error("Monday callback resolved an unavailable Agent");
    return responseForTrigger(routed.trigger);
  } catch (error) {
    return invalidDelivery(error);
  }
}

function responseForTrigger(trigger: MondayAgentTrigger): Response {
  if (trigger.triggerType !== "chat") return mondayResponse("", trigger.stream);
  const setupProof = setupVerificationResponse(trigger.text);
  return mondayResponse(setupProof ?? MONDAY_IDENTITY_UNAVAILABLE, trigger.stream);
}

const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

let configuredDependencies: MondayAgentWebhookDependencies | undefined;

function getConfiguredDependencies(): MondayAgentWebhookDependencies {
  if (configuredDependencies) return configuredDependencies;
  const state = createPostgresChatState();
  configuredDependencies = {
    artifact: loadArtifact(),
    accountId: requireEnv("MONDAY_ACCOUNT_ID"),
    expectedAgentId: requireEnv("MONDAY_AGENT_ID"),
    signingSecret: requireEnv("MONDAY_SIGNING_SECRET"),
    replayStore: new StateAdapterMondayReplayStore(state),
  };
  return configuredDependencies;
}

export async function handleConfiguredMondayAgentWebhook(request: Request): Promise<Response> {
  try {
    return await handleMondayAgentWebhook(request, getConfiguredDependencies());
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown Monday runtime error";
    return Response.json({ ok: false, error: "webhook-unavailable", errorDigest: sha256(message).slice(0, 16) }, { status: 503 });
  }
}
