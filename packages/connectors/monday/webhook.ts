import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveAgent, type AgentResolution, type CompiledAgentRouting } from "../../runtime/agent-resolver.ts";
import type { MondayEchoReceipt, MondayEchoStore } from "./contracts.ts";

export interface MondayReplayStore {
  claim(key: string, expiresAt: string): Promise<boolean>;
}

export class InMemoryMondayReplayStore implements MondayReplayStore {
  readonly claims = new Map<string, string>();
  async claim(key: string, expiresAt: string): Promise<boolean> {
    if (this.claims.has(key)) return false;
    this.claims.set(key, expiresAt);
    return true;
  }
}

export interface MondayAgentTrigger {
  event: "agent_triggered";
  triggerType: "chat" | "mention" | "assigned";
  payload: Record<string, unknown>;
  agentId: string;
  routeChannelId: string;
}

const header = (headers: Record<string, string | undefined>, name: string): string => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (!value) throw new Error(`Monday callback is missing '${name}'`);
  return value;
};

export async function verifyMondayAgentCallback(args: {
  rawBody: string;
  headers: Record<string, string | undefined>;
  signingSecret: string;
  now: number;
  replayStore: MondayReplayStore;
  maxSkewMs?: number;
}): Promise<{ agentId: string; timestamp: string }> {
  const agentId = header(args.headers, "x-monday-agent-id");
  const timestamp = header(args.headers, "x-monday-timestamp");
  const supplied = header(args.headers, "x-monday-signature");
  if (!/^\d{13}$/.test(timestamp)) throw new Error("Monday callback timestamp is invalid");
  if (Math.abs(args.now - Number(timestamp)) > (args.maxSkewMs ?? 5 * 60_000)) throw new Error("Monday callback timestamp is outside the accepted window");
  const expected = `sha256=${createHmac("sha256", args.signingSecret).update(`${timestamp}.${args.rawBody}`).digest("hex")}`;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error("Monday callback signature is invalid");
  const replayKey = `${agentId}:${timestamp}:${supplied}`;
  if (!await args.replayStore.claim(replayKey, new Date(args.now + (args.maxSkewMs ?? 5 * 60_000)).toISOString())) throw new Error("Monday callback replay was rejected");
  return { agentId, timestamp };
}

export function parseMondayAgentTrigger(rawBody: string, agentId: string): MondayAgentTrigger {
  let value: any;
  try { value = JSON.parse(rawBody); }
  catch { throw new Error("Monday callback body is not valid JSON"); }
  if (value?.event !== "agent_triggered") throw new Error("Monday callback event is unsupported");
  if (!["chat", "mention", "assigned"].includes(value.triggerType)) throw new Error("Monday callback trigger type is unsupported");
  if (!value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) throw new Error("Monday callback payload must be an object");
  const boardId = value.payload.boardId ?? value.payload.board_id;
  const routeChannelId = boardId ? `board:${String(boardId)}` : `agent:${agentId}`;
  return { event: "agent_triggered", triggerType: value.triggerType, payload: value.payload, agentId, routeChannelId };
}

export async function routeMondayAgentCallback(args: {
  rawBody: string;
  headers: Record<string, string | undefined>;
  signingSecret: string;
  now: number;
  replayStore: MondayReplayStore;
  accountId: string;
  routing: CompiledAgentRouting;
  agentIds: string[];
}): Promise<{ trigger: MondayAgentTrigger; resolution: AgentResolution }> {
  const verified = await verifyMondayAgentCallback(args);
  const trigger = parseMondayAgentTrigger(args.rawBody, verified.agentId);
  const resolution = resolveAgent(args.routing, args.agentIds, { surface: "monday", accountId: args.accountId, channelId: trigger.routeChannelId });
  return { trigger, resolution };
}

/** Board-change events are normalized for domains and deliberately bypass conversational Agent routing. */
export function normalizeMondayBoardEvent(value: unknown): { eventId: string; boardId: string; workItemId: string; actorId: string; providerVersion: string } {
  if (!value || typeof value !== "object") throw new Error("Monday board event must be an object");
  const event = value as Record<string, unknown>;
  for (const field of ["eventId", "boardId", "workItemId", "actorId", "providerVersion"]) if (!event[field]) throw new Error(`Monday board event is missing '${field}'`);
  return { eventId: String(event.eventId), boardId: String(event.boardId), workItemId: String(event.workItemId), actorId: String(event.actorId), providerVersion: String(event.providerVersion) };
}

export async function classifyMondayBoardEventEcho(args: {
  value: unknown;
  instanceId: string;
  resourceBinding: string;
  now: string;
  echoStore: MondayEchoStore;
}): Promise<{ event: ReturnType<typeof normalizeMondayBoardEvent>; suppressed: boolean; receipt?: MondayEchoReceipt }> {
  const event = normalizeMondayBoardEvent(args.value);
  const receipt = await args.echoStore.consumeMatch({
    instanceId: args.instanceId,
    resourceBinding: args.resourceBinding,
    workItemId: event.workItemId,
    providerVersion: event.providerVersion,
    actorId: event.actorId,
    now: args.now,
  });
  return { event, suppressed: Boolean(receipt), ...(receipt ? { receipt } : {}) };
}
