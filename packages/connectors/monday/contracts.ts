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

export interface MondayBoardDiscovery {
  id: string;
  name: string;
  boardKind: string;
  state: string;
  permissions: string;
  workspace: { id: string; name: string } | null;
  groups: Array<{
    id: string;
    title: string;
    archived: boolean;
    deleted: boolean;
  }>;
  columns: Array<{
    id: string;
    title: string;
    type: string;
    archived: boolean;
    revision: string | null;
    settings: string | null;
  }>;
}

export interface MondayResourceDiscovery {
  actor: { id: string; name: string };
  account: { id: string; name: string };
  boards: MondayBoardDiscovery[];
}

export interface MondayAgentResourceDiscovery {
  identity: {
    memberId: string;
    name: string;
    kind: string;
    email: string;
    externalAgentId: string | null;
  };
  account: { id: string; name: string };
  resources: Array<{
    resourceId: string;
    scopeType: string;
    permissionType: string;
  }>;
  boards: MondayBoardDiscovery[];
}

export interface MondayRecordObject {
  id: string;
  name: string;
  updated_at: string;
  board_id: string;
  group_id: string;
  columns: Record<string, JsonValue>;
  column_text: Record<string, string>;
}

export interface MondayRecordInventory {
  boardId: string;
  objects: MondayRecordObject[];
  requestIds: string[];
  reportedApiVersions: string[];
  pageCount: number;
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
