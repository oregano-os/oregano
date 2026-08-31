import type { JsonValue } from "../../capabilities/contracts.ts";

export interface MondayResourceBinding {
  id: string;
  boardId: string;
  permission: "read" | "read-write";
  fields: Record<string, string>;
}

export interface MondayWorkItem {
  id: string;
  title: string;
  boardId: string;
  groupId: string;
  providerVersion: string;
  fields: Record<string, JsonValue>;
}

export interface MondayGraphqlResponse<T> {
  data: T;
  apiVersion: string | null;
  requestId: string | null;
}

export interface MondayEchoReceipt {
  instanceId: string;
  resourceBinding: string;
  workItemId: string;
  providerVersion: string;
  actorId: string;
  idempotencyKey: string;
  expiresAt: string;
}

export interface MondayEchoStore {
  remember(receipt: MondayEchoReceipt): Promise<void>;
  consumeMatch(args: { instanceId: string; resourceBinding: string; workItemId: string; providerVersion: string; actorId: string; now: string }): Promise<MondayEchoReceipt | undefined>;
}
